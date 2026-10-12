# Agent profiles and roster
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Agents need a stable identity (name, authority, status) that outlives any particular prompt, model, or toolset, so the profile stores only identity plus references to versioned cognition modules. The roster is the filtered, ordered list of non-archived profiles that mention resolution, trigger routing, and admin UIs read on the hot path.

## Architectural decision
Profiles stay identity-only while prompts, models, and tools live in module tables, so cognition can be versioned and swapped without touching identity [Observed]. Reference validation fails before any write, so a profile can never point at a missing module or itself as fallback [Observed]. Roster reads are served from a 30s TTL single-flight cache keyed by tenant scope plus filter shape, so hot mention/trigger paths share one query and transient DB errors are never pinned [Observed]. Dispatch and escalation are deliberately out of this feature — identity and execution evolve on separate paths [Inferred].

## How it works
`create` validates module/fallback references, inserts the `agents` row with a fresh UUID, inserts a `runtimeStates` row (`offline` stays offline, anything else starts `idle`), then invalidates the roster cache and re-reads. `update` returns `null` when the id is missing, merges input over the existing row with explicit-null clearing, re-validates the merged refs, rewrites the row, invalidates Skills caches when toolkit/permissions changed, rewrites runtime-state status/heartbeat, then invalidates the roster cache. `list` serves the scope-keyed cached roster (archived rows excluded, authority/status/template filters, limit clamped 1–200, numeric-offset cursor, ordered by authority then name); a `db` override bypasses the cache but runs the same degraded loader as the bound path — a failing tenant PG leg (schema-mismatch/outage) falls back to the workspace-scoped local rows instead of failing the request. `getById` is a direct lookup with no archived-filter, so it can return archived spawn instances. `delete` hard-deletes by id and invalidates the cache.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Agents.md> | Owns profile CRUD, reference validation, runtime-state rows, and the 30s roster cache |
| <../Domain Spec/Modules.md> | Owns the five module tables that profile references point at (read-only from here) |
| <../Domain Spec/Skills.md> | Receives `invalidateAgentCaches` on toolkit/permission changes |

## Current state
Real: identity-only CRUD, pre-write reference validation, deny-by-default permission merge, 30s single-flight scope-keyed roster cache with fail-evict, runtime-state insert/rewrite alongside profiles. Flag-gated: none in this feature. Stub: none. Legacy: none — L3 dispatch, escalation, and retention sweeping are separate concerns and out of scope here.

## Alignment notes
- 2026-09-16 C3 slice 2: roster CRUD + `setStatus` read/write local `agents.json` when no DB (no `runtime_states` ledger locally; module-reference validation skipped, structural rules kept; `localSeedDefaultAgent` seeds the idle default-assistant). Escalation target lookup goes through the registry (no direct `agents` query).
- 2026-10-08 IMPL-AGENTLIST500-001: explicit-handle roster reads degrade like the bound ALS path — `GET /api/agents` with `request.db` no longer 500s when the tenant PG replica is unprovisioned/unreachable (42P01 class); it serves the workspace-scoped local tier. Unscoped filters stay PG-only. Regression: src/agents/agent-list-degrade.test.ts.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in the linked domain specs.
* Identity-only profiles with versioned cognition modules stay. Reference validation fails before any write.
* Single presence owner via agentGate.setStatus atomic flip stays. Split updates are forbidden.
* Roster cache stays 30s TTL single-flight scope-keyed with fail-evict. Cross-tenant sharing is forbidden.
* Every read-modify-write honors caller db override end to end. Ambient re-read dropping the override is forbidden.
* Authority: Agents domain standard. This flow does not duplicate rules.
## Open gaps
- `update()` re-reads through ambient `getDb()`, dropping the caller's `db` override — cross-workspace/test writes may read back from the wrong DB.
- `delete()` hard-deletes while spawn teardown archives; whether hard-delete orphans `runtimeStates`/`messages` rows (FK cascade vs orphan) is unverified.
- `getById()` returns archived rows and reference validation does not exclude archived rows, so an archived agent may be a legal fallback — intent unverified.
- `contextTokenCap` is read off `(row as any)` with a snake-case fallback, suggesting the column may not exist in schema — persistence unverified.
- `categoryPermissions`, `isOmniscient`, and the `permissions` blob have no in-domain enforcement observed.
