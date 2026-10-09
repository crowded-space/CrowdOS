# Tools Domain — Inventory (READ-ONLY audit, Phases 1–4, time-boxed)

Repo: C:/Users/Asus/Documents/GitHub/.ThisCrowd
Domain: packages/server/src/tools · Facade: tools-gate.ts · HEAD: 22bb8a0 (main, dirty pre-existing)

## Files
| File | Lines | Role |
|---|---|---|
| tools-gate.ts | 28 | Thin facade. Exports exactly: `toolRegistry`, `resolveToolRoot`, `Guard`, `type ToolDefinition`, `toolsGate` {get,has,list,register,unregister,resolveToolRoot,execute,executeBatch,connectMcp,disconnectMcp,getMcpStatus,listMcpStatuses,registerMcpServer} |
| tool-executor.ts | 828 | ToolExecutor: auth chain, approval pause flows, batch RWP scheduler, timeout/abort race |
| tool-registry.ts | 1405 | ToolRegistry + 19 native definitions (2 flag-gated), resolveToolRoot, activeSchedules, honestSchedulerEmit, SQL guards |
| tool-types.ts | 76 | ToolDefinition/ToolResult/ToolExecutionContext/ToolTimeoutError |
| mcp/mcp-client-manager.ts | 524 | McpClientManager: stdio sessions, JSON-RPC framing, registration, breaker, teardown |
| mcp/mcp-types.ts | 90 | Protocol pin 2024-11-05, framing/danger defaults, MCP types |
| safety/guard.ts | 497 | Guard: path containment/blacklist, command DENY/ASK/ALLOW, validateCommandPaths |
| safety/hardened-exec.ts | 169 | execHardened: shell runner, env allowlist, output caps, tree kill |
| definitions/ | .gitkeep | empty |

Tests: executor.timeout, open-detail-expansion, read-workspace-local, stateless-worker, tool-executor.batch, tool-registry.{bullmq,flags,honest}, mcp/mcp-client-manager, safety/guard (10 files, 111 tests).

## Exports (exact, tools-gate.ts:1-27)
- `export { toolRegistry, resolveToolRoot }` (from tool-registry), `export { Guard }` (from safety/guard), `export type { ToolDefinition }`.
- `toolsGate.*` one-line delegations to ToolExecutor / toolRegistry / resolveToolRoot / mcpClientManager. NOTE `executeBatch` ctx is typed `any` (tools-gate.ts:22).

## Caller → Facade → Service → Port → Adapter map
| Caller (file:line) | Facade port | Service | Cross-domain port (gate) | Adapter/effect |
|---|---|---|---|---|
| routes/tools.ts:16,39 | list/get | toolRegistry | — | memory Map |
| routes/tools.ts:68 | execute | ToolExecutor.execute | skills-gate.getResolvedToolsForAgent; approval-gate.*; runs-gate.*; memories-gate.* (handlers); queue-gate (handlers) | agents table (workspace DB preferred, tool-executor.ts:336-349); FS; shell; PG pool (query_database) |
| routes/mcp.ts:9,17,19,32,45 | listMcpStatuses/registerMcpServer/getMcpStatus/connectMcp/disconnectMcp | mcpClientManager | secret-box (encrypt/decrypt); toolRegistry.register | child_process.spawn |
| routes/studio.ts:71 | get | toolRegistry | skills-gate (upstream) | memory |
| runtime/runtimes/agentic-runtime.ts:189 | executeBatch | ToolExecutor.executeBatch | same as execute | same |
| runtime/bridges/pi-tool-bridge.ts:35,102,134 | execute/list | ToolExecutor/toolRegistry | same | same |
| runtime/kernel/middlewares/tool-schema-middleware.ts:91,109 | get | toolRegistry | — | memory |
| runtime/runtimes/coding-runtime.ts:28,221,301 | Guard (dynamic) | Guard.validatePath | Filesystem gate isInsideRoot | FS |
| runtime/runtimes/coding-runtime.ts:200+ | (bypass) own write_file/edit_file executors use Guard only | — | — | FS + runsGate + artifactsGate + globalBroker (see Bypasses) |
| runs/runs-service.ts:85 | Guard (dynamic) | validatePath | — | FS (undo) |
| skills/skill-service.ts:272 | has (dynamic) | toolRegistry | — | memory |
| capabilities/capability-service.ts:29,194,262 | get | toolRegistry | — | memory |

