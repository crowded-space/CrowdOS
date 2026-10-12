# Tools

## Purpose
Central tool registry plus authorizing executor for every agent tool call. It owns the native tool set (filesystem, shell, search, database, scheduler, swarm-spawn, memory, context), guards each call through skill authorization → registry lookup → authority level → tri-state safety/approval checks, then runs the handler under timeout with caller-abort propagation — and separately manages MCP server lifecycles whose remote tools register into the same registry.

## Feature Scope
In-scope:
- Native tool definitions and the `ToolRegistry` (register/unregister/get/list, `tool-registry.ts`).
- Single and batched execution with authorization, safety, approval-pause, timeout, and compensation journaling (`tool-executor.ts`).
- `Guard`: path containment + blacklist, command DENY/ASK/ALLOW classification, whitelist checks (`safety/guard.ts`).
- MCP stdio client: connect/handshake/tool-registration, framing, circuit breaker, crash cleanup (`mcp/mcp-client-manager.ts`).
- Honest `query_database` (read-only, allowlisted, capped) and `system_scheduler` (BullMQ or inline-timer firing real events), both flag-removable.
Non-goals (other domains):
- Tool authorization source → Skills (`skillsGate.getResolvedToolsForAgent` is the allowlist; Tools only enforces it).
- Approval records, TTL/expiry, reusable grants → Approvals (Tools calls `approvalGate`, never stores approvals).
- Run status machine and checkpoints → Runs (Tools only requests `waiting_for_approval ↔ running` walks).
- Memory vault persistence → Memories (memory tools delegate to `memoriesGate`/`readMemoryNote`/`createMemoryNote`).
- Message persistence → Messages (the scheduler persists via a direct insert owned by Messages).
- Delivery, retries, job handles → Queue (`queueGate` scheduler queue in bullmq mode).
- Transport payloads and admin gating → Routes (`routes/tools.ts`, `routes/mcp.ts` call `toolsGate`).

