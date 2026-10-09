import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logMetric } from "../shared/core/structured-log.js";

/**
 * SCL-3: OTel + cost ledger — lightweight tracing facade.
 *
 * Provides OTel-compatible spans keyed by runId without forcing the full
 * OTel SDK as a hard dependency. When `OTEL_ENABLED=true`, the SDK is dynamically
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
// ponytail: store caps stay local (spans/run vs runs); API row limits use cost-ledger one limit.
const traceStore = new Map<string, TraceSpan[]>();
const spanById = new Map<string, TraceSpan>();
const MAX_SPANS_PER_RUN = 500;
const MAX_RUNS = 1000;
// OBS-001: spanById had no eviction (traceStore is bounded, this was not).
// Cap at 10k entries, oldest-first; run-bucket eviction also drops its ids.
const MAX_SPAN_IDS = 10000;

function isOtelEnabled(): boolean {
  return String(process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
}

function genId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function genTraceId(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 16);
}

// OBS-011: stored snapshots must not alias the live attribute object.
function cloneAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(attributes);
  } catch {
    return { ...attributes };
  }
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
  // OBS-001: bound the live-span registry.
  while (spanById.size > MAX_SPAN_IDS) {
    const oldest = spanById.keys().next().value as string | undefined;
    if (!oldest) break;
    spanById.delete(oldest);
  }

  // OTel SDK path (best-effort dynamic import, no hard dep)
  if (isOtelEnabled()) {
    // OBS-002: endSpan may run before the dynamic import resolves; keep the
    // pending promise so a fast span is still closed once attach lands.
    const pending = (async () => {
      try {
        // OBS-002 test seam: tests may inject a loader on globalThis;
        // production falls back to the optional peer dep.
        const loader = (globalThis as unknown as Record<string, unknown>).__OBS_OTEL_LOADER__ as
          | (() => Promise<unknown>)
          | undefined;
        // @ts-ignore optional peer dep
        const otel: any = await (loader ? loader() : import("@opentelemetry/api")).catch(() => null);
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
    (span as unknown as Record<string, unknown>).__otelPending = pending;
  }

  return span;
}

export function endSpan(span: TraceSpan, opts: { error?: unknown; attributes?: Record<string, unknown> } = {}): TraceSpan {
  // OBS-009: idempotent end. A double-end used to duplicate the stored span
  // and emit a second metric; the second call now returns the span untouched.
  if ((span as unknown as Record<string, unknown>).__ended) return span;
  (span as unknown as Record<string, unknown>).__ended = true;
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

  // Store for reconstruction — runId only; no synthetic __global bucket (budget ledger owns __global).
  // OBS-002: fast spans end before the dynamic import resolves; close once the
  // pending attach lands. Run-less spans close here too (the early return
  // below used to skip the sidecar entirely).
  const otelRec = span as unknown as Record<string, unknown>;
  const closeOtel = () => {
    const otelSpan = otelRec.__otelSpan as any;
    if (!otelSpan) return;
    try {
      if (span.status === "error") otelSpan.setStatus?.({ code: 2, message: span.errorMessage });
      otelSpan.end?.();
    } catch {}
  };
  const closeOrPend = () => {
    if (otelRec.__otelSpan) closeOtel();
    else {
      const pending = otelRec.__otelPending as Promise<unknown> | undefined;
      if (pending) void pending.then(closeOtel, () => {});
    }
  };
  if (!span.runId) { closeOrPend(); return span; }
  let arr = traceStore.get(span.runId);
  if (!arr) {
    if (traceStore.size >= MAX_RUNS) {
      // OBS-010: evict the least-recently-written bucket; Map order tracks
      // recency because every write re-inserts its bucket below.
      const lruKey = traceStore.keys().next().value as string | undefined;
      if (lruKey) traceStore.delete(lruKey);
    }
    arr = [];
  } else {
    // OBS-010: re-insert on every write so a still-active run bucket is never
    // the eviction victim while it keeps receiving spans.
    traceStore.delete(span.runId);
  }
  traceStore.set(span.runId, arr);
  if (arr.length >= MAX_SPANS_PER_RUN) arr.shift();
  // OBS-011: deep-copied attributes — post-end mutation of the live span must
  // not rewrite stored history.
  arr.push({ ...span, attributes: cloneAttributes(span.attributes) });

  // Close OTel span if present (OBS-002: covers the pending fast-span attach).
  closeOrPend();

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
  // OBS-008: newest-first. Was insertion (oldest-first) order, so limit
  // returned the stalest runs while the route documents recent traces.
  const entries = [...traceStore.entries()];
  const out = entries
    .map(([runId, spans]) => ({ runId, spans: [...spans] }))
    .reverse()
    .slice(0, Math.max(1, limit));
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
