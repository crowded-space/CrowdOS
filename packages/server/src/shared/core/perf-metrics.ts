import { performance } from "node:perf_hooks";

import { logMetric } from "./structured-log.js";

/**
 * Lightweight in-process latency instrumentation (Phase 0 — measure before optimizing).
 * Records named stage timings and exposes p50/p90/p95/p99 summaries.
 * No external deps; overhead is one Map lookup + array push per record.
 */

const MAX_SAMPLES_PER_METRIC = 2048;

interface MetricSeries {
  samples: number[];
  count: number;
  totalMs: number;
}

const series = new Map<string, MetricSeries>();
let lastFlush = Date.now();
const FLUSH_INTERVAL_MS = 60_000;

function record(name: string, durationMs: number): void {
  let s = series.get(name);
  if (!s) {
    s = { samples: [], count: 0, totalMs: 0 };
    series.set(name, s);
  }
  if (s.samples.length >= MAX_SAMPLES_PER_METRIC) {
    s.samples.shift();
  }
  s.samples.push(durationMs);
  s.count++;
  s.totalMs += durationMs;

  maybeFlush();
}

export function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  return fn().then(
    (result) => {
      record(name, performance.now() - start);
      return result;
    },
    (err) => {
      record(`${name}:error`, performance.now() - start);
      throw err;
    },
  );
}

export function timeSync<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    record(name, performance.now() - start);
  }
}

export function recordTiming(name: string, durationMs: number): void {
  record(name, durationMs);
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function getMetricsSnapshot(): Record<string, { count: number; p50: number; p90: number; p95: number; p99: number; mean: number }> {
  const out: Record<string, { count: number; p50: number; p90: number; p95: number; p99: number; mean: number }> = {};
  for (const [name, s] of series) {
    out[name] = {
      count: s.count,
      p50: Math.round(percentile(s.samples, 50) * 10) / 10,
      p90: Math.round(percentile(s.samples, 90) * 10) / 10,
      p95: Math.round(percentile(s.samples, 95) * 10) / 10,
      p99: Math.round(percentile(s.samples, 99) * 10) / 10,
      mean: s.count > 0 ? Math.round((s.totalMs / s.count) * 10) / 10 : 0,
    };
  }
  return out;
}

function maybeFlush(): void {
  const now = Date.now();
  if (now - lastFlush < FLUSH_INTERVAL_MS) return;
  lastFlush = now;
  for (const [name, m] of Object.entries(getMetricsSnapshot())) {
    logMetric({
      stage: name,
      count: m.count,
      p50Ms: m.p50,
      p90Ms: m.p90,
      p95Ms: m.p95,
      p99Ms: m.p99,
      meanMs: m.mean,
    });
  }
}
