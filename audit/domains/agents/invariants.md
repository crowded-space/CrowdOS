# Agents Domain — Phase 3 Invariants, Races, Leakage, Boundaries (read-only)

Severity scale: S0 data loss/security · S1 isolation/correctness critical · S2 correctness/degraded ops · S3 hygiene.
Confidence: Confirmed / High / Medium / Low.

## A. State / transition invariants

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| INV-1 | l3Subtype only on authorityLevel 3 | Enforced (create structural :304; update always :700-702) | `agent-service.ts` |
| INV-2 | fallbackAgentId ≠ own id | Enforced on create/update (:704-706); NOT checked on delete (deleting a referenced fallback leaves dangling ref — FK `set null` only on PG) | :704-706, schema FK |
| INV-3 | Module refs must exist | dbOverride + dual tiers only; local tier + local-create SKIPS (dangling fallback possible locally) | :282,:457,:326-330 vs :306-325 |
| INV-4 | status single-owner (`setStatus`) | Mostly: `update()` rewrites runtime status (offline→offline else idle :466-467,:499-502) — an API edit of a working agent silently idles it; sweep writes both tables directly (:683) outside setStatus | :466-467,:683 |
| INV-5 | `runtime_states` row exists per agent | create inserts (`session-<id>`) on PG paths; LOCAL tier has no ledger (documented); update/delete/setStatus UPDATE with no insert-if-missing (silent no-op if row absent) | :286-292,:463-469 |
| INV-6 | archived rows hidden from list, visible via getById | Asymmetric by design (doc gap): getById resolves archived; reference validation does not exclude archived | :148 vs :186-223 |
| INV-7 | Roster cache reflects mutations | Gate mutations invalidate; `workspace-sync.ts:231,438,442` direct writes do NOT; local-store writes from other flows do not | `agent-roster-cache.ts:47-49`, AGT-007 |
| INV-8 | Tenant isolation: scoped reads never return other workspaces | list/getById/delete scoped paths OK; BUT unscoped `list()` fan-out (socket :752, mention-parser, channels :142) serves every workspace's roster; local store has no ALS awareness (:160-168) | AGT-003/004 |
| INV-9 | runtime_states PK is session; one row per agent | No unique constraint on `agent_id` (index only) — duplicates possible if a row is created by hand/bootstrap + create; updates then hit multiple rows | schema `runtime_states_agent_idx` |
| INV-10 | Hard-delete cascade | runtime_states cascade is best-effort, failure swallowed INSIDE tx; no FK; messages/other tables not touched | :521-525 |

## B. Races / concurrency

| # | Race | Analysis | Severity |
| --- | --- | --- | --- |
| R-1 | setStatus vs sweepOrphans | Sweep CAS re-checks status+heartbeat inside UPDATE, but `agents.status` write (:683) happens after the runtime_states flip with no re-check; concurrent setStatus('working') between the two writes leaves agents.status=working + runtime_states=paused (divergence). Window is small (ms). | S2 High |
| R-2 | update() vs setStatus | Both rewrite runtime status; last writer wins; `update()` can resurrect idle over a live working run (INV-4). | S2 Confirmed |
| R-3 | create duplicate | No idempotency key; route retries duplicate agents (new UUID each). | S3 Confirmed |
| R-4 | roster cache single-flight | Promise cached; fail-evict OK; TTL 30s means cross-process writes (worker) invisible up to 30s (cache is per-process). | S3 Confirmed |
| R-5 | sweep FOR UPDATE outside tx | Lock released at statement end (autocommit); CAS is the real guard; two sweepers can process same rows, second CAS no-ops. Harmless but comment overstates protection. | S3 Confirmed |
| R-6 | escalation takeover timers | Supersede per target; unref'd; process restart drops pending (target reset in finally only if timer fired — restart leaves target working until sweep). Mitigated by orphan sweep 20s. | S3 Confirmed |
| R-7 | delete vs in-flight setStatus/update | delete resolves row then deletes; concurrent setStatus after delete writes zero rows silently (update … where id matches nothing) — no error, status lost. | S3 High |

## C. Leakage / isolation

- L-1 (S1 High): unscoped socket/mention/channel reads leak cross-workspace rosters (AGT-003/004).
- L-2 (S1 Confirmed): tenant-bound `list()` (dbScopeKey ≠ global) reads ONLY the bound handle — local-tier rows of the same workspace are invisible when a PG handle is bound; and conversely bound-handle rosters can miss local agents created in local tier (AGT-002). Documented as intentional for leak-prevention, but breaks dual-tier workspaces.
- L-3 (S2 High): `dualWrite` outbox rows carry `workspaceId` from ctx; `setStatus` resolves ctx from row; `update` dual write resolves ctx from merged.workspaceId — OK. But `create` dual path for unscoped workspace relies on local store throw; PG leg may have committed before local throw? (dualWrite local-first — PG write happens AFTER local; local throws first → no PG leak. Confirmed safe order.)
- L-4 (S2 High): `getById` PG gap-fill includes legacy `workspaceId IS NULL` rows for every tenant (global rows visible everywhere) — documented legacy rule, not a leak per se, but archived/global semantics combine (AGT-006).
- L-5 (S3): roster cache key includes `JSON.stringify(filters)` — key order sensitive; distinct filter key shapes double-store (cosmetic).

