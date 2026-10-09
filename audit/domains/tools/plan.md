# Tools Domain — Fix plan (incremental; READ-ONLY audit deliverable)

## Rewrite decision: INCREMENTAL (no rewrite)
The domain is cohesive (registry + executor + guard + MCP), facade is thin and accurate, no-throw contract and approval machinery are heavily commented and test-pinned, and all known defects are localized (timeout plumbing, FS abort awareness, MCP breaker/lifecycle, state leaks). A rewrite would re-open the security-critical Guard/executor approval paths with no test coverage gain. Fix forward in the listed order; no facade shape change required (TOLS-17 is a type-only tightening).

## Ordered fix plan
1. TOLS-01 bash timeout (files: tool-registry.ts execute_bash def; symbol: ToolDefinition.timeoutMs). Add `timeoutMs: 300000`. Compat: raises effective limit only; tests: new duration probe with short env-tunable command. Verify: run >30s no-op command succeeds; `npx vitest run src/tools`. DoD: docs Tools.md:40 matches code.
2. TOLS-02 FS abort (tool-registry.ts FS handlers). Pass `ctx.abortSignal` into fs calls (writeFile/readFile/unlink support signals) and check `aborted` before mutating. Compat: failure mode changes from "reported timeout, silent completion" to "aborted". Tests: race test with slow sink. Rollback: revert handler-level signal use (executor unchanged).
3. TOLS-03 breaker (mcp-client-manager.ts recordFailure). On threshold: killChild + cleanupTools + failPending; gate sendJsonRpc on status!=='error'. Tests: breaker test in mcp-client-manager.test.ts. Verify: `npx vitest run src/tools/mcp`.
4. TOLS-06 disconnect race (mcp-client-manager.ts connect/disconnect). Add session generation counter; connect task checks generation before registering tools/setting status; disconnect increments. Tests: concurrent connect/disconnect. Verify: mcp suite.
5. TOLS-04/TOLS-19 schedules lifecycle (tool-registry.ts). Delete activeSchedules entry on BullMQ completion path (or only track inline); remove dead cancelSchedule or re-export via gate with a route. Tests: honest.test.ts extension. Compat: additive.
6. TOLS-13 approval parity (tool-executor.ts). Extract shared `runApprovalPause()` used by bash+FS (createPending try/catch + wait metrics + transitions). Tests: approvals integration (requires PG; gate on DATABASE_URL). Rollback: keep old FS block behind a local function switch.
7. TOLS-08 universal list (Shared constant consumed by executor + skill-service). Tests: equality assertion. Verify: tsc + tools suite + skills suite.
8. TOLS-10/TOLS-09 (tool-executor.ts): clear hard-TTL timer in cleanup; verify EventBroker.on/off contract and fix unsubscribe. Tests: event-broker unit pin + wait-cleanup probe.
9. TOLS-07 (tool-executor.ts): thread the resolved workspace DB handle into allowlist resolution or document+assert single-DB. Decide with user (tenant semantics). Tests: cross-DB harness if pursued.
10. TOLS-05 mcp_servers (mcp-client-manager.ts / db): implement persistence (load at boot via route/manager init; write on register) OR drop table + document ephemerality. User decision required. Tests: restart simulation.
11. TOLS-11/TOLS-14/TOLS-15/TOLS-17 smalls: null-guard search summary; reject oversized inline intervals; validate transport at register; type executeBatch ctx. Tests: per-item unit tests.
12. TOLS-12 test flake: raise the flags test timeout (or warm the import in beforeAll). Verify: 3 consecutive `npx vitest run src/tools` green.

## Docs sync (per AGENTS.md §3/§6 — NOT performed, read-only audit)
When fixes land: update re-docs/Backend Docs/Domain Spec/Tools.md (bash timeout, breaker semantics, persistence decision, activeSchedules lifecycle, universal list) and Feature and Flow Spec/Tool registry, Guard and MCP.md; record TOLS-01/04/05/08 drift notes there.

## Migration / rollback
- No schema changes required for 1-4, 6-12 except TOLS-05 (user decision). All fixes behind existing flags where possible (TOLS-02 could be gated by env for rollback; TOOL_RWP precedent). No production edits made in this audit.

## Verify (per fix)
- `npx tsc -p tsconfig.json --noEmit` (packages/server)
- `npx vitest run src/tools` and affected domains
- `node scripts/check-gates.mjs`
- AGENTS.md §4: finish → checks → stop → ask user to review → ask `commit?` (main only, git-crow script for any push/pull).