## Entry points
- REST: GET /api/tools, GET /api/tools/:name (no auth; maybeSend304), POST /api/tools/execute-test (admin only when WORKSPACE_ADMIN_TOKEN set; 10/min), MCP CRUD routes (unauthenticated, loopback-trusted by design).
- Runtime: agentic executeBatch; pi-bridge execute/list; middleware get; coding-runtime direct Guard; runs-service Guard (undo).
- Scheduler: BullMQ scheduler queue (worker in queue/scheduler-worker.ts) and inline timers.

## Persistence / tables / migrations
- No owned tables. Reads: agents (identity, tool-executor.ts:347), channel_settings + workspace_safety_settings (FS policy, tool-executor.ts:584-593), channel_index (search_all_channels), allowlisted agents/channels/messages/channel_index/token_usage_log (query_database).
- Writes into others' tables: messages (scheduler persist, tool-registry.ts:99, queue/scheduler-worker.ts:38), runs_compensation via runsGate, approvals rows via approvalGate (owned by Approvals).
- `mcp_servers` table: schema.ts:875, migration 0000_baseline.sql:224, bootstrap.ts:407, backfill-encrypt-secrets.ts:80-97 ONLY — no runtime reader/writer (memory-only sessions). Dead table.

## Events
- Emits: sandbox:updated (write/delete), approval.requested, approval.decided, message:new, scheduled:triggered.
- Listens: approval.decided (per-wait subscription, tool-executor.ts:137).

## Caches / in-memory state
- toolRegistry Map (global singleton), activeSchedules Map (tool-registry.ts:81), MCP sessions + connecting maps (mcp-client-manager.ts:154-157), Guard.existsCache + Guard.rootRealCache (5s TTL, 200 cap), skill-service resolvedToolsCache (external), tool-expansion-registry (shared).

## Flags
QUERY_DATABASE_ENABLED, SYSTEM_SCHEDULER_ENABLED, TOOL_RWP, TOOL_RWP_MAX_READ_CONCURRENCY, APPROVALS_ENABLED, APPROVAL_TTL_MS/APPROVAL_PENDING_TTL_MS, LEGACY_GUARD, WORKSPACE_DIR.

## Bypasses / boundary notes
- coding-runtime.ts:210-284/286+ forks write_file/edit_file outside ToolExecutor (Guard-only path validation, own compensation/artifacts/emit). Documented fork (§23) but does NOT get executor auth/timeout/approval for these two tools.
- check-gates.mjs (run): 0 violations; test-only findings: approvals/approval-flow.integration.test.ts → ../tools/tool-executor.js & ../tools/tool-registry.js; channel-mounts/channel-mount-gate.test.ts → ../tools/tool-registry.js (report-only, docs already note).
- Cycles: tools→skills-gate→skill-service→(dynamic)tools-gate; tools→capabilities dynamic; broken by lazy imports (documented pattern). No runtime cycle observed.
- Hidden globals: toolRegistry/activeSchedules/mcpClientManager singletons; globalBroker fallback lookups scattered (tool-executor.ts:432,525,665,725; tool-registry.ts:7,93).

## Gaps (unverified, Low confidence)
- tsc --noEmit not run within time-box.
- event-broker `on()` return type vs `off(listenerId: string)` mismatch unverified (TOLS-09).
- channelIndex.topicSummary nullability unverified (TOLS-11).

## Docs sync
Read-only audit; docs not updated (per instructions). Drift noted: Tools.md:40 claims bash 300s vs code 30s (TOLS-01); Tools.md:51 "17 native definitions" vs 19 registered (2 flag-gated).
