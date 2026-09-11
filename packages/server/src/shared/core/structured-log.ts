import { redactSecrets } from "./redact.js";

/**
 * Dependency-free structured logging: one JSON line per event, passed through
 * the shared redaction helper before emission. OBS-1 replaces the legacy
 * prose perf lines with these records.
 */

export interface MetricLogFields {
  stage: string;
  durationMs?: number;
  [key: string]: unknown;
}

export function logMetric(fields: MetricLogFields): void {
  const safe = redactSecrets({
    ts: new Date().toISOString(),
    level: "info",
    msg: "metric",
    ...fields,
  });
  console.log(JSON.stringify(safe));
}
