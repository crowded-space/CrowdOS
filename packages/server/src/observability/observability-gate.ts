import { startSpan as _startSpan, endSpan as _endSpan, withSpan as _withSpan, withSpanSync as _withSpanSync, getTrace as _getTrace, getAllTraces as _getAllTraces, getSpanById as _getSpanById, getTraceStats as _getTraceStats, clearTracesForTests as _clearTracesForTests } from "./tracing.js";
import type { TraceSpan, StartSpanOptions } from "./tracing.js";
import { getPerRunCostLedger as _getPerRunCostLedger, getPerRunRollup as _getPerRunRollup, rollupFromEntries as _rollupFromEntries, getCostDashboard as _getCostDashboard, verifyLedgerAccuracy as _verifyLedgerAccuracy, computeRowCostUsd as _computeRowCostUsd, clampObsLimit as _clampObsLimit, OBS_LIMIT_MAX as _OBS_LIMIT_MAX, OBS_LIMIT_DEFAULT as _OBS_LIMIT_DEFAULT } from "./cost-ledger.js";
import type { CostLedgerEntry, PerRunCostRollup, CostDashboard } from "./cost-ledger.js";

export type { TraceSpan, StartSpanOptions, CostLedgerEntry, PerRunCostRollup, CostDashboard };
export { _clampObsLimit as clampObsLimit, _OBS_LIMIT_MAX as OBS_LIMIT_MAX, _OBS_LIMIT_DEFAULT as OBS_LIMIT_DEFAULT };

export const observabilityGate = {
  startSpan: _startSpan,
  endSpan: _endSpan,
  withSpan: _withSpan,
  withSpanSync: _withSpanSync,
  getTrace: _getTrace,
  getAllTraces: _getAllTraces,
  getSpanById: _getSpanById,
  getTraceStats: _getTraceStats,
  clearTracesForTests: _clearTracesForTests,
  getPerRunCostLedger: _getPerRunCostLedger,
  getPerRunRollup: _getPerRunRollup,
  rollupFromEntries: _rollupFromEntries,
  getCostDashboard: _getCostDashboard,
  verifyLedgerAccuracy: _verifyLedgerAccuracy,
  computeRowCostUsd: _computeRowCostUsd,
  clampLimit: _clampObsLimit,
};
