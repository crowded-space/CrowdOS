export class ProviderError extends Error {
  readonly provider?: string;

  constructor(message: string, provider?: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export type ProviderTimeoutPhase = 'connect' | 'idle';

export class ProviderTimeoutError extends ProviderError {
  readonly phase: ProviderTimeoutPhase;
  readonly timeoutMs: number;

  constructor(phase: ProviderTimeoutPhase, timeoutMs: number, provider?: string) {
    super(
      `[Provider${provider ? `:${provider}` : ''}] ${phase === 'connect' ? 'Connect' : 'Streaming idle'} timeout after ${timeoutMs}ms.`,
      provider,
    );
    this.name = 'ProviderTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export class ProviderAbortError extends ProviderError {
  constructor(message = 'Provider call aborted by caller signal.', provider?: string, cause?: unknown) {
    super(message, provider, cause);
    this.name = 'ProviderAbortError';
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}
