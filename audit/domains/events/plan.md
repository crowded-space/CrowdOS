# Events Domain — Audit Plan / Fix Plan (incremental; READ-ONLY audit, no edits performed)

## Architecture assessment (A–E)

A. **Shape & boundaries.** Clean single-domain shape: gate -> service -> store -> shared IO. No cycles, no gate-to-gate imports, 0 gate violations for Events. Only real boundary debt: the gate exports far more than outsiders use (EVT-01) and 3 test-only cross-domain imports (EVT-11).

B. **Correctness core.** The hard parts are right: bump-first seq, exclusive afterSeq, head-echo when caught up, torn-tail repair, best-effort append with counters, path-traversal sanitization, per-channel mutex across allocate+append. No confirmed data-loss bug in the happy path.

C. **Tenant/scope.** The weak seam. Write scope trusts payload.workspaceId before the authoritative channel lookup (EVT-02); read scope derives from channel id only and the route never asserts tenant (EVT-03). Both are masked by the loopback single-user model but are the first things to fix for any multi-workspace rigor. The memo (EVT-04) and sanitized-id collisions (EVT-15) compound routing/bleed risks.

D. **Durability/ops.** No retention (documented), O(n) reads (EVT-05), failures visible only in-process (EVT-08/EVT-10), counter-reset race window (EVT-06), single-process constraint (EVT-07, documented). These are acceptable for the declared desktop-local scope; each needs either a bound, a metric, or a written decision.

E. **Tests/docs.** Test depth is genuinely good for the store/route; the e2e wiring proof is currently RED (EVT-09) and docs drift on line refs (EVT-13). No tests were added here.

## Rewrite decision: NO full rewrite — prefer incremental

The log format, seq semantics, classification, and facade boundary are sound and match the domain spec; the risks are localized (scope resolution, memoization, read strategy, observability). A rewrite would re-litigate settled, documented semantics (bump-first gaps, no retention, pull-based replay) and risk the client cursor contract. Proceed with the ordered incremental plan below; each step is independently shippable and preserves the facade contract (eventsGate ports unchanged; additive only).

## Ordered fix plan

Step 0 — Make the baseline green (do first, unblocks everything)
- Files/symbols: packages/server/src/events/events-integration.test.ts:130 (runtimeGate.execute result status). Fix test setup to bind a model module for the default agent (or update seeding path). No production edit expected; confirm with a green run.
- IDs: EVT-09 / G-12. Tests: the existing integration test.
- Compat: none. Rollback: revert test-only change. Verify: npx vitest run src/events -> 20 passed. DoD: baseline green, hook-wiring proof enforced.

Step 1 — Tenant-correct write scope
- Files/symbols: event-log-service.ts recordBrokerEvent:84 — resolve workspace from the channel row/log FIRST; use payload.workspaceId only as cross-check; on mismatch either prefer channel scope (audit-log the mismatch) or skip+warn per decision.
- IDs: EVT-02 / G-01. Tests: new in-domain test (channel row ws-A + payload ws-B => line in ws-A; mismatch counted).
- Compat: records' workspaceId field may now differ from payload for buggy producers — intended. Migration: none (files untouched). Rollback: revert scope order.
- Verify: new test + existing §30 isolation tests green. DoD: write scope can no longer be steered by payload.

Step 2 — Tenant-asserted read (route)
- Files/symbols: routes/events.ts:39 — pass request.workspaceId through eventsGate.listRecent (3rd arg already exists in the service signature) and compare with resolved channel scope; return 404/403 on mismatch. Document loopback-only trust in the route comment if deferred.
- IDs: EVT-03 / G-02. Tests: route mismatch case.
- Compat: same 200 shape for legitimate callers; new failure status for cross-tenant reads. Rollback: revert route arg.
- Verify: route tests + events-route.test.ts all green. DoD: cross-workspace channel id cannot be read via HTTP.

Step 3 — Seq-floor re-validation (counter-reset race)
- Files/symbols: event-local-store.ts allocateEventSeq:96-116 — when the counter value is below the last-known head for the channel (or on counter-file mtime change), re-floor instead of trusting the one-shot memo.
- IDs: EVT-06 / G-03. Tests: counter reset mid-process test.
- Compat: only affects recovery behavior; seqs stay monotonic. Rollback: revert guard.
- Verify: new test + torn/append tests green. DoD: no duplicate seq after counter loss within a process.

Step 4 — Colliding-id safety
- Files/symbols: local-file.ts safeChannelFileId:389 (hash or escape instead of collapse) and/or event-local-store.ts listEventTail:166 — filter rows by row.channelId; key counters by the same canonical id used for the file.
- IDs: EVT-15 / G-04. Tests: collision test.
- Compat: filename scheme change needs a read fallback for existing files (try canonical, then legacy sanitized) or a documented one-time migration on first read. Rollback: keep legacy filename reader.
- Verify: collision test + hostile-id test green. DoD: distinct raw ids never share a file/seq space.

Step 5 — Read-path bound (perf)
- Files/symbols: event-local-store.ts listEventTail:166 — reverse tail read or index; plus a documented retention/size decision (spec Decisions update).
- IDs: EVT-05 / G-05. Tests: large-log bounded-read benchmark/test.
- Compat: same result shape. Rollback: revert read strategy. Verify: benchmark within bound; route tests green. DoD: read cost independent of total log size (or a bound declared).

Step 6 — Failure observability & recovery
- Files/symbols: event-log-service.ts:100-110 (counter + warn) — export eventLogStats through the observability metrics route; decide bounded retry vs accepted-loss (spec Decision). 
- IDs: EVT-08/EVT-10 / G-06, G-10. Tests: metrics surface + retry (if implemented).
- Compat: additive. Rollback: revert export. Verify: metrics test. DoD: append failure visible in /api/metrics and either retried or explicitly accepted in docs.

Step 7 — Facade tightening + docs sync
- Files/symbols: events-gate.ts:28-46 — trim to ports + types actually consumed (eventsGate.* + resets for tests); gate-shape test. Update re-docs/Backend Docs/Domain Spec/Events.md line refs (create-app.ts:344 -> :365) and add payload-workspaceId caveat; update Feature and Flow Spec if flow text changes. Route events-integration.test.ts imports through gates (EVT-11).
- IDs: EVT-01, EVT-13, EVT-11 / G-11, G-13. Tests: gate-shape test; gate script clean for events.
- Compat: gate shrink is a breaking change for any importer of surplus exports — verify none (grep) before removing. Rollback: restore re-exports.
- Verify: check-gates + tsc + vitest green. DoD: contract = ports used; docs match code.

Step 8 (decision-only) — Dedupe (EVT-12) and unknown-type policy (EVT-16): either implement bounded dedupe/runtime type validation or record the accepted-risk decision in the spec. No code required for audit close.

## Sequencing & gates
- Order rationale: green baseline -> tenant write -> tenant read -> seq integrity -> collision -> perf -> ops -> contract/docs.
- Every step: same-task docs update (AGENTS.md §6), checks (tsc + vitest + check-gates), then STOP for user live review; commit only on explicit user approval; main only, no branch.
- Facade compatibility: no step removes an eventsGate port; Step 7 may narrow unused exports only after a grep proves zero importers.

## Verification commands (re-run per step)
cd packages/server
npx tsc -p tsconfig.json --noEmit
npx vitest run src/events
node scripts/check-gates.mjs

## Audit status
- Phases 1–4 complete (read-only). No production edits, no branch, no commit. Only audit/ is new in git status.
- Docs noted, not performed (AGENTS.md §6 sync is part of the fix steps, not this audit).
