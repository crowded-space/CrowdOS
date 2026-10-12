# Module library
> Type: Feature · Status: aligned · Updated: 2026-09-26

## Intent
Agent cognition (which model, which instructions, which tools, which constraints, which capabilities) changes more often than agent identity, so the five module kinds live as versioned rows that profiles reference instead of embedding. Operators need to edit those rows, verify a provider connection before assigning it, and trust that stored API keys are never lying around in plaintext.

## Architectural decision
API keys are encrypted before insert and decrypted only inside the stored-module connection test, so live credentials justify the single decryption site [Observed]. Secret redaction happens at the route layer, not the service, so the service returns full rows and trusts the boundary to scrub; a PUT-back of the redacted mask is treated as "keep existing" rather than a new key [Observed]. `listAll` is TTL-cached 10s and every mutation clears the cache first, so hot polling dedupes the 5-table fan-out without serving post-mutation staleness [Observed]. Deletes are blocked by a two-layer live-reference guard — a scoped first-only 409 at the route plus an unscoped plural `MODULE_IN_USE` 409 inside the PG service branches (legacy shared rows carry no workspace) — instead of DB cascade, forcing an explicit reassign-first flow [Observed]. Offline/timeout/unknown-provider connection tests report `{ success: false, offline: true }` / `{ success: false }`, never a false live-success, so air-gapped and CI environments get an honest config-shape verdict [Observed].

## How it works
Per-kind `list`/`get`/`create`/`update`/`delete` run over the five module tables (or the per-workspace `.crowdos` JSON files on the local tier) with clamped pagination (limit 1–500 default 500, offset ≥ 0; `""`/null → default, explicit `0` → clamps to 1); `listAll` caches the 5-table fan-out 10s under a workspace+DB+page key (PG tier only) and is cleared before every mutation. Creates mint a UUID, apply per-kind defaults, and encrypt a model `apiKey`; updates are partial (non-empty) and re-encrypt a supplied key. Local-store writes verify the existing file first (corrupt → 500 `MODULE_STORE_CORRUPT`, file untouched) and unscoped reads/deletes touch only the default folder. Model writes invalidate the whole runtime model cache through a dynamic gate import (avoids the middlewares eval-time cycle); toolkit writes invalidate all agent skill caches. The stored test loads the row (missing → 404 at the route), decrypts its key, and delegates to the connection helper; the ad-hoc test pings google/openai/anthropic/ollama over 3s-timeout POSTs, maps HTTP errors to `{ success: false }`, timeout/abort/offline to `{ success: false, offline: true }`, and unknown providers to `{ success: false }` with no network call. Routes guard deletes via `findReferencingAgent` (scoped 409 naming the first blocker), redact secrets on reads, and emit `workspace:sync` on every mutation.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Modules.md> | Owns the five module tables and local JSON stores, `listAll` cache, key encryption, both connection-test paths, delete guards |
| <../Domain Spec/Agents.md> | Validates module references through `moduleGate.validateReferences` (dynamic import) and seeds the canon local defaults |
| <../Domain Spec/Runtime.md> | Reads model/instruction/constraints modules through the gate; receives whole-cache invalidation on model writes |
| <../Domain Spec/Skills.md> | Receives global cache clear on toolkit writes |

## Current state
Real: per-kind CRUD with partial updates and tier-aware reads, `listAll` 10s TTL fan-out with write invalidation, stored + ad-hoc provider tests with failure verdicts, encrypt-on-write/decrypt-only-for-test with mask round-trip guard, two-layer 409 delete guard, local-store corruption guard. Flag-gated: none. Stub: none. Legacy: four excluded direct readers kept (see Open gaps).

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Encrypted apiKey with decrypt-only-in-test stays. Redaction stays at route layer with full-path checklist; PUT-back masks keep the existing key.
* Delete stays blocked by live reference with reassign-first flow; the PG service branch must name every blocker. DB cascade under agents is forbidden.
* Reference validation goes through moduleGate.validateReferences single choke point. Direct table reads from Agents are forbidden (satisfied; four other readers remain open).
* costPer1k typing matches schema (satisfied). Connection tests never report false live-success (satisfied).
* Authority: Modules standard.
## Open gaps
- Four excluded direct module-table readers stay (probe-verified to break non-editable test mocks): `skills/skill-service.ts:241`, `shared/core/model-routing.ts:159-185`, `shared/core/token-tracker.ts:191-193`, the legacy fallback in `runtime/kernel/middlewares/instruction-stack-middleware.ts`. Convert once those tests gain `resolveTier`/`isConnectionError`/seeded fixtures.
- Runtime model-cache invalidation is whole-cache only; exact per-id clearing needs `invalidatePrefix` at `context-pipeline-manager.ts:65`.
- `context-pipeline-manager.ts:99` reads the model module unscoped — after the local-store scope narrowing it only probes the default folder; should pass `ctx.workspaceId`.
- `workspace-database.ts:~521` seeds module rows with raw db + its own ids, bypassing the gate (Zod strips client ids).
- Whether `runtimePatchable` on instruction modules is enforced anywhere vs advisory was not traced beyond storage.
- Stored custom-provider endpoint semantics (override vs fallback) are unverified beyond pass-through.
- No observed writer/owner for `embedding_model_profiles` — embedding provider config lives outside this CRUD surface.
