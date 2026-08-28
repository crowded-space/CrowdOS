import { ProviderAbortError, ProviderTimeoutError, type ProviderTimeoutPhase } from './providerErrors.js';
import { getProviderDispatcher } from '../../Shared/core/httpAgent.js';

export const DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 120_000;

export interface ProviderTimeoutConfig {
  /** Max wait for response headers. 0 disables (infinite). */
  connectTimeoutMs: number;
  /** Max gap between stream chunks (or for one whole non-streaming body read). 0 disables (infinite). */
  idleTimeoutMs: number;
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getProviderTimeoutConfig(): ProviderTimeoutConfig {
  return {
    connectTimeoutMs: parseTimeoutMs(process.env.PROVIDER_CONNECT_TIMEOUT_MS, DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS),
    idleTimeoutMs: parseTimeoutMs(process.env.PROVIDER_IDLE_TIMEOUT_MS, DEFAULT_PROVIDER_IDLE_TIMEOUT_MS),
  };
}

/**
 * Composes a caller-supplied abort signal with connect/idle watchdog timers into
 * one abortable deadline. The composed signal is what gets handed to fetch, so
 * an abort (caller OR watchdog) actually cancels the underlying request/stream.
 */
class ProviderDeadline {
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly callerSignal?: AbortSignal;
  private readonly provider?: string;
  private readonly config: ProviderTimeoutConfig;
  private callerListener?: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activePhase: ProviderTimeoutPhase | null = null;
  private abortReason: unknown;

  constructor(callerSignal: AbortSignal | undefined, provider: string | undefined, config: ProviderTimeoutConfig) {
    this.callerSignal = callerSignal;
    this.provider = provider;
    this.config = config;
    this.signal = this.controller.signal;

    if (callerSignal?.aborted) {
      this.abortForCaller();
    } else if (callerSignal) {
      this.callerListener = () => this.abortForCaller();
      callerSignal.addEventListener('abort', this.callerListener, { once: true });
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private startTimer(phase: ProviderTimeoutPhase): void {
    this.clearTimer();
    this.activePhase = phase;
    const timeoutMs = phase === 'connect' ? this.config.connectTimeoutMs : this.config.idleTimeoutMs;
    if (!(timeoutMs > 0)) return;
    this.timer = setTimeout(() => {
      const failure = new ProviderTimeoutError(phase, timeoutMs, this.provider);
      this.abortReason = failure;
      try {
        this.controller.abort(failure);
      } catch {
        // abort cannot throw here; guarded for exotic signal polyfills
      }
    }, timeoutMs);
  }

  private abortForCaller(): void {
    if (this.signal.aborted) return;
    this.clearTimer();
    this.activePhase = null;
    const failure = new ProviderAbortError(
      `Provider call aborted by caller signal${this.provider ? ` (${this.provider})` : ''}.`,
      this.provider,
    );
    this.abortReason = failure;
    try {
      this.controller.abort(failure);
    } catch {
      // guarded as above
    }
  }

  armConnect(): void {
    this.startTimer('connect');
  }

  /** Headers arrived — hand the remaining budget to the idle watchdog. */
  beginBody(): void {
    this.startTimer('idle');
  }

  /** Called before every stream chunk read so slow-but-alive streams never trip the watchdog. */
  resetIdle(): void {
    if (this.activePhase === 'idle') this.startTimer('idle');
  }

  finish(): void {
    this.clearTimer();
    this.activePhase = null;
    if (this.callerListener && this.callerSignal) {
      this.callerSignal.removeEventListener('abort', this.callerListener);
      this.callerListener = undefined;
    }
  }

  /** Map an underlying rejection onto the typed provider error that caused it. */
  translateError(err: unknown): Error {
    if (this.abortReason !== undefined) {
      return this.abortReason instanceof Error ? this.abortReason : new Error(String(this.abortReason));
    }
    if (this.callerSignal?.aborted) {
      return new ProviderAbortError(
        `Provider call aborted by caller signal${this.provider ? ` (${this.provider})` : ''}.`,
        this.provider,
        err,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** A provider HTTP call whose headers/body are covered by the composed deadline. */
export class GuardedProviderCall {
  constructor(readonly response: Response, private readonly deadline: ProviderDeadline) {}

  async text(): Promise<string> {
    try {
      return await this.response.text();
    } catch (err) {
      throw this.deadline.translateError(err);
    } finally {
      this.deadline.finish();
    }
  }

  async json(): Promise<unknown> {
    try {
      return await this.response.json();
    } catch (err) {
      throw this.deadline.translateError(err);
    } finally {
      this.deadline.finish();
    }
  }

  /**
   * Iterate the response body with the idle watchdog resetting on every chunk.
   * Always releases timers, including on early break or thrown error. Reads are
   * raced against the composed signal so an abort interrupts a pending read
   * even when the underlying stream never errors on its own.
   */
  async *stream(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void, undefined> {
    const reader = body.getReader();
    try {
      for (;;) {
        this.deadline.resetIdle();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await this.readWithDeadline(reader);
        } catch (err) {
          throw this.deadline.translateError(err);
        }
        if (chunk.done) break;
        yield chunk.value;
      }
    } finally {
      this.deadline.finish();
    }
  }

  private readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    const signal = this.deadline.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      reader.read().then(
        (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  finish(): void {
    this.deadline.finish();
  }
}

export interface ProviderFetchContext {
  /** The runtime/run-level cancellation signal (composed with the watchdogs). */
  callerSignal?: AbortSignal;
  /** Adapter name used in typed error messages. */
  provider?: string;
}

export async function providerFetch(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  ctx: ProviderFetchContext,
): Promise<GuardedProviderCall> {
  const deadline = new ProviderDeadline(ctx.callerSignal, ctx.provider, getProviderTimeoutConfig());
  deadline.armConnect();

  let response: Response;
  try {
    // PERF-9: attach the shared keep-alive dispatcher when undici is available.
    // `dispatcher` and `signal` coexist on the same init — the CAN-1 composed
    // deadline still owns cancellation.
    const dispatcher = await getProviderDispatcher();
    const pooledInit = (dispatcher === undefined ? init : { ...init, dispatcher }) as RequestInit;
    response = await fetch(url, { ...pooledInit, signal: deadline.signal });
  } catch (err) {
    deadline.finish();
    throw deadline.translateError(err);
  }

  deadline.beginBody();
  return new GuardedProviderCall(response, deadline);
}
