import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logMetric } from "../shared/core/structured-log.js";

/**
 * SCL-3: OTel + cost ledger — lightweight tracing facade.
 *
 * Provides OTel-compatible spans keyed by runId without forcing the full
 * OTel SDK as a hard dependency. When `OTEL_ENABLED=true` and
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, the SDK is dynamically
 * imported and used as the primary tracer; otherwise an in-memory store
 * backs trace reconstruction for tests and the `/observability` APIs.
 *
 * Span names follow Phase 7 convention: assemble, llm, tool, persist.
 */

export type SpanStatus = "ok" | "error";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  traceState?: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  attributes: Record<string, unknown>;
  status: SpanStatus;
  errorMessage?: string | null;
  runId?: string | null;
  channelId?: string | null;
  agentId?: string | null;
}

export interface StartSpanOptions {
  runId?: string | null;
  channelId?: string | null;
  agentId?: string | null;
  parentSpanId?: string | null;
  traceId?: string | null;
  attributes?: Record<string, unknown>;
}

// In-memory store: runId -> spans[]
const traceStore = new Map<string, TraceSpan[]>();
const spanById = new Map<string, TraceSpan>();
const MAX_SPANS_PER_RUN = 500;
const MAX_RUNS = 1000;

function isOtelEnabled(): boolean {
  return String(process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
}

function genId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function genTraceId(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 16);
}

export function startSpan(name: string, options: StartSpanOptions = {}): TraceSpan {
  const spanId = genId();
  const traceId = options.traceId ?? (options.parentSpanId ? spanById.get(options.parentSpanId)?.traceId ?? genTraceId() : genTraceId());
  const span: TraceSpan = {
    traceId,
    spanId,
    parentSpanId: options.parentSpanId ?? null,
    name,
    startTimeMs: performance.now(),
    attributes: { ...(options.attributes ?? {}) },
    status: "ok",
    runId: options.runId ?? null,
    channelId: options.channelId ?? null,
    agentId: options.agentId ?? null,
  };
  spanById.set(spanId, span);

  // OTel SDK path (best-effort dynamic import, no hard dep)
  if (isOtelEnabled()) {
    void (async () => {
      try {
        // @ts-ignore optional peer dep
        const otel: any = await import("@opentelemetry/api").catch(() => null);
        if (!otel) return;
        const tracer = otel.trace?.getTracer?.("crowdos");
        if (!tracer) return;
        // Create OTel span as side-effect; lifecycle is managed in-memory for persistence
        const otelSpan = tracer.startSpan(name, {
          attributes: {
            "run.id": options.runId ?? undefined,
            "channel.id": options.channelId ?? undefined,
            "agent.id": options.agentId ?? undefined,
            ...(options.attributes ?? {}),
          },
        });
        // Attach for later end
        (span as unknown as Record<string, unknown>).__otelSpan = otelSpan;
      } catch {}
    })();
  }

  return span;
}

export function endSpan(span: TraceSpan, opts: { error?: unknown; attributes?: Record<string, unknown> } = {}): TraceSpan {
  span.endTimeMs = performance.now();
  span.durationMs = Math.round((span.endTimeMs - span.startTimeMs) * 10) / 10;
  if (opts.attributes) Object.assign(span.attributes, opts.attributes);
  if (opts.error) {
    span.status = "error";
    span.errorMessage = opts.error instanceof Error ? opts.error.message : String(opts.error);
    span.attributes["error.message"] = span.errorMessage;
  }
  // Emit metric log for persistence observability
  logMetric({
    stage: `trace.${span.name}`,
    runId: span.runId ?? undefined,
    channelId: span.channelId ?? undefined,
    agentId: span.agentId ?? undefined,
    spanId: span.spanId,
    traceId: span.traceId,
    durationMs: span.durationMs,
    status: span.status,
    ...span.attributes,
  } as unknown as Parameters<typeof logMetric>[0]);

  // Store for reconstruction
  if (span.runId) {
    let arr = traceStore.get(span.runId);
    if (!arr) {
      if (traceStore.size >= MAX_RUNS) {
        const firstKey = traceStore.keys().next().value as string | undefined;
        if (firstKey) traceStore.delete(firstKey);
      }
      arr = [];
      traceStore.set(span.runId, arr);
    }
    if (arr.length >= MAX_SPANS_PER_RUN) arr.shift();
    arr.push({ ...span });
  } else {
    // also store under synthetic key for global queries
    const globalKey = "__global";
    let arr = traceStore.get(globalKey);
    if (!arr) { arr = []; traceStore.set(globalKey, arr); }
    if (arr.length >= MAX_SPANS_PER_RUN) arr.shift();
    arr.push({ ...span });
  }

  // Close OTel span if present
  const otelSpan = (span as unknown as Record<string, unknown>).__otelSpan as any;
  if (otelSpan) {
    try {
      if (span.status === "error") otelSpan.setStatus?.({ code: 2, message: span.errorMessage });
      otelSpan.end?.();
    } catch {}
  }

  return span;
}

export async function withSpan<T>(
  name: string,
  options: StartSpanOptions,
  fn: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const span = startSpan(name, options);
  try {
    const result = await fn(span);
    endSpan(span);
    return result;
  } catch (err) {
    endSpan(span, { error: err });
    throw err;
  }
}

export function withSpanSync<T>(
  name: string,
  options: StartSpanOptions,
  fn: (span: TraceSpan) => T,
): T {
  const span = startSpan(name, options);
  try {
    const result = fn(span);
    endSpan(span);
    return result;
  } catch (err) {
    endSpan(span, { error: err });
    throw err;
  }
}

export function getTrace(runId: string): TraceSpan[] {
  return [...(traceStore.get(runId) ?? [])];
}

export function getAllTraces(limit = 100): Array<{ runId: string; spans: TraceSpan[] }> {
  const out: Array<{ runId: string; spans: TraceSpan[] }> = [];
  for (const [runId, spans] of traceStore) {
    if (runId === "__global") continue;
    out.push({ runId, spans: [...spans] });
    if (out.length >= limit) break;
  }
  return out;
}

export function getSpanById(spanId: string): TraceSpan | undefined {
  return spanById.get(spanId);
}

export function clearTracesForTests(): void {
  traceStore.clear();
  spanById.clear();
}

export function getTraceStats(): { totalRuns: number; totalSpans: number } {
  let totalSpans = 0;
  for (const spans of traceStore.values()) totalSpans += spans.length;
  return { totalRuns: traceStore.size, totalSpans };
}