## D. Validation / null / boundary

- N-1: `update()` `modelModuleId ?? existing` and `instructionModuleId ?? existing` (:380-381) — null is NOT clearable for these two fields despite docs claiming nullable clears (schema allows null; service coalesces). Clear attempt silently keeps value (AGT-009, S2 Confirmed).
- N-2: `species/avatar/...` null clears DO flow (`!== undefined` checks).
- N-3: `cursor` NaN/invalid → offset 0 silently; negative → 0; float floored (:167-174).
- N-4: `limit` clamps 1..200 both legs; 0/negative → 1 (route zod rejects <1 anyway).
- N-5: `contextTokenCap` zod int≥1 nullable; local persists; PG column absent → pgSet omits it (:418) and reads map `(row as any)` (:54-55) → PG tier silently drops the value (AGT-008, S2 Confirmed; migration follow-up).
- N-6: `workspaceId` body on create: zod `.nullable().optional()` but route overrides tenant — body can't spoof scope via route; direct service callers (tests) can.
- N-7: `permissions` normalize partial over deny-default; no enforcement anywhere (AGT-019, S3 Confirmed — advisory only).
- N-8: `LocalAgentRow.archivedAt` typed `string|null`; revive returns Date for archivedAt but type says string — mild type lie (Low).

## E. Errors / retry / telemetry

- E-1: `pgCatchNull` swallows ALL PG errors (logic + connection) in list/getById — a malformed query silently degrades to local/empty (AGT-010, S3 Confirmed).
- E-2: cascade delete failure swallowed INSIDE transaction — if driver aborts tx on statement error, the swallowed rejection may roll back the agent delete itself (comment says "logged on failure"; actual tx semantics unknown → Medium, AGT-005).
- E-3: dual PG failures are outboxed; replay path `workspace-sync.ts` handles agent upsert/delete; no dedupe key → double-replay safe (upsert).
- E-4: no metrics/spans in domain (only console + shared logMetric in token-tracker/escalation paths elsewhere); escalation has no telemetry. (AGT-021, S3 Confirmed)
- E-5: `setStatus` emit is `opts.broker?.emit` — broker-less callers (route-free runtime paths) emit nothing; no warn (AGT-011, S3 Confirmed).
- E-6: sweep silent clamp of ORPHAN_AFTER_MS without warn (:651-652) (S3).

## F. Boundary / architecture (AGENTS.md)

- B-1: Gate thin? Mostly — but exports `AgentRegistry` class + `agentRegistry` instance (docs' own NOTE). Direct class use: mention-parser `new AgentRegistry()` (:8), socket `new AgentRegistry()` (:40) — new instances share module-level cache + DB ambient state, so "new" is misleading; also `module-service.ts:118` uses `agentRegistry` via dynamic import of gate. Gate-to-gate OK.
- B-2: Cycles: none (dynamic module import for moduleGate; type-only broker; workspace-gate dynamic). `agent-errors.ts` imports `agent-service.js` directly (in-domain, OK) and messageGate (gate-to-gate).
- B-3: Hidden globals: module-level `pendingTakeovers`, roster cache, heartbeat Set in shared, token cost cache — all per-process (documented ceiling).
- B-4: `worker.ts:33 void agentGate` dead keepalive (S3).
- B-5: Direct agents-table writes from `shared/core/workspace-sync.ts` (sync/outbox) — allowed by Shared exemption? Shared/ is exempt from gate rule, but this is a domain-ownership bypass for cache invalidation (AGT-007).
- B-6: `routes/studio.ts` writes instruction-stack/skill tables directly (other domains' tables; noted as their gap, not agents').
- B-7: Tests import internals across domains (8 findings) — non-fatal per checker, recorded in test-gaps.

## G. Dead code / drift observed

- D-1: `agentGate.escalate` port removed (docs); escalation reached only via class export. No dead ports found otherwise.
- D-2: `worker.ts` import void (B-4).
- D-3: `runtime_states.activeTask/activeChannelId/startedAt/overridesApplied` never written by agents domain (bootstrap default only) — ownership unclear (S3 Low).
- D-4: `archivedAt/archivedReason` present in both tiers but no archive writer in this domain (spawn/retention removed) — dead fields; list still filters them (AGT-020, S3 Confirmed).
- D-5: Docs drift: Agents.md Ports list omits `agentGate.listLocalAgents/listLocalAgentRows/seedDefaultAgent` (present in gate) and includes stale line numbers; Feature doc "update() re-reads ambient getDb" gap is now stale (dbOverride path fixed :476, dual path still ambient :511 — partially stale). Doc updates not performed (this audit is read-only).
