import type { FastifyInstance } from "fastify";

import { getMetricsSnapshot } from "../shared/core/perf-metrics.js";
import { observabilityGate } from "../observability/observability-gate.js";
import { eventsGate } from "../events/events-gate.js";

/**
 * OBS-1: GET /metrics — perfMetrics latency snapshot (p50/p95 per stage).
 * Flag: METRICS_ENABLED=false disables the route entirely (rollback switch);
 * default is enabled. Local-first: loopback is the trust boundary (single user).
 */
export async function metricsRoutes(app: FastifyInstance) {
  if (process.env.METRICS_ENABLED === "false") return;

  app.get("/metrics", async () => {
    const traceStats = (() => {
      try { return observabilityGate.getTraceStats(); } catch { return null; }
    })();
    // EVT-08: event-log counters (appended/skipped/failed) for alerting.
    const eventLog = (() => {
      try { return eventsGate.stats; } catch { return null; }
    })();
    return { metrics: getMetricsSnapshot(), traces: traceStats, eventLog };
  });

  // Alias under /api for client parity (frontend fetches /api/metrics via proxy)
  app.get("/api/metrics", async () => {
    const traceStats = (() => {
      try { return observabilityGate.getTraceStats(); } catch { return null; }
    })();
    const eventLog = (() => {
      try { return eventsGate.stats; } catch { return null; }
    })();
    return { metrics: getMetricsSnapshot(), traces: traceStats, eventLog };
  });
}
