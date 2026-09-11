# SPEC 3 — Single DB for All Workspaces (remnant cleanup)

## 0. Status & convention

- **Decision (frozen):** Single shared Postgres DB is reality. Multi-tenancy is column-scoped via `workspace_id` FKs. This spec does **remnant cleanup only**.
- **Gate rule:** No domain import changes in this spec. `Shared/config`, `db/*`, `routes/*` are exempt shared/infra paths.

---

## 1. Goal & non-goals

### 1.1 Goal

Kill dead per-workspace-BYODB remnants while leaving the single-DB + `workspace_id` tenancy model byte-for-byte intact:

1. Delete the orphan `CROWDOS_WS_*_DATABASE_URL` env line (currently a silent no-op).
2. Delete legacy bootstrap DDL (`db/bootstrap.ts:ensureSchema` behind `LEGACY_BOOTSTRAP=true`) that predates `workspace_id` columns and has drifted from `schema.ts` + migrations `0000→0011`.
3. Correct stale docs/comments that still describe per-workspace databases, `DATABASE_URL + auto push`, or `.env` persistence.
4. Add a conformance check forbidding reintroduction of `CROWDOS_WS_*` / `getWorkspaceDb`-style helpers.

### 1.2 Non-goals (explicitly: tenancy stays)

- **No change** to column-scoped tenancy: `0011_workspace_scoping.sql`, `schema.ts` `workspaceId` columns/FKs/indexes, `WorkspaceManager`, `workspaceContext.ts` all stay.
- **No change** to the singleton connection model: `Shared/config/database.ts:getDb` / `getSqlClient` stays the only pool. No new pools, no sharding, no per-tenant connections.
- **No change** to the single `DATABASE_URL` contract: `Shared/config/env.ts:83`, `drizzle.config.ts`, `docker-compose.yml`, CI workflows stay single-URL.
- **No behavior change** to workspace lifecycle, VFS bootstrap (`index.ts`), seed (`db/seed.ts`), or `workspace_id` backfill semantics.
- **No rewrite** of historical audit docs (`Workspace Flow Audit.md`, `TO DO/AUDIT_REPORT.md`, `AUDIT_REPORT_2026-08-26.md`, `REMEDIATION_SPEC.md`) beyond adding a banner / leaving them as history. Do not falsify history.

---

## 2. Current state with file:line

### 2.1 Single-DB reality (keep)

Single pool, single `drizzle` instance, single URL: `Shared/config/database.ts` singletons (`7-8`), `requireDatabaseUrl()` (`10-16`), `getSqlClient()` (`18-31`), `getDb()` (`33-41`), `withTransaction` (`55-57`), `ensurePgVectorExtension` (`59-76`), `closeDatabaseConnection` (`78-84`). No `getWorkspaceDb`, no `workspaceDb`, no `CROWDOS_WS_*` reference anywhere in `packages/server/src` (verified by grep).

`Shared/config/env.ts:83` single `DATABASE_URL`; `drizzle.config.ts:6-15` single-URL migrate path; `docker-compose.yml:39,70` api+worker share one Postgres; CI workflows single-DB. Tenancy = `0011_workspace_scoping.sql` columns + FKs + indexes in the shared DB (`categories`/`channels`/`messages` NOT NULL+FK+index, `durable_events` nullable, `runs` NOT NULL).

`index.ts:136-171` boot enumerates **rows** in one DB and initializes on-disk VFS dirs. `db/seed.ts` writes rows into the shared DB.

### 2.2 BYODB / per-workspace-DB remnants (the only things this spec deletes/fixes)

#### A. Root `.env` orphan — the headline remnant

Repo-root `.env` (gitignored, local-only but the onboarding source of confusion):

```text
# Per-workspace databases (BYODB) — managed by Crowd OS.
CROWDOS_WS_WS_2EFFDDFE7591_DATABASE_URL="postgresql://postgres:nemoid148@localhost:5432/CrowdOS"
```

- `CROWDOS_WS_*` → **zero hits in indexed source**. `BYODB` → zero hits outside that `.env` line. `getWorkspaceDb|workspaceDb|runWithDb|createWorkspaceDb` → zero hits in `packages/server/src` (only audit-doc mentions plus one false positive: `maintenanceWorker.ts:190` comment about per-workspace socket fanout — column-scoped, keep).
- Impact today: value duplicates `DATABASE_URL` (same host/db), is never read (no `process.env.CROWDOS_WS_*`, no `env.*` field, no `getWorkspaceDb`), and is invisible to `CONFIG_STRICT` (matches neither schema keys nor project prefixes) — a dev who edits it gets a silent no-op.

