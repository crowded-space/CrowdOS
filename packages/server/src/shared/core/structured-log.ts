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

export interface WarnLogFields {
  stage: string;
  [key: string]: unknown;
}

/**
 * Structured warn sibling of logMetric (SH-005): same one-JSON-line +
 * redaction contract, emitted on console.warn with level "warn" so operators
 * can filter fail-open degradation without parsing every metric line.
 */
export function logWarn(fields: WarnLogFields): void {
  const safe = redactSecrets({
    ts: new Date().toISOString(),
    level: "warn",
    msg: "warn",
    ...fields,
  });
  console.warn(JSON.stringify(safe));
}
