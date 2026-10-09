# Tools Domain — Test gaps (Phase 4; gaps only, no new tests written)

## Baseline (exact commands + results)
- `npx vitest run src/tools` (cwd packages/server): 10 files — 1 failed | 9 passed; 111 tests — 1 failed | 110 passed; 35.20s. Failure: `tool-registry.flags.test.ts > QUERY_DATABASE_ENABLED=false unregisters query_database` — "Error: Test timed out in 5000ms" (file:17). Sibling test with same dynamic import passed (1148ms) → cold-import flake (TOLS-12).
- `node scripts/check-gates.mjs` (cwd packages/server): "Gate rule OK: scanned 361 files across 23 domains, 0 violations." 46 test-only findings; tools-related: approvals/approval-flow.integration.test.ts → ../tools/tool-executor.js, ../tools/tool-registry.js; channel-mounts/channel-mount-gate.test.ts → ../tools/tool-registry.js. 3 allowlisted pre-existing (not tools).
- `npx tsc -p tsconfig.json --noEmit`: NOT run (time-box). Low confidence on type-clean status.

## Gaps (no coverage found)
1. TOLS-01: no test pins execute_bash effective timeout (30s vs intended 300s).
2. TOLS-02: no test for timeout-vs-mutation race (FS handler completes after failure reported).
3. TOLS-03: no MCP breaker-threshold test (status flips but calls continue).
4. TOLS-04: no test asserts activeSchedules entry removal for BullMQ one-shot/cron; cancelSchedule untested.
5. TOLS-05: no persistence/restart test for mcp_servers (no runtime writer exists to test).
6. TOLS-06: no concurrent connect+disconnect race test.
7. TOLS-07: no cross-DB authz test (workspace DB agent + ambient DB skills).
8. TOLS-08: no test asserts executor fallback list == skill-service UNIVERSAL_TOOLS.
9. TOLS-09: EventBroker.on() return type / off(subId) contract untested for the approval fast path (approval-flow.integration.test.ts requires live PG and is skipped without DATABASE_URL — unverified in this run).
10. TOLS-11: search_all_channels null topicSummary unguarded, untested.
11. TOLS-14: inline cron clamp edge untested.
12. TOLS-15: registerServer with sse/http accepted then connect throws — untested at route level.
13. FS approval deny/expire via ToolExecutor (not just approvals domain): only bash path appears in tool tests; FS pending flow lacks direct tests here.
14. routes/tools.ts execute-test auth matrix (token set vs unset) untested in-domain.
15. read_file 1MB cap boundary (==, >, post-read truncation) not directly tested in this domain (read-workspace-local covers its own cap).
16. register() native-shadow refusal (MCP overwriting read_file without overwrite:true) not pinned by a dedicated test in the files read.
17. TOOL_RWP_MAX_READ_CONCURRENCY invalid values (0, negative, NaN) fallback untested (only ="1" tested).
18. stateless refusal for `lock_in`/`lock_out`? Not memory-write ids — by design; no test asserts they stay allowed for workers.

## Test-only gate bypasses to fix when touching those files
- approvals/approval-flow.integration.test.ts → import tool-executor.js / tool-registry.js via tools-gate (needs ToolExecutor re-export or executor accessor in gate; currently intentionally trimmed — resolve via test-local wrapper).
- channel-mounts/channel-mount-gate.test.ts → import resolveToolRoot from tools-gate.js (already gate-exported; trivial rewiring).