#### B. Legacy bootstrap DDL — `ensureSchema` predates `workspace_id` scoping

`packages/server/src/db/bootstrap.ts`:

- `27-28` legacy comment + `28-494` entire `ensureSchema()` (enums, 40+ tables, post-table statements).
- `496-507` `main()`: `LEGACY_BOOTSTRAP=true` → hand-rolled `ensureSchema()`, else `migrate()+ensurePgVector()+seed()`.

Gaps vs current truth (why it must be deleted, not fixed):

1. **Missing `workspace_id` tenancy columns:** `categories`, `channels`, `messages` DDL has **no** `workspace_id` at all vs `schema.ts` + `0011` (`NOT NULL + FK cascade + indexes`). A DB built via legacy path cannot satisfy any scoped query/seed.
2. **Missing entire tables:** `runs`, `durable_events`, `swarm_tasks`, `delegations`, `approval_requests`, `api_keys`, `runs_compensation`, plus post-`0004` columns/indexes.
3. **Stale enums/columns:** missing `swarm_task_status`, `approval_status`, `approval_risk_class`, `run_status`; `artifact_type` lacks newer values; `messages` lacks `metadata/tool_calls` drift.
4. **Config bypass bug:** reads raw `process.env.LEGACY_BOOTSTRAP` instead of zod-parsed `env.LEGACY_BOOTSTRAP`.
5. **Dead-flag surface:** `LEGACY_BOOTSTRAP` appears in `.env.example`, `env.ts`, `env.test.ts`, `docs/environment.md`, `DEVELOPMENT_BOARD.md`, `REMEDIATION_SPEC.md`, `Identifier_Index.md`. All become dead after deletion.

#### C. `POST /api/workspace/database` — keep code, fix stale narrative

`routes/workspace.ts:148-209` is **single-DB verify-only** (in-memory hot-test, `NOT persisted`), not BYODB provisioning — gated by `ENABLE_DB_CONFIG_MUTATION` + `WORKSPACE_ADMIN_TOKEN`. **Do not delete the route** — `WorkspacePortal.tsx` + `crowd-os-store.ts` depend on it for the onboarding Test Connection step.

What *is* stale: doc/UX strings saying `Set DATABASE_URL + auto push`, `URL saved to .env`, `schema push flow` — those get reworded to `verify-only; NOT persisted`.

#### D. Docs/comments that still say per-workspace databases

- **HISTORY (banner optional, never rewrite):** `Workspace Flow Audit.md` (`getWorkspaceDb` diagrams), `TO DO/AUDIT_REPORT.md`, `AUDIT_REPORT_2026-08-26.md`, `REMEDIATION_SPEC.md`, `DEVELOPMENT_BOARD.md`.
- **STALE (edit):** `docs/03_Technical_Project_Structure.md` (`auto schema push` cells), `docs/implemented-backend/01-overview.md` + `03-api-sockets.md` + `05-types-config.md` (schema-push wording), `docs/implemented-frontend/*` (onboarding DB copy), `docs/UI Spec/ui_frontend_spec.md`, `docs/LV2_Workspace_Settings_Providers.md` (`Auto Schema Push`), `execution-plan/02-database-and-schema.md`, `packages/client/Specs.md`, `crowd-os-store.ts:1777` comment, `WorkspacePortal.tsx:55-69` fake staged logs (`URL saved to .env` is false), `Identifier_Index.md`.
- **FALSE POSITIVES (keep):** `maintenanceWorker.ts:190`, `index.ts:142`, `create-workspace-crowdos.ts:12`, e2e/perf specs, column-scoped table docs.

---

## 3. Target design

### 3.1 Exact deletion/edit list

**D1. Root `.env` — delete 2 lines (local file, gitignored, safe to edit directly).**

- Delete the BYODB comment + `CROWDOS_WS_WS_2EFFDDFE7591_DATABASE_URL` lines. Keep `PORT`, `CLIENT_ORIGIN`, `DATABASE_URL`, `LOCAL_PIN` byte-identical. Optionally add a one-line comment in `.env.example`: `# NOTE: CROWDOS_WS_*_DATABASE_URL is not read. Single shared DB only.`

**D2. `packages/server/src/db/bootstrap.ts` — delete legacy DDL branch.**

- Delete the legacy comment + entire `ensureSchema()` (`27-494`).
- Rewrite `main()` (`496-507`) to migrate-only:
  ```ts
  async function main(): Promise<void> {
    await applyMigrations();
    await ensurePgVectorExtension();
    await seed();
    console.log("Database migrations applied and seed data ensured.");
  }
  ```