## Expect
- `[Observed]` `execute` never throws for tool-level problems — unknown agent, unauthorized tool, missing definition, guard DENY, approval deny/expiry, timeout, and handler errors all return `{ success: false, error }`.
- `[Observed]` Authorization order is fixed: agent exists → tool in resolved allowlist (or one of the shared `UNIVERSAL_TOOL_IDS` fallbacks: `open_memory`, `discard_memory_from_context`, `remember`, `lock_in`, `lock_out`, `open_detail`, `load_skill`, `create_artifact`, `tool-executor.ts:356` + `tools-gate.ts:17`) → definition exists → authority level (`agent.authorityLevel > authLevelRequired` rejects unless omniscient; both execute and `list()` default `authLevelRequired ?? 0` fail-closed, `tool-executor.ts:370-374`, `tool-registry.ts:219-221`, 2026-09-26).
- `[Observed]` `execute_bash` DENY always blocks; ASK blocks immediately when approvals are off and pauses the run for a decision when on.
- `[Observed]` Batch results are always in request order; reads before the first write run concurrently (bounded), everything from the first write onward runs serially.
- `[Observed]` Unknown tool names classify as `write` (serialized) — the conservative default.
- `[Observed]` Approval waits always terminate: broker event is the fast path, 1s→5s backoff polling is the fallback, and TTL+2.5s is the hard ceiling with expiry handling. The fast path reads `approvalId` off the full broker envelope (`payload.payload.approvalId`, 2026-09-26 fix — the previous flat read never matched what the broker actually sent, so the event never fired).
- `[Observed]` MCP server claims can only escalate danger above the configured floor, never downgrade to safe.
  2026-09-25 audit fix: a failed handshake now unregisters any tools already registered before the failure (the exit path's `cleanupTools` parity), so a dead server's tools no longer linger in the registry listing (`mcp-client-manager.ts`).
- `[Inferred]` `executeBatch` with an empty call list resolves `[]` without touching the DB (early return precedes agent lookup).

## Flow
1. Entry: `toolsGate.execute(agentId, toolId, args, ctx)` → `ToolExecutor.execute` timed under `tool.execute:<id>`; `executeBatch` classifies each call (`classifyToolEffect`, `tool-executor.ts:40`) and either legacy-schedules (`TOOL_RWP=false`: all-reads parallel else fully serial, `tool-executor.ts:250`) or runs early reads in a bounded pool (default 4, `tool-executor.ts:269,276`) then the serial tail in original order (`tool-executor.ts:276+`).
2. Identity + authorization: fetch agent (unknown → failure result, `tool-executor.ts:352`); resolve allowlist via `skillsGate.getResolvedToolsForAgent` with the five hardcoded memory/context fallbacks (`tool-executor.ts:356-358`); look up the definition (`tool-executor.ts:365`); enforce `authLevelRequired ?? 0` against `authorityLevel` unless omniscient (`tool-executor.ts:370-374`).
   2026-09-25 audit fix: the agent row is fetched through the run's WORKSPACE-record database handle when `ctx.workspaceId` names a workspace with an attached database, falling back to the ambient handle for local-only workspaces (`tool-executor.ts`). Previously the lookup always used the ambient global pool, so an agent whose row lives in its workspace's own database was invisible to every tool call ("Agent not found").
3. Bash path (`execute_bash`): `Guard.evaluateCommand` → DENY throws; ASK with approvals off throws; ASK with approvals on checks a reusable grant (auto-approves with audit row + both emits, `tool-executor.ts:415-443`) else creates a pending approval, walks the run to `waiting_for_approval`, emits `approval.requested`, and blocks on the hybrid event+poll wait (`tool-executor.ts:450-498`, shared `waitForApprovalDecision`, `tool-executor.ts:78`); approved resumes `running` and executes (`tool-executor.ts:542`), denied/expired/missing resumes `running` and fails the tool safely (`tool-executor.ts:515,545`).
4. Safe path (`execute_safe`): non-whitelisted (`ALLOW`) commands fail immediately with no approval route (`tool-executor.ts:555-561`).
5. Filesystem path (`write_file`/`delete_file`/`edit_file`): loads channel→workspace `requireApprovalFor` policy (default `["delete","execute"]`, plus `autoAllowPaths`/`blockPaths`, `tool-executor.ts:566-580`); reusable-grant hits proceed; misses throw when approvals are off or run the same pending→wait→decide flow when on — the SAME shared `waitForApprovalDecision` as bash (`tool-executor.ts:641-732`).
6. Run: builds the `ToolExecutionContext` (channel/workspace defaults `general`/`default`, caller `runId` threaded through so handlers see it, `tool-executor.ts:743`); races the handler against a per-tool timeout (default 30s, MCP 45s, bash 300s) on a combined abort signal that also propagates caller aborts (`tool-executor.ts:771`); stamps `durationMs`, ends the tracing span, and returns (`tool-executor.ts:809-813`); any throw becomes a failure result with warn log (`tool-executor.ts:816-824`).
7. Native handlers (`tool-registry.ts:226`, `registerNativeTools`): `read_file`/`list_directory` Guard-gated reads; `write_file`/`delete_file`/`edit_file` Guard-gated mutations (`write_file` journals a compensation inverse via `runsGate` before mutating and emits `sandbox:updated`); `create_artifact` (`authLevelRequired: 1`, L0+L1) takes only type+body and delegates to `artifactsGate.create` with server-derived workspace/producer/run/path under `vfs/artifacts`; all FS roots resolve via `resolveToolRoot` (channel-mount `effectiveRoot` — Zone B when mounted, otherwise Zone A — with a `Guard.getWorkspaceDir` fallback); `read_workspace_local` is the one deliberate exception that reads Zone A directly (see below); `execute_bash`/`execute_safe` run through `Guard` + `execHardened` with cwd = `resolveToolRoot`; `web_search` fans out via `searchProviderGate.search` (brave/tavily/serper); `query_database` enforces SELECT/WITH-only, mutation blocklist (extended 2026-09-26 with `QUERY_FUNC_BLOCKED_RE` for `pg_*`/`lo_export`/`dblink`-class function calls), single-statement, FROM/JOIN allowlist (`agents, channels, messages, channel_index, token_usage_log`), then runs `SELECT * FROM (<q>) LIMIT 100` under `statement_timeout = '5s'` with 20k-char output truncation; `system_scheduler` books BullMQ delayed/repeatable jobs or honest inline timer/interval fallbacks that persist a real message then emit; `search_all_channels` (Level 0 only) scans `channel_index` with stale/degraded flagging; memory tools delegate to Memories; `lock_in`/`lock_out` flip the durable, workspace-scoped `agentLockStore` (Shared, file-backed at `<localstore>/locks/<workspaceId>/locks.json`, keyed `<channelId>:<agentId>` — §12/§30, so the lock survives restart and applies in the worker process); `remember` writes a vault note.
   2026-09-25 audit fixes: (a) `edit_file` now journals the same restore-inverse (prior content + hash) as `write_file`/`delete_file` before mutating — a precision edit that destroyed content previously had no compensation entry; (b) `open_memory` and `remember` attribute every read/write to the EXECUTING agent from the execution context — a caller-supplied `agent_id` naming a different agent is ignored instead of honored (the note lookup scopes by `(agentId, noteId)`, so the override was a real cross-agent memory channel), and the legacy `"agent-raven"` fallback in `open_memory` is gone (a missing identity fails the call) (`tool-registry.ts`).
8. MCP lifecycle: `registerMcpServer` stores the session (auto-connect unless `autoStart: false`); `connect` spawns stdio with `shell: false` and an env allowlist plus decrypted declared secrets (`mcp-client-manager.ts:220`, `mcp-client-manager.ts:68`); `initialize` handshake with version-drift warning, `notifications/initialized`, then `tools/list` registers each tool as `mcp_<server>_<tool>` with floored danger and derived auth level (`mcp-client-manager.ts:258`); stdout frames parse newline- or content-length-delimited JSON-RPC with a 10MB buffer cap and 30s request timeout (`mcp-client-manager.ts:337`, `mcp-client-manager.ts:398`); crashes/exits fail all pending requests and unregister the server's tools (`mcp-client-manager.ts:248`); 5 consecutive failures trip the circuit breaker (`mcp-client-manager.ts:380`); `disconnect` unregisters tools and SIGTERM→SIGKILL-escalates the child (`mcp-client-manager.ts:441`, `mcp-client-manager.ts:388`).
9. Runtime consumption: agentic loop fans model-requested calls through `toolsGate.executeBatch` (`agentic-runtime.ts:174`); pi-bridge executes/lists through the gate (`pi-tool-bridge.ts:34`); tool-schema middleware compiles prompt tool lists from `toolsGate.get` (`tool-schema-middleware.ts:28`); admin test-execution goes through `POST /api/tools/execute-test` (admin-gated via `authGate.requireAdmin` when `WORKSPACE_ADMIN_TOKEN` is set — same conditional pattern as observability, so loopback desktop runs without it — plus 10/min rate limit, `routes/tools.ts:9,61-64`, 2026-09-26 audit fix).

## Current Implementation
| File | Role |
| ---- | ---- |
| `tools-gate.ts` | Thin facade: re-exports `toolRegistry`/`resolveToolRoot`/`Guard`/`type ToolDefinition` and exposes the `toolsGate` CRUD + resolveToolRoot + execute + MCP ports (trimmed 2026-09-26 — classes/types come from their defining modules, not the gate) |
| `tool-executor.ts` | `ToolExecutor`: auth chain, tri-state approval waits, batch scheduler, timeout/abort race |
| `tool-registry.ts` | `ToolRegistry` + all 18 native definitions + scheduler emit + `activeSchedules` |
| `tool-types.ts` | `ToolDefinition` / `ToolResult` / `ToolExecutionContext` / effect/danger/source types + `ToolTimeoutError` (single canonical tool shape) |
| `safety/guard.ts` | `Guard`: workspace containment, file blacklist, command DENY/ASK/ALLOW engine |
| `safety/hardened-exec.ts` | Hardened shell runner behind `execHardened` (consumed with cwd/signal/300s timeout; internals untraced — see Gaps) |
| `mcp/mcp-client-manager.ts` | `McpClientManager`: stdio sessions, JSON-RPC, registration, breaker, teardown |
| `mcp/mcp-types.ts` | Protocol pin (`2024-11-05`), framing/danger defaults, server config/status/annotations types |
| `definitions/` | Empty (`.gitkeep` only) — no file-based tool definitions |

Key functions/values: `classifyToolEffect` (metadata wins, name map next, `write` default, `tool-executor.ts:40`); `STATIC_TOOL_EFFECT_CLASSES` (`tool-executor.ts:19`); `runBoundedPool` (`tool-executor.ts:202`); `extractTableNames`/`QUERY_BLOCKED_RE`/`QUERY_FUNC_BLOCKED_RE`/`hasMultipleStatements` (SQL guards, `tool-registry.ts:34-41,43,74`); `honestSchedulerEmit` (persist-then-emit with ephemeral fallback, `tool-registry.ts:83`); `buildChildEnv` (env allowlist + encrypted-secret resolution, `mcp-client-manager.ts:69`).

## Ports
- `toolRegistry` — singleton registry (register/unregister/get/has/list).
- `resolveToolRoot` — FS root resolution (channel-mount `effectiveRoot` → Zone B when mounted, else Zone A; `Guard.getWorkspaceDir` fallback) — also exposed as `toolsGate.resolveToolRoot`.
- `Guard` — safety facade (`validatePath`, `validateCommand`, `evaluateCommand`, `isCommandWhitelisted`, `getWorkspaceDir`, `isInsideRoot`).
- `type ToolDefinition` — `{ id, name, category, sourceType, parameters, dangerLevel, effectClass?, authLevelRequired?, timeoutMs?, handler }` type.
- 2026-09-26 gate trim: `ToolExecutor`, `activeSchedules`, `mcpClientManager`, `ToolTimeoutError`, `ToolResult`, `ToolExecutionContext`, `ToolParameterSchema`, `ToolSourceType`, `ToolDangerLevel`, the `Mcp*` types, and the dead `toolsGate.cancelSchedule` port (zero callers) are no longer gate exports — in-domain code/tests import classes/types from their defining modules (`tool-executor.js`, `tool-types.js`, `mcp-types.js`, `mcp-client-manager.js`); outside domains must not import past the gate.
- `toolsGate.get` / `toolsGate.has` — definition lookup / existence.
- `toolsGate.list` — definitions by optional `{ category, authLevel }` (`authLevel` keeps tools with `(required ?? 0) <= level`, fail-closed default, `tool-registry.ts:219-221`).
- `toolsGate.register` / `toolsGate.unregister` — dynamic definition add/remove (MCP + tests use these). `register(def, { overwrite? })` is typed (`ToolDefinition`); re-registration warns loudly, and an MCP server shadowing a NATIVE name throws unless `overwrite: true` (2026-09-25 audit fix).
- `toolsGate.execute` — authorized single-tool run (typed `args: Record<string, unknown>`, `ctx?: Partial<ToolExecutionContext>`; stateless refusals return `{ success: false }`, never throw into the batch).
- `toolsGate.executeBatch` — RWP-scheduled batch run, ordered results.
- `toolsGate.connectMcp` / `toolsGate.disconnectMcp` — server connect / teardown (concurrent connects share one handshake; kills are process-tree kills).
- `toolsGate.getMcpStatus` / `toolsGate.listMcpStatuses` — status reads.
- `toolsGate.registerMcpServer` — session declare (+ auto-connect; the config is upserted into `mcp_servers`, TOLS-05). Validates shape (non-empty id without path separators; stdio requires string command + string[] args). NOTE: stdio spawn of an arbitrary command is inherent to MCP and the HTTP layer is loopback-trusted single-user by design — validation rejects malformed configs, not the model (2026-09-25 audit note).
- `toolsGate.unregisterMcpServer` — server teardown: disconnect + delete the `mcp_servers` row (TOLS-05).
- `toolsGate.restoreMcpServers` — boot restore: repopulate MCP session configs from `mcp_servers`; no DB ⇒ no-op (TOLS-05).

## Relations
Gates this domain calls:
- `skills-gate.ts` — `getResolvedToolsForAgent` allowlist on every execution (`tool-executor.ts:356`).
- `approval-gate.ts` — `mapRisk`/`argsPreview`/`computeScopeHash`/`createPending`/`createApproved`/`getById`/`findReusableGrant`/`emitDecided` across both pause flows (sweeper owns expiry; executor never calls `expirePendingApprovals`). 2026-09-26 fix: the scope hash is fed the FULL tool args (`tool-executor.ts:410,641`) so two commands sharing a 500-char preview prefix cannot collide into one reusable grant; preview truncation is display-only.
- `runs-gate.ts` — `transition` for approval walks; `buildCompensationInverse`/`addCompensation` before file writes.
- `memories-gate.ts` — `memoriesGate.discardFromContext`, `readMemoryNote`, `createMemoryNote` from memory tools.
- `queue-gate.ts` — `mode()`/`getSchedulerQueue()`/`startSchedulerWorker()` for BullMQ scheduling, dynamic import.
- `channel-mount-gate.ts` — `effectiveRoot` for the FS root (`resolveToolRoot`, `tool-registry.ts:144`); Zone B when a mount resolves, otherwise Zone A, with a `Guard.getWorkspaceDir` fallback, dynamic import (no module cycle).
- `workspace-gate.ts` — `resolveWorkspaceLocalRoot` for `read_workspace_local` (Zone A), dynamic import.
- `Filesystem/filesystem-gate.ts` — `isVisibleEntryName`, so `read_workspace_local` lists directories by the same rule as the Repo tree.
- `event-broker-gate.ts` — single shared instance via `getSharedBroker()`/`globalBroker` (no orphan `new EventBroker()` fallbacks).
Known outside callers of `toolsGate` (+ class-level users):
- Runtime: `agentic-runtime.ts` (`executeBatch`), `pi-tool-bridge.ts` (execute/list), `tool-schema-middleware.ts` (`get`).
- Routes: `routes/tools.ts` (list/get/admin execute-test), `routes/mcp.ts` (server CRUD + connect/disconnect), `routes/studio.ts` (resolves tool cards from ids).
- Tests swap definitions freely via `toolRegistry`/`ToolExecutor` (`approval-flow.integration.test.ts`, `tool-executor.batch.test.ts`, `executor.timeout.test.ts`, `tool-registry.*.test.ts`).
- Boot: `create-app.ts` fires `toolsGate.restoreMcpServers()` at startup — best-effort restore of persisted MCP configs; no DB ⇒ no-op (dual-boot preserved, TOLS-05).
Tables touched:
- Reads: `agents` (identity/authority), `channels` (dispatch fallback), `channel_index` (omni search), `channel_settings` + `workspace_safety_settings` (FS policy), allowlisted `agents/channels/messages/channel_index/token_usage_log` via `query_database`.
- Writes: `messages` (scheduler persist, owned by Messages), `runs_compensation` (via `runsGate`, owned by Runs); `mcp_servers` is now persisted by Tools (TOLS-05: `registerMcpServer` upserts the row, `unregisterMcpServer` deletes it, boot `restoreMcpServers` reads it) — no longer memory-only. Fixed this round: authz runs in the agent row's workspace handle (SK-002); fallback universals are shared `UNIVERSAL_TOOL_IDS` (SK-008); bash honors 300s toolDef timeout (TOLS-01); tripped breakers refuse (TOLS-03); disconnect bumps connect epoch (TOLS-06); approval-path transition failures warn (XD-028).
- `read_file` enforces the 1MB cap (same as `read_workspace_local`); bare SELECT without an allowlisted table is rejected; inline cron accepts only `*/N * * * *` — non-cron-shaped inputs throw `Invalid cron expression` and cron-shaped expressions unsupported by the inline fallback throw `Unsupported cron for inline fallback` instead of silently degrading to a 60s interval (2026-09-25/26 audit fixes); delaySeconds clamped to 2^31-1 ms.

## Emits-Listens
- `sandbox:updated` (emits, on file write/delete with workspace + changeType)
- `approval.requested` (emits, bash + FS pause flows, room-scoped)
- `approval.decided` (emits, grant/deny/expire paths; also listened)
- `message:new` (emits, scheduler firing persists then broadcasts)
- `scheduled:triggered` (emits, scheduler firing alongside the message)
- `approval.decided` (listens, ephemeral per-wait subscription as the fast path; DB polling is the fallback)

## Owns
- Nothing tabular — the registry, `activeSchedules`, and MCP sessions are process-memory only; every DB write lands in another domain's table (see Relations). (`mcp_servers` doubtful → Gaps.)

## Flags
- `QUERY_DATABASE_ENABLED` — `false`/`0` unregisters `query_database`; default true (`tool-registry.ts:14`).
- `SYSTEM_SCHEDULER_ENABLED` — `false`/`0` unregisters `system_scheduler`; default true (`tool-registry.ts:20`).
- `TOOL_RWP` — `false` selects legacy batch scheduling (all-reads-parallel else fully serial); default is read/write-parallel mode (`tool-executor.ts:102`).
- `TOOL_RWP_MAX_READ_CONCURRENCY` — bound for parallel early reads, default 4, non-positive/non-integer falls back (`tool-executor.ts:120`).
- `APPROVALS_ENABLED` — `true` switches ASK from deny to the pause-and-wait flow (executor + `Guard.validateCommand` agree on this bit, `tool-executor.ts:389,632`, `guard.ts:435`).
- `APPROVAL_TTL_MS` / `APPROVAL_PENDING_TTL_MS` — approval wait budget, default 5min (`tool-executor.ts:447-449`).
- `LEGACY_GUARD` — `true` selects prefix-match path/command classification instead of the tokenizing engine (`guard.ts:15`).
- `WORKSPACE_DIR` — sandbox base for bare workspace ids (`<WORKSPACE_DIR>/<id>`, else `<cwd>/sandbox/<id>`) and last-resort Zone A root; an unresolvable root now throws instead of falling back to `process.cwd()` — that fallback let a rootless agent read and write the running server's own source tree (`guard.ts:117-148`, 2026-09-26 fix).
- `read_workspace_local` has no flag: it is always registered, because the Zone A door must not depend on an operator opt-in.

## Decisions
- `[Observed]` Skills own the allowlist, Tools own enforcement — executor checks membership but never edits grants, so permission changes propagate without registry churn (`tool-executor.ts:356`).
- `[Observed]` Tri-state Guard (DENY always blocks; ASK denies when approvals are off, pauses when on) with `validateCommand` deliberately not throwing on ASK in APR-1 mode — the executor, not the guard, owns the wait (`guard.ts:398`).
- `[Observed]` Reusable-grant auto-approval with fresh audit row + both emits — repeat commands skip the human wait but never skip the audit trail (`tool-executor.ts:415`).
- `[Observed]` Hybrid approval wait (broker event fast path — envelope-aware `approvalId` read, 2026-09-26 fix — + 1s→5s backoff poll + TTL+2.5s hard ceiling with expiry sweep, shared `waitForApprovalDecision` for bash and FS, `tool-executor.ts:78,498,711`) — decisions arrive fast, missed events still resolve, waits always terminate.
- `[Observed]` RWP batching preserves program order for read-after-write (pre-write reads parallel, post-write reads serial) while results stay in request order (`tool-executor.ts:123`).
- `[Observed]` Combined timeout+caller abort signal handed to handlers — timeouts actually stop underlying shell/fetch work instead of leaking past a `Promise.race` (`tool-executor.ts:636`).
- `[Observed]` Compensation journaling precedes every `write_file`/`delete_file` mutation and is best-effort (failures swallowed) — undo support never blocks the write itself (`tool-registry.ts:288`).
- `[Observed]` Scheduler fires honestly in both modes: BullMQ delayed/repeatable jobs or inline timers that persist a real message and emit (never console-only), with an ephemeral emit when persistence fails (`tool-registry.ts:83`).
- `[Observed]` MCP servers are untrusted by default: `dangerous` floor, annotations escalate-only, Secret-shaped env dropped unless declared, allowlisted child env with `shell: false`, 10MB stdout cap, 30s RPC timeout, 5-strike breaker, SIGTERM→SIGKILL teardown, tool unregistration on crash (`mcp-types.ts:27`, `mcp-client-manager.ts:59`, `mcp-client-manager.ts:68`).
- `[Observed]` `query_database` is layered read-only: verb gate + mutation word-blocklist + blocked-function regex (`QUERY_BLOCKED_RE`/`QUERY_FUNC_BLOCKED_RE`) + single-statement + FROM/JOIN allowlist + outer `LIMIT 100` + 5s `statement_timeout` + 20k output truncation (`tool-registry.ts:34-41,560-605`).
- `[Inferred]` The approval wait deliberately holds one run-worker slot while sleeping (no PG connection per tick, but the slot is held) — suspend-and-resume was skipped as a bigger redesign, with wait latency/poll counts recorded for visibility (`tool-executor.ts:305`).
- `[Observed]` **`read_workspace_local` is the L0-only door to Zone A, and deliberately the ONE door.** Ordinary `read_file`/`list_directory` resolve through `resolveToolRoot` to the channel’s *effective* root, so they never reach Zone A at all; `authLevelRequired: 0` closes the new tool to every other tier by the same comparison that restricts `search_all_channels` (`tool-registry.ts:1316-1343`). This is §15’s "distinct tool and capability set" for L0 rendered as a **capability boundary, not a wider path jail** (decision D4).
- `[Observed]` **`read_workspace_local` is read-only by design, and that is load-bearing.** D5’s safety argument is that authority-bearing config lives in the workspace registry, *outside* every root; an agent-writable Zone A would move that boundary back inside a tree an agent can reach. Read-only is therefore the condition that keeps D5 true, not a scope cut.
- `[Observed]` `read_workspace_local` resolves its root via `workspaceGate.resolveWorkspaceLocalRoot` and then **stats that root, failing loudly when it is absent** — because `Guard.getWorkspaceDir()` falls back to `WORKSPACE_DIR` when the root it was handed does not exist, which would read a DIFFERENT directory than the one resolved (`tool-registry.ts:1349-1362`).
- `[Observed]` `read_workspace_local` lists directories through `Filesystem/filesystem-gate.ts` `isVisibleEntryName` — the same rule `LocalFilesystem.list` and `channel-mount-service.browseFs` use, so the tool’s listing and the Repo panel’s tree cannot disagree about what is visible.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Skills-allowlist plus tri-state Guard plus hybrid approval wait stay; MCP session durability and the hardened-exec documented contract are the remaining gaps (cron honesty and authLevel defaults closed 2026-09-26).
Skills own the allowlist and Tools own enforcement stays. Executor checks membership but never edits grants.
Tri-state Guard stays: DENY always blocks, ASK denies when approvals off and pauses when on. Executor owns the wait, not the guard.
Reusable-grant auto-approval stays with fresh audit row plus both emits. Hybrid approval wait stays with broker fast path plus poll plus hard ceiling.
RWP batching stays preserving program order for read-after-write with results in request order. Combined timeout plus caller abort stays handed to handlers.
safety hardened-exec MUST have a documented contract: sandboxing, output caps, signal handling. Unread security core is forbidden.
MCP transports MUST be explicit: stdio supported, sse and http labeled unimplemented. Silent empty-params registration against strict servers is forbidden.
Inline cron MUST either support full cron or reject non-conforming expressions. Silent 60s fixed-interval fallback is forbidden.
activeSchedules plus MCP sessions MUST be durable or explicitly ephemeral with a documented loss window. Silent restart loss is forbidden.
mcp_servers table MUST have a documented writer and sync path or be removed. Memory-only configs with a dead table are forbidden.
Tools without an explicit authLevel MUST default deny or be explicitly public by contract. Silent visibility to Level 3 is forbidden.
dispatch_agent MUST NOT hard-require a live globalBroker in DB-backed contexts. Broker-less execution needs a defined path or explicit failure contract. (N/A as of 2026-09-26: no `dispatch_agent` tool exists — neither in the registry nor anywhere in `src`; legacy dispatch was retired. Standard retained for any re-add.)
## Failure + Resume
- Every tool-level failure resolves to `{ success: false, error }` with `durationMs`; batch callers see per-call failures in order, never a batch rejection for tool reasons (`tool-executor.ts:816`).
- Approval deny/expiry resumes the run to `running` and fails only the tool — the run continues per default-deny policy; disappeared approvals and caller aborts fail with distinct messages (`tool-executor.ts:473`).
- Timeouts reject via `ToolTimeoutError`, abort the handler's signal, and the race loser is swallowed-and-logged so timed-out work never surfaces as an orphaned rejection (`tool-executor.ts:644`, `tool-executor.ts:674`).
- MCP crashes reject every pending request with `McpServerCrashedError`, unregister that server's tools, and mark the session — reconnect is explicit via `connectMcp`, never automatic (`mcp-client-manager.ts:248`).
- Scheduler BullMQ failures warn and fall back to inline timers; inline emit failures log only (`tool-registry.ts:703,712,757,764`).
- Resume is per-call retry by the agent/operator (admin `execute-test`, re-dispatch); no tool-level checkpointing exists.

## Gaps
- `safety/hardened-exec.ts` internals were only partially read (2026-09-26: taskkill spawn now tolerates its own `error` event); a documented contract for sandboxing, output caps, and signal handling is still missing — only the call contract (command/cwd/signal/300s timeout) is verified.
- `sse`/`http` MCP transports throw "not yet fully implemented" — only stdio works; `McpRawTool` tools with no `inputSchema.properties` register with `{}` params, unverified against strict servers.
- `activeSchedules` is never persisted — restarts lose all inline schedules (`tool-registry.ts:81`). Cron honesty itself is closed (2026-09-26): non-cron-shaped inputs throw `Invalid cron expression` (`tool-registry.ts:669`) and cron-shaped expressions unsupported by the inline fallback throw `Unsupported cron for inline fallback` (`tool-registry.ts:708`) — no silent 60s path remains.
- TOLS-05 (fixed 2026-10-08): `mcp_servers` persistence is wired — `registerServer` upserts the row (`onConflictDoUpdate` on id), `unregisterServer` disconnects + deletes it, and boot (`create-app.ts`) fires `toolsGate.restoreMcpServers()` best-effort (no DB => no-op; dual-boot preserved). Regression: `src/tools/mcp/mcp-persist.test.ts` hermetic restart simulation (fresh manager over the same injected handle restores configs; unregister leaves nothing; no-DB registration stays in-memory) — no live PG needed.
- Cross-domain imports past the gate remain in test files outside this fix's allowed set: `approvals/approval-flow.integration.test.ts` imports `tool-executor.js` and `channel-mounts/channel-mount-gate.test.ts` imports `resolveToolRoot` from `tool-registry.js` (both symbols are now gate-exported — test rewiring pending, report-only 2026-09-26).
- `read_workspace_local` is deliberately **not catalog-named and not deferred** — so the Zone A door never depends on an `open_detail` round trip. Whether the L0 set grows beyond this one tool is unverified (open item O5, `re-docs/UI UX Overhaul/02-filesystem-model.md` §6).
- TOLS-02 (fixed 2026-10-07): FS mutation handlers refuse on an already-aborted ctx.abortSignal and write_file/edit_file pass the live signal into fs.writeFile; delete_file relies on the pre-check only (fs.unlink has no signal option). Executor race loser still logs and stops at the handler boundary.
- TOLS-03 (fixed 2026-10-07): sendJsonRpc refuses while session.status === 'error' (breaker trips at 5 consecutive failures). Gate is a refusal only — the tripped session keeps its child and registered tools; killChild + cleanupTools on trip remains open (see TOLS-03 Fix alternative).
- Regression: src/tools/fs-abort.test.ts (TOLS-02) and mcp-client-manager.test.ts breaker case (TOLS-03).
- TOLS-06 (fixed 2026-10-07): `session.epoch` (typed field) is bumped by `disconnect`; `connectStdio` aborts before the register loop when the epoch changed or the session exited; the connect catch preserves `disconnected` and sweeps tools instead of overwriting status with `error`. Regression: mcp-client-manager.test.ts concurrent connect/disconnect case (fails pre-fix with status `error`).
- TOLS-05 residual doc drift (2026-10-08, synced same day): the Ports/Relations sections now list `unregisterMcpServer`/`restoreMcpServers` plus the `create-app.ts` boot restore, and `Feature and Flow Spec/Tool registry, Guard and MCP.md` no longer claims MCP configs are memory-only. Remaining: the `Owns` section above still reads "`mcp_servers` doubtful → Gaps" — sync pending.
- Regression (this batch): mcp-client-manager.test.ts TOLS-06 concurrent connect/disconnect case.
