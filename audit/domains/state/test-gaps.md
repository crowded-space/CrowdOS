# State Domain - Phase 4 Test Baseline and Gaps (read-only audit, 2026-10-06)

## Baseline (exact commands and results; no code modified to make tests pass)

All commands run from packages/server unless noted.

| Command | Result | Notes |
| --- | --- | --- |
| cmd /c "npx tsc -p tsconfig.json --noEmit && echo TSC_PASS" | TSC_PASS (exit 0, ~20s) | Run twice: once at audit start and again after the external XD-002 edit landed in state-gate.ts. Both green. No production file touched by this audit. |
| npx vitest run src/state | No test files found, exit 1 | The domain has zero tests. This is the whole in-domain baseline. |
| npx vitest run src/runs | 4 passed | 2 skipped files (integration suites need DATABASE_URL); 28 passed, 9 skipped tests. Covers the machine + repository mechanics the gate delegates to. |
| npx vitest run src/runs/run-state-machine.test.ts src/runs/apply-transition.test.ts src/runs/checkpoint.test.ts | 3 files passed, 24 tests passed, exit 0 | apply-transition.test.ts pins RUN-001 sticky errorCode and CAS retry at the repository layer (the layer the gate bypasses, STATE-003). |
| node scripts/check-gates.mjs (from packages/server) | 0 violations across 361 files / 23 domains; 46 test-only findings (none in state) | Boundary rules hold for this domain. |

Nothing in this domain has a passing or failing test of its own; all indirect coverage lives in runs/ suites and none of them exercise state-gate.ts.

## Gaps (report only - no new tests added)

### 1. Gate behavior pins (STATE-007)
- applyRunTransition emits exactly one run.status_changed when changed, with exact payload keys { runId, agentId, channelId, workspaceId, runtimeType, status, from, reason, errorCode } and the { channelId } room tag.
- Rejected transition (null) emits nothing and returns null unchanged.
- No-op ({ changed: false }) emits nothing and returns the result unchanged.
- Explicit broker is used when passed; shared-broker fallback is used when omitted; missing broker warns and still returns the outcome (persistence unaffected).
- Emit throw is swallowed (console.error) and the outcome still returns.

### 2. errorCode semantics through the gate (STATE-003)
- Mirror the RUN-001 repository tests at the gate boundary: reason-only hop through applyRunTransition preserves a stored errorCode; explicit null clears it. Current gate normalizes undefined to null and fails the first case.

### 3. Tenant threading (STATE-001 - fixed externally mid-audit)
- Regression pin still needed: two-DB harness, create run with workspaceId W (dual tier), walk a transition via the gate from an unbound scope; assert the row is found and updated. The fix (XD-002) landed during this audit with no test.

### 4. Emission completeness across writers (STATE-002)
- Per-writer event-count regression: tool-executor waiting_for_approval/running hops, approval-sweeper expiry, routes/approvals decision, socket approval resume, research-runtime child hops - each changed transition should produce exactly one run.status_changed (all fail today: zero events).
- Client-contract test: jobsByRun / runRuntimeByRun projections (packages/client/stores/crowdOsStore.ts:909, 1702) receive every status change; today approval waits and research child runs are invisible.

### 5. Payload parity (STATE-006)
- One test comparing payloads built by the three emitters (state-gate, runs-service.resumeRun, orphan-sweep.emitStatus) field-by-field; fails to compile/fail at runtime if a field is added to one only.

### 6. applyMessage decision (STATE-004)
- If kept: passthrough test (row + message:new via broker). If removed: import-graph test asserting no references remain and State.md Ports updated.

### 7. Executor integration (walk)
- Characterization: a rejected hop throws the 'refusing to execute with stale state' error (runtime-executor.ts:250-254) and the run is left in its prior state (no half-walk persistence beyond the last changed hop).

### 8. Harness notes
- No factory/DI seam in the gate; tests must vi.mock ../runs/runs-gate.js and ../messages/message-gate.js (pattern exists: apply-transition.test.ts vi.mock of shared/config/database.js) plus a fake EventBroker.
- Broker singleton: use event-broker resetSharedBrokerForTests() to isolate the fallback path.
- Keep tests in-domain (packages/server/src/state/*.test.ts) per AGENTS.md; cross-domain tests should go through gates.