- Prune imports: remove `getSqlClient` (keep `closeDatabaseConnection, ensurePgVectorExtension`).
- Result: `db:push` becomes `migrate + ensureVector + seed`. Do **not** rename the npm script in this spec (would churn `package.json`, CI, e2e, docs).

**D3. `LEGACY_BOOTSTRAP` flag — delete end-to-end (dead after D2).**

- `Shared/config/env.ts` — delete the `LEGACY_BOOTSTRAP` field. Keep `LEGACY_GUARD` (unrelated tool-guard flag) and keep `LEGACY_` in project prefixes (still needed for `LEGACY_GUARD`).
- `.env.example` — delete the `LEGACY_BOOTSTRAP` lines.
- `Shared/config/env.test.ts` — delete the `LEGACY_BOOTSTRAP` expectation.
- Regen `docs/environment.md` via `gen:env-doc` (drops the row).
- Docs close-out (one line each): `DEVELOPMENT_BOARD.md`, `REMEDIATION_SPEC.md` (legacy window closed), `Identifier_Index.md` (drop prefix).

**D4. `POST /api/workspace/database` — KEEP endpoint, fix narrative (no code deletion).**

- Keep handler + `ENABLE_DB_CONFIG_MUTATION` + `.env.example` docs as-is (verify-only admin escape hatch).
- Tighten two comments only: state `verify-only (in-memory hot-test, NOT persisted; restart with rotated .env to persist)`; note the raw `process.env` read is an intentional pre-config gate.
- Fix the one false UX string: `WorkspacePortal.tsx` `Connection verified — URL saved to .env` → `Connection verified — NOT saved. Update .env and restart to persist.`
- Reword stale table/paragraph cells (minimal diffs, keep endpoints).

**D5. Conformance check — new `packages/server/scripts/check-single-db.mjs`, wired into `lint:gates`.**

- Do **not** bolt DB-env patterns into `check-gates.mjs` (import-graph lint; mixing content patterns weakens both). Add a sibling script in the `check-redaction.mjs` style.
- Forbidden patterns (case-sensitive except noted), scanned over repo root excluding `node_modules/`, `dist/`, `.git/`, `_archive/`, `test-results/`, `playwright-report/`:
  ```js
  const FORBIDDEN = [
    /CROWDOS_WS_[A-Z0-9_]*_DATABASE_URL/,   // orphan BYODB var (any workspace id)
    /BYODB/i,                                // bring-your-own-db narrative
    /\bgetWorkspaceDb\b/,                    // per-DB accessor
    /\bworkspaceDb\b/,                       // per-DB handle
    /\brunWithDb\b/,                         // per-DB context helper
    /\bcreateWorkspaceDb\b/,
    /\bensureSchema\b/,                      // legacy DDL entry point (after D2)
    /LEGACY_BOOTSTRAP/,                      // dead flag (after D3)
  ];
  ```
- Intentionally **not** forbidden (avoid false positives): per-workspace snapshot comments, hot-reload/HMR, generic `workspace.*database` prose, `DATABASE_URL` alone, `ENABLE_DB_CONFIG_MUTATION`, `WORKSPACE_ADMIN_TOKEN`, provider-key Test Connection flows.
- History exemption: allow matches inside the audit/board/spec history docs **only** if those files carry a one-line banner (`> Historical: database-per-workspace was evaluated and rejected. Single shared DB + workspace_id scoping is current.`). Fail if pattern found in a history file without banner.
- Wire: `packages/server/package.json` `lint:gates` → append `&& node scripts/check-single-db.mjs`. Root inherits.

**D6 (recommended, 1 line). Make the orphan loud if it ever returns.**

- Append `"CROWDOS_"` to `PROJECT_ENV_PREFIXES` in `env.ts`. Effect: any future `CROWDOS_WS_*_DATABASE_URL` becomes an **unknown project var** and fails boot under `CONFIG_STRICT=true` (default) instead of a silent no-op. Zero effect when the var is absent. Alternative: dedicated denylist error in `loadEffectiveConfig` — same outcome, more code; prefer the one-line prefix.

### 3.2 What stays untouched (explicit)

- `database.ts` singleton, `withTransaction`, `ensurePgVectorExtension`, `closeDatabaseConnection`.
- All `workspace_id` columns/FKs/indexes, `0011` migration, `seed.ts` default-workspace/category/channel/mount logic.
- `WorkspaceManager`, `workspaceContext.ts`, `index.ts` bootstrap, `create-workspace-crowdos.ts`.
- `DATABASE_URL`, `WORKSPACE_ADMIN_TOKEN`, `ENABLE_DB_CONFIG_MUTATION` semantics.
- `LEGACY_GUARD` anywhere.

