# Agents Domain — Phase 4 Test Baseline & Gaps (read-only; no new tests written)

## Baseline (exact commands + results)

| Command (cwd) | Result |
| --- | --- |
| `npx vitest run src/agents` (packages/server) | **3 files passed, 11 tests passed**, 0 failed, ~3.0s |
| `npx tsc -p tsconfig.json --noEmit` (packages/server) | exit 0 |
| `node scripts/check-gates.mjs` (packages/server) | exit 0 — 361 files / 23 domains / 0 violations; 46 TEST-ONLY findings (8 agent-related); 3 allowlisted (none agents) |
| `git status` | main; pre-existing dirty tree untouched; only `audit/` added (untracked) |

Existing tests (all passing):
- `agent-local-store.test.ts` — full-field create round-trip; merge-update keeps omitted fields; scoped list isolation.
- `agent-roster-cache.test.ts` — TTL single-scan; create/update/delete invalidate; archived guard; tenant-scoped getById/delete never cross-workspace (CRITICAL-1) incl. legacy unscoped fan-out retained.
- `agent-validators.test.ts` — query-boolean strictness; contextTokenCap accept/null/undefined.

## Gaps (no new tests written per phase-4 rule; each maps to ledger IDs)

| # | Untested behavior | Ledger | Why it matters |
| --- | --- | --- | --- |
| G-1 | `setStatus` contract: dual path row-derived tenant, local flip miss warn, lease mark, `agent:status` emit, roster invalidation, errorInfo timestamp | AGT-011, INV-4 | Sole presence owner; no unit coverage at all |
| G-2 | `update()` title-only preserves runtime_states.status=working | AGT-014 | Current code fails this expected behavior |
| G-3 | `update()` null clears modelModuleId | AGT-009 | Documented contract vs actual `??` merge |
| G-4 | `delete()` cascade semantics when runtime_states delete fails (tx outcome) | AGT-005 | Unknown commit/rollback behavior |
| G-5 | Dual-tier list inside bound handle includes workspace-scoped local rows | AGT-002 | Local-first truth hidden in request scope |
| G-6 | Unscoped create in local tier: ensureDefaults vs tenant guard ordering | AGT-015 | Possible default-scope writes |
| G-7 | `sweepOrphans`: CAS re-check under concurrent touch; isLive skip; paused>0 invalidation; event payload workspaceId | AGT-012, AGT-013, INV-4 | Race-critical owner path |
| G-8 | `touchHeartbeat` fan-out failure isolation | — | Never-throw contract unpinned |
| G-9 | `EscalationChain`: pause-first order, tenant-scoped target, offline/paused exclusion, takeover supersede, failed append still resets idle, budget path emits | AGT-017, AGT-018, AGT-021 | Zero tests for the whole class |
| G-10 | Socket `user:message` unscoped roster: foreign agent mention/trigger | AGT-003 | Isolation-critical; needs integration harness |
| G-11 | Channel pin validation with foreign-workspace agent id | AGT-004 | Route-level isolation |
| G-12 | workspace-sync agent writes invalidate roster cache | AGT-007 | Cross-domain cache contract |
| G-13 | setStatus on a synced agent (ledger row absent) | AGT-022 | Silent no-op path |
| G-14 | Two-workspace seedDefaultAgent on shared PG (id collision) | AGT-016 | Cross-tenant data collision |
| G-15 | Legacy null-scope row edited through a tenant (claim semantics) | AGT-023 | Silent re-scoping |
| G-16 | Dual-tier update/setStatus PG leg with per-workspace DB handles | AGT-001 | Split-DB deployments |
| G-17 | pgCatchNull: logic error propagates vs connection error degrades | AGT-010 | Error masking |
| G-18 | REST route behavior: 400 mapping for invariant violations; agent:resumed emit; 404 paths | — | No route tests in suite |

## Cross-domain test bypasses (check-gates TEST-ONLY, agent-related)

`channels/channel-local-mode.test.ts:23-24` → agent-service + agent-local-store; `events/events-integration.test.ts:79-80` → same; `modules/module-local-mode.test.ts:20` → agent-local-store; `runtime/local-chat-e2e.test.ts:24-25` → same; `workspace/workspace-canon.test.ts:30` → agent-local-store. Non-fatal today; route via gate when those files are next touched.

## Harness notes for future tests

- Local tier: `setLocalStoreDirForTests` fixture + `VITEST` env relaxes tenant guards; roster cache off by default under vitest, opt-in via `enableRosterCacheForTests`.
- Scripted-db fake exists in `agent-roster-cache.test.ts` (drizzle-chunk walker) — reusable for update/delete/setStatus semantics without a live PG.
- Real-PG integration pattern available in `runs/*.integration.test.ts` (skip when DATABASE_URL unset).
