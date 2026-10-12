# Tool registry, Guard and MCP
> Type: Feature · Status: aligned · Updated: 2026-09-21

## Intent
Agents must be able to act (read/write files, run commands, query data, schedule work) without acting beyond their grant, and third-party MCP servers must be able to add tools without becoming a trust hole. This feature exists so every tool call passes one registry, one authorization chain, and one safety classification before any handler runs — and so remote tools enter through the same gate as native ones.

## Architectural decision
The shape is three linked choices. First, Skills own the allowlist while Tools own enforcement: the executor checks membership but never edits grants, so permission changes propagate without registry churn `[Observed]`. Second, safety is tri-state — DENY always blocks, ASK denies when approvals are off and pauses the run for a decision when on — and the executor (not the guard) owns the wait, so `validateCommand` deliberately does not throw on ASK `[Observed]`. Third, MCP servers are untrusted by default: `dangerous` danger floor, annotations escalate-only, allowlisted child env with `shell: false`, stdout cap, RPC timeout, strike breaker, and tool unregistration on crash `[Observed]`. Batches preserve program order for read-after-write (pre-write reads run concurrently in a bounded pool, everything from the first write runs serially) while results stay in request order `[Observed]`. The honest-tool corollary: the scheduler fires real persist-then-emit events in both modes (BullMQ jobs or inline timers, ephemeral emit when persistence fails), never console-only `[Observed] [Inferred]`.

## How it works
`toolsGate.execute` enters `ToolExecutor.execute`; `executeBatch` classifies each call (`classifyToolEffect`, metadata first, name map next, `write` default) and either legacy-schedules or runs early reads in a bounded pool (default 4) then the serial tail in original order. Authorization order is fixed: agent exists → tool in the resolved allowlist (plus a hardcoded memory-tool fallback) → definition exists → `authLevelRequired` against `authorityLevel` unless omniscient. The bash path evaluates `Guard.evaluateCommand`: DENY throws, ASK with approvals off throws, ASK with approvals on checks a reusable grant (auto-approve with audit row plus both emits) else creates a pending approval, walks the run to `waiting_for_approval`, emits `approval.requested`, and blocks on the hybrid broker-event plus backoff-poll wait bounded by TTL+guard. The FS path (`write_file`/`delete_file`) first consults channel→workspace `requireApprovalFor` policy (default `delete,execute`), journals a best-effort compensation inverse via Runs before mutating, then follows the same pause flow. Execution races the handler against a per-tool timeout (default 30s, MCP 45s, bash 300s) on a combined timeout+caller-abort signal; any throw becomes `{ success: false, error }` — `execute` never throws for tool-level problems. Native handlers cover Guard-gated reads against the channel-mount `effectiveRoot` (`resolveToolRoot`, workspace-dir fallback), journaled writes with `sandbox:updated` emits, hardened shell execution with mount-aware cwd, layered read-only `query_database` (verb gate + mutation blocklist + single-statement + FROM/JOIN allowlist + outer `LIMIT 100` + 5s statement timeout + 20k truncation), honest `system_scheduler`, swarm-gated `dispatch_agent`, Level-0-only `search_all_channels`, Memories-delegating memory tools, the file-backed `lock_in`/`lock_out` pair (a bullmq worker process now sees the same lock), and `read_workspace_local`, the always-present `authLevelRequired: 0` door that stats then lists the workspace-local root rather than the mounted one MCP lifecycle: declare a session (auto-connect unless `autoStart: false`), spawn stdio with env allowlist plus decrypted declared secrets, handshake with version-drift warning, `tools/list` registers each tool as `mcp_<server>_<tool>` with floored danger; crashes reject all pending requests and unregister the server's tools, 5 consecutive failures trip the breaker, and disconnect escalates SIGTERM→SIGKILL.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Tools.md> | Owns the registry, the authorizing executor, Guard classification, MCP lifecycle, and the honest scheduler/query tools |
| <../Domain Spec/Skills.md> | Owns the tool allowlist (`getResolvedToolsForAgent`) that the executor enforces but never edits |
| <../Domain Spec/Approvals.md> | Owns approval rows, TTL/expiry, and reusable grants — Tools only requests and waits |
| <../Domain Spec/Runs.md> | Owns the run state machine (`running ↔ waiting_for_approval` walks) and the compensation journal |
| <../Domain Spec/Queue.md> | Owns delivery of BullMQ-scheduled jobs (`mode` / `getSchedulerQueue` / `startSchedulerWorker`) |
| <../Domain Spec/Memories.md> | Owns vault persistence behind the memory tools (`discardFromContext`, note reads/writes) |
| <../Domain Spec/Agents.md> | Owns the legacy `AgentSpawnManager.dispatchAgent` reached through the `dispatch_agent` tool path |