---

## 4. Expected files touched

| # | File | Change |
|---|---|---|
| 1 | `.env` (gitignored, local) | Delete BYODB comment + `CROWDOS_WS_*` line. |
| 2 | `packages/server/src/db/bootstrap.ts` | Delete `ensureSchema` + simplify `main()` to migrate-only; prune `getSqlClient` import. |
| 3 | `packages/server/src/Shared/config/env.ts` | Delete `LEGACY_BOOTSTRAP`; optionally add `CROWDOS_` prefix (D6). |
| 4 | `.env.example` | Delete `LEGACY_BOOTSTRAP` lines; optional `CROWDOS_WS_* not read` note. |
| 5 | `packages/server/src/Shared/config/env.test.ts` | Delete `LEGACY_BOOTSTRAP` expectation. |
| 6 | `packages/server/scripts/check-single-db.mjs` | **New** forbidden-pattern lint (D5). |
| 7 | `packages/server/package.json` | Append `&& node scripts/check-single-db.mjs` to `lint:gates`. |
| 8 | `docs/environment.md` | Regen via `gen:env-doc` (drops row). Do not hand-edit. |
| 9 | `packages/server/src/routes/workspace.ts` | Comment-only clarifications. No logic change. |
| 10 | `packages/client/components/portal/WorkspacePortal.tsx` | Copy-only: NOT-persisted fix + shared-DB qualifier. |
| 11 | `packages/client/stores/crowd-os-store.ts` | Comment-only handshake reword. |
| 12 | Stale-doc cells (batch) | `docs/03_Technical_Project_Structure.md`; `docs/implemented-backend/01-overview.md`, `03-api-sockets.md`, `05-types-config.md`; `docs/implemented-frontend/*`; `docs/UI Spec/ui_frontend_spec.md`; `docs/LV2_Workspace_Settings_Providers.md`; `execution-plan/02-database-and-schema.md`; `packages/client/Specs.md`; `Identifier_Index.md`. Qualifier edits only. |
| 13 | History banners (optional) | One-line banner on audit docs if the check-script history gate requires it. No content deletion. |
| 14 | Close-out lines | `DEVELOPMENT_BOARD.md`, `REMEDIATION_SPEC.md` mark legacy window closed. |

Not touched: `database.ts`, `schema.ts`, `migrations/*` (incl. `0011`), `workspaceManager.ts`, `workspaceContext.ts`, `index.ts`, `seed.ts`, `create-workspace-crowdos.ts`, `drizzle.config.ts`, `docker-compose.yml`, CI workflows, `LEGACY_GUARD` anywhere.

---

## 5. Ordered steps

1. **Backup + snapshot.** `cp .env .env.bak.spec3` (local, gitignored). Record `git status --short`, `git log --oneline -5`, and `rg --hidden -n "CROWDOS_WS_|BYODB|getWorkspaceDb|runWithDb|LEGACY_BOOTSTRAP|ensureSchema" .` output as pre-change evidence.
2. **Delete the orphan env lines.** Remove the 2 BYODB lines. Verify shell no longer exports it. Keep `DATABASE_URL` byte-identical.
3. **Delete `ensureSchema`.** Apply D2. Confirm no remaining `ensureSchema` / `LEGACY_BOOTSTRAP` in `src/`.
4. **Delete the `LEGACY_BOOTSTRAP` flag.** Apply D3. Regen env doc and confirm the row disappears.
5. **Clarify (no logic change).** Apply D4 comment/copy edits.
6. **Batch the stale-doc qualifiers.** Row-12 edits, minimal diffs, no restructuring.
7. **Add the loud-orphan prefix (D6).** Append `"CROWDOS_"` to prefixes, regen doc, verify a test `CROWDOS_WS_FOO=…` fails fast (then unset it).
8. **Add + wire the conformance check (D5).** Create script (dependency-free, same walker shape as sibling checks), wire into `lint:gates`, add history-banner gate. All four checks green.
9. **Verify (§6).** Grep-zero suite, `typecheck`, targeted tests, `db:check` + empty-DB migrate+seed dry run.
10. **Close out.** Update board/spec close-out lines, delete `.env.bak.spec3` after green run.

---

## 6. Verification

### 6.1 Grep-zero checks (must all pass; use `rg --hidden` so `.env` is covered)

