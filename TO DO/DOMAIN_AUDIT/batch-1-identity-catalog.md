# Backend Domain Audit — Batch 1 (Identity & Catalog)
**Date:** 2026-09-25 · **Status:** COMPLETE — fixes applied, verification green · **Tree:** uncommitted, awaiting user review/commit (AGENTS.md §4)

Order audited: Agents → Modules → Skills → Capabilities → Tools (plus a cross-domain fix in Auth while verifying).
Pre-flight: user approved continuing on the dirty tree (prior-session Agents/Modules changes re-audited from scratch per instruction).

## Verification
- `npx vitest run` (packages/server): **95 files / 759 tests passed**, 0 failures (29 skipped, pre-existing skips).
- `npm run typecheck`: clean.
- `npm run lint:gates`: 0 violations (2 pre-existing allowlisted gate violations remain, documented).
- Stale vitest transform cache caused phantom failures mid-session (`--clearCache` + re-run resolved; cache-bug noted, not a code issue).

## 1) Agents
Findings & fixes:
- **P1** Escalation target selection ignored the failing agent's workspace (`agent-errors.ts` agentRegistry.list({isTemplate:false})) → coordinator from another workspace could be selected. FIXED: roster lookup filters `workspaceId` when the agent carries one (legacy unscoped agents keep cross-workspace search).
- **P1** Delayed takeover reply was fire-and-forget `setTimeout(async …)` — a failed `messageGate.append` left the target agent stuck `working`. FIXED: reply guarded, `setStatus(idle)` always runs in `finally`, both errors logged.
- **P2** `escalation:created` id `esc-${Date.now()}` collided for same-ms escalations. FIXED: random suffix appended.
- **P1** `setStatus` used `tierContextFor(null)` → PG leg + outbox fallback attributed to the global scope (unroutable outbox entries for workspace agents). FIXED: tier context resolved from the agent row's own workspace.
- **P1** `delete` deleted the first local file matching the id across ALL workspace folders (duplicate ids cross-delete) and used global tier context. FIXED: local delete scoped to the owning workspace; tier context from the row; REST delete 404s up front when the id does not resolve in the caller's workspace.
- **P2** `agentGate.getById` did not forward the new workspaceId scope arg. FIXED: gate forwards 3rd arg; routes GET/DELETE thread the tenant header resolution.
- Verified by: `src/agents` (7 tests), `src/channels`, `local-chat-e2e`, `src/events` (33 tests) — plus full suite.
- Not implemented (documented): runtime_states cascade semantics on hard delete; archived-agent fallback validation agreement; `contextTokenCap` has no PG column (types-only).

## 2) Modules
Findings & fixes:
- **P1** `ensureDefaultModules(null)` threw the store's "workspaceId is required when creating a module" error during unscoped local-mode agent creates — masking the agent store's clearer tenant guard. FIXED: scope-less call is a documented no-op (canon defaults are per-workspace rows); regression test added.
- **P2** `listAllModules` ignored limit/offset on the local tier (PG paginates, local returned everything) — tier-dependent page shapes. FIXED: same clamps applied locally.
- Verified by: `src/modules` (5 tests incl. new no-op test), full suite.
- Cross-domain (documented, NOT fixed here): module mutations in local tier are never queued to the outbox (`OutboxEntity` lacks a module kind) → PG convergence of modules after an outage relies on bulk converge only; needs Outbox + workspace-sync extension (Batch 5/6 follow-up).
- Pre-existing (documented): findReferencingAgent first-only; TtlCache single-slot thrash; costPer1k type drift.

## 3) Skills
Findings & fixes:
- **P1 (data loss)** `optionalToolIds` + `recommendedModels` accepted by validators/types but NEVER persisted — create/update silently dropped them; read back always `[]`. FIXED: migration `0022_skills_optional_tools_models.sql` adds `optional_tools`/`recommended_models` jsonb NOT NULL DEFAULT '[]' (+ schema.ts mirror + journal entry; legacy LEGACY_BOOTSTRAP DDL already had them — drift reconciled); service create/update now write both fields.
- **P2** REST attach/detach agent-skills had no error handling — unknown agent/skill ids surfaced as raw FK 500s. FIXED: FK violations (23503) map to clean 404; other errors propagate.
- Verified by: `src/skills` (18 tests), typecheck, full suite.
- Not implemented (documented gaps): local file tier for skills (501 in local mode is the documented guard behavior); db-override threading; resolved-tools registry validation.

## 4) Capabilities
Findings: **no correctness bugs found.** Availability filter, agent scoping, manifest overlay, lazy expansion, and integrity tests all hold; consumers (open_detail tool, tool-schema middleware) honor the contracts.
Documented-not-fixed (minor, already commented in code): manifest entries cannot clear a capability's tool list to `[]` (falls back to existing tools); unscoped manifest load is registry-order dependent (first workspace with a manifest wins).
Verified by: `src/capabilities` (21 tests), full suite.

## 5) Tools
Findings & fixes:
- **P1 (isolation)** `open_memory` honored a caller-supplied `agent_id` (and fell back to a hardcoded `"agent-raven"`) → cross-agent memory READ (note lookup scopes by agentId+noteId). FIXED: executing agent's context identity wins; mismatched overrides ignored; missing identity fails the call.
- **P1 (isolation)** `remember` same hole — an agent could write notes into ANOTHER agent's vault via `args.agent_id`. FIXED: context identity wins.
- **P1** `ToolExecutor` read the agent row from the ambient global pool only → agents living in a workspace-record database were invisible to every tool call ("Agent not found"). FIXED: when `ctx.workspaceId` names a workspace with an attached DB, the agent row is read through that workspace handle; NO_DATABASE/local-only falls back to ambient (legacy behavior preserved).
- **P2 (compensation invariant)** `edit_file` did not journal a compensation inverse (write_file/delete_file do) → destructive precision edits had no undo entry. FIXED: same restore-inverse journaled before mutating.
- **P3** MCP failed handshake left already-registered tools in the registry (dead server advertised). FIXED: `cleanupTools` on the connect error path (parity with the exit path).
- Verified by: `src/tools` (100 tests), typecheck, full suite.
- Cross-domain (documented, NOT fixed here): `skillsGate.getResolvedToolsForAgent` authorization still resolves via the ambient handle (same tenant-routing gap, needs Skills-side workspace threading); all-tools-need-PG in local tier is the current documented degradation.

## Cross-domain fix surfaced during verification
- **P1 (Auth, perf)** `verifyKey` hashed candidates SEQUENTIALLY (N × scrypt latency per authenticated request; wall time grew linearly with stored-key count → observed 5s request-path timeouts). FIXED in `shared/auth/api-key-service.ts`: candidates hashed concurrently (wall time ≈ one scrypt op); semantics unchanged. Auth doc updated. (Auth full audit = Batch 6.)

## Docs synced (AGENTS.md §6)
- Agents.md (escalation fixes, delete/setStatus tenant routing, getById scope arg)
- Modules.md (ensureDefaults no-op contract, listAll local pagination)
- Skills.md (optionalTools/recommendedModels persistence, assign/remove 404 mapping)
- Tools.md (tenant-routed agent lookup, edit_file compensation, memory-tool isolation, MCP handshake cleanup)
- Auth.md (verifyKey concurrent hashing)

## Stopping point
Batch 1 complete (5/5 domains audited, fixed, verified). Awaiting explicit instruction to continue with Batch 2 (Channels · Messages · Threads · ChannelMounts · Filesystem).