## Current state
Real: the registry with all 19 native definitions (17 always-present plus 2 flag-gated), the fixed authorization chain, tri-state Guard with hardened exec, RWP batching, timeout+abort race, reusable-grant auto-approval with audit rows, hybrid approval waits, compensation journaling, layered `query_database`, honest dual-mode scheduler, and the full MCP stdio lifecycle with breaker and crash cleanup. Flag-removable: `query_database` (`QUERY_DATABASE_ENABLED`) and `system_scheduler` (`SYSTEM_SCHEDULER_ENABLED`). Real: `web_search` delegates to `searchProviderGate.search`, which fans out to whichever of brave/tavily/serper holds a key (real HTTP, 5s timeout) and returns `[]` with a warning when none is configured. Real: `edit_file` is registered (`tool-registry.ts:311`) and both its approval gate and executor branch (`tool-executor.ts:562`, `tool-executor.ts:629`) are live. Unimplemented: `sse`/`http` MCP transports (stdio only).

## Alignment notes
Drift found and corrected this pass: (a) the native-handler enumeration named the channel-mount `effectivePath`, renamed to `effectiveRoot` when the mount jail moved into the workspace registry; (b) `web_search` was documented as a hardcoded mock, but the handler calls `searchProviderGate.search` and every provider does real HTTP; (c) `edit_file` was documented as an unregistered dead branch, but `tool-registry.ts:311` registers it and `tool-executor.ts:562`, `tool-executor.ts:629` handle it; (d) the native definition count read 16, which was accurate at the time and is now 19 (17 always-present plus 2 flag-gated) after `read_workspace_local` landed; (e) `lock_in`/`lock_out` were called an in-memory pair, but `shared/core/agent-lock-store.ts` persists them to `<localstore>/locks/<workspaceId>/locks.json` precisely so a restart and the worker process both see them. Otherwise sampled claims verified: executor auth order and never-throw contract (`tool-executor.ts`), `evaluateCommand` tri-state (`safety/guard.ts:329-419`), MCP escalate-only danger plus breaker/teardown (`mcp-client-manager.ts`), scheduler BullMQ/inline duality (`tool-registry.ts:543-653`), and `query_database` layering (`tool-registry.ts:451`). No contradiction between the Tools domain doc and cited code on the sampled paths; the drift above lived in this flow doc, not in `Tools.md`.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Skills own allowlist, Tools own enforcement. Executor checks membership, never edits grants.
* Tri-state Guard stays with executor owning the wait. Reusable-grant auto-approval keeps audit row plus both emits.
* RWP batching preserves program order with results in request order. Timeout plus caller abort reaches handlers.
* MCP transports are explicit: stdio supported, sse and http unimplemented. Empty-params registration against strict servers is forbidden.
* Inline cron supports full cron or rejects non-conforming expressions. activeSchedules plus MCP sessions are durable or explicitly ephemeral with loss window.
* mcp_servers table has a documented writer and sync path or is removed. Tools without explicit authLevel default deny or are explicitly public.
* hardened-exec has a documented sandboxing, caps, and signal contract. Authority: Tools standard.
## Open gaps
- `read_workspace_local` is the one realized native tool that no `BUILTIN_CAPABILITIES` descriptor names, so the capability index never advertises the workspace-local zone — whether L0 needs its own descriptors is unverified.
- `CrowdTool` vs `ToolDefinition` are parallel tool interfaces with different shapes; which is canonical is unverified.
- `safety/hardened-exec.ts` internals (sandboxing, output caps, signal handling) were not read — only the call contract is verified.
- Inline cron fallback only understands `*/N * * * *` and `activeSchedules` is never persisted — restarts lose inline schedules.
- `mcp_servers` persistence is wired (TOLS-05, 2026-10-08): `registerMcpServer` upserts the row, `unregisterMcpServer` disconnects + deletes it, and boot `toolsGate.restoreMcpServers()` repopulates sessions (no DB ⇒ no-op) — server configs no longer vanish on restart.
- `list()` shows tools without an explicit level to everyone including Level 3 — intent unverified.
- `dispatch_agent` requires a live `globalBroker` and fails without one even in DB-backed contexts.