```sh
# 1. Orphan var + narrative — zero anywhere including dotfiles
rg --hidden --no-ignore -n "CROWDOS_WS_|BYODB" .
# expect: no output (pre-change: only .env BYODB lines)

# 2. Per-DB helpers — zero outside exempt history docs
rg --no-ignore -n "getWorkspaceDb|workspaceDb|runWithDb|createWorkspaceDb" --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**' --glob '!_archive/**' .
# expect: only bannered history-doc hits, zero in packages/*/src, scripts/**

# 3. Legacy DDL + dead flag — zero everywhere
rg --no-ignore -n "ensureSchema|LEGACY_BOOTSTRAP" --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**' --glob '!_archive/**' .
# expect: no output

# 4. No collateral: single-DB contract still present
rg -n "DATABASE_URL" packages/server/src/Shared/config/env.ts packages/server/src/Shared/config/database.ts packages/server/drizzle.config.ts docker-compose.yml .env.example
# expect: hits retained (proves we removed the orphan, not the contract)
```

Note: IDE grep tools typically exclude dotfiles — re-running without `--hidden` reproduces the misleading `No files found` for `CROWDOS_WS_`/`BYODB`. The `rg --hidden` runs above are the acceptance gate.

### 6.2 Typecheck, lint, tests

```sh
npm run typecheck --workspace @community-agent/server
npm run lint:gates --workspace @community-agent/server
# expect: check-gates OK, check-redaction OK, check-events OK, check-single-db OK

npx vitest run src/Shared/config/env.test.ts
# expect: pass after deleting LEGACY_BOOTSTRAP assertion
```

### 6.3 DB behavior (single shared DB, migrate-only)

```sh
npm run db:check --workspace @community-agent/server
# expect: pass on dev DB

# Empty-DB dry run (throwaway database, never dev):
# createdb crowdos_spec3_empty && DATABASE_URL=..._empty npm run db:push
# expect: migrations 0000→0011 apply, seed creates workspaces(id='default'),
# workspaceSettings(id='default'), #general; LEGACY_BOOTSTRAP=true now inert
```

### 6.4 Targeted regression (no full-suite required)

- Onboarding Test Connection: `POST /api/workspace/database` without admin token → `403`; with flag+token → `200 {success:true, NOT persisted}` and `getDb` still serves settings.
- `channelSequences`, `messagePagination`, `runsRepository`, `approvals` integration tests — all construct `postgres(process.env.DATABASE_URL…)` directly; unaffected.

---

## 7. Risks & rollback

| Risk | Likelihood / blast radius | Mitigation / rollback |
|---|---|---|
| Dev relied on `CROWDOS_WS_*` | **Near-zero.** Never read; value duplicated `DATABASE_URL`. | Backup `.env→.env.bak.spec3`. Rollback = restore two lines. D6 makes re-added vars fail fast. |
| Someone still boots with `LEGACY_BOOTSTRAP=true` | **Low, loud.** Legacy path gone; var unknown. A legacy-built DB is already broken on current schema/seed. | Rollback = `git revert` the `bootstrap.ts` deletion. Forward fix = `drizzle-kit migrate` to `0011`. |
| `POST /api/workspace/database` consumers surprised by copy change | **Near-zero.** No status/auth change; only success-string gains `NOT saved`. | Rollback = revert copy commit. |
| History-doc banner gate annoys auditors | **Near-zero.** Banner-only, no content deletion. | Exempt additional paths only with reviewer sign-off. |
| `.env` is gitignored — reviewer can't diff it | **Process, not prod.** CI/prod never saw the var. | PR includes `rg --hidden` before/after output + `.env.example` note as reviewable proxy. |

Overall risk: **near-zero**. Every deletion is of dead code/data (zero live readers) or a flag whose live path is already broken. No migration, no data movement, no tenancy-semantics change. Full rollback is `git revert` + restore `.env.bak.spec3`.

---

## 8. Dependencies

- **None.** No other spec blocks this; this spec blocks nothing functionally.
- **Unblocks as hygiene:** every future DB/workspace change no longer needs an `is this per-workspace or shared?` preamble — the answer is checked in by `check-single-db.mjs`.
- **Follow-ups explicitly out of scope:** (a) deleting `POST /api/workspace/database` + `ENABLE_DB_CONFIG_MUTATION` entirely; (b) renaming `db:push→db:migrate`; (c) rewriting `WorkspacePortal`/`crowd-os-store` client workspace stubs; (d) removing `LEGACY_GUARD`; (e) moving audit docs to `_archive/`. Each is standalone — file separately if wanted.
