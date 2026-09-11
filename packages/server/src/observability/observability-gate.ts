import { startSpan as _startSpan, endSpan as _endSpan, withSpan as _withSpan, withSpanSync as _withSpanSync, getTrace as _getTrace, getAllTraces as _getAllTraces, getTraceStats as _getTraceStats, clearTracesForTests as _clearTracesForTests } from "./tracing.js";
import type { TraceSpan, StartSpanOptions } from "./tracing.js";
import { getPerRunCostLedger as _getPerRunCostLedger, getPerRunRollup as _getPerRunRollup, rollupFromEntries as _rollupFromEntries, getCostDashboard as _getCostDashboard, verifyLedgerAccuracy as _verifyLedgerAccuracy, computeRowCostUsd as _computeRowCostUsd } from "./cost-ledger.js";
import type { CostLedgerEntry, PerRunCostRollup, CostDashboard } from "./cost-ledger.js";

export type { TraceSpan, StartSpanOptions, CostLedgerEntry, PerRunCostRollup, CostDashboard };

export const observabilityGate = {
  startSpan: _startSpan,
  endSpan: _endSpan,
  withSpan: _withSpan,
  withSpanSync: _withSpanSync,
  getTrace: _getTrace,
  getAllTraces: _getAllTraces,
  getTraceStats: _getTraceStats,
  clearTracesForTests: _clearTracesForTests,
  getPerRunCostLedger: _getPerRunCostLedger,
  getPerRunRollup: _getPerRunRollup,
  rollupFromEntries: _rollupFromEntries,
  getCostDashboard: _getCostDashboard,
  verifyLedgerAccuracy: _verifyLedgerAccuracy,
  computeRowCostUsd: _computeRowCostUsd,
};
