# Database ensure and migrate
> Type: Flow · Status: aligned · Updated: 2026-09-13

## Intent
First launch (and every launch after) must leave the local Postgres migrated and seeded without manual steps — but a broken or missing database must never hard-crash the shell into silence; boot logs a warning and the app continues offline (DB-backed routes degrade) so the failure is visible in logs and recoverable by starting Postgres or running `db:push`.

## Architectural decision
The shape is three linked choices. First, migrate reuses the server's one-shot `db/bootstrap.js` (drizzle migrations + pgvector + seed) by forking it as a child process — never importing it, because it auto-runs `main()` on import `[Observed]` (`main/ensure-database.ts:4-12`). Second, the child runs with `ELECTRON_RUN_AS_NODE=1` so `fork()` under Electron behaves as plain Node identically in dev and packaged builds `[Observed]` (`main/ensure-database.ts:54-56`). Third, the result is a `migrated | skipped | failed` envelope with fail-open boot: `skipped` (empty URL / no bundle) and `failed` (timeout, non-zero exit, fork error) both log a warning and continue offline, instead of quitting or blocking on a dialog `[Observed]` (`main/ensure-database.ts:20-23`, `main/ensure-database.ts:27-97`, `main/index.ts:227-233`). The rejected alternative is visible: no in-process import, no blocking forever (120 s default timeout with kill + `unref`), no silent swallow (stderr tail kept) `[Inferred]`.

## How it works
`boot()` builds bootstrap candidates (`resourcesPath`, `getAppPath`, two `dist` relative paths) and awaits `ensureDatabase({ databaseUrl, bootstrapCandidates })`. `ensureDatabase` returns `skipped` when the URL is empty or no candidate exists on disk. Otherwise it forks the first existing bundle with `{ DATABASE_URL, ELECTRON_RUN_AS_NODE: "1" }`, captures a rolling stderr tail (2048 chars), and races the child against a timeout (default 120 s): timeout kills the child and yields `failed`; `error` yields `failed`; exit `0` yields `migrated`, anything else yields `failed` with the last 500 stderr chars (or a "is Postgres 16 running on 127.0.0.1?" hint). Boot logs a warn (`database unavailable, continuing offline`) and proceeds to start the embedded backend anyway.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Desktop Shell.md> | Owns the flow: `main/ensure-database.ts` (fork + timeout + envelope) and the boot call site (`main/index.ts:121-138`, `main/index.ts:227-233`) |
| Backend (server `db/bootstrap.js`) | Owns migration content: drizzle migrations + pgvector + seed, then exit |

## Current state
Real in both dev and packaged paths: candidate search, fork-as-Node, stderr tail, timeout kill, and fail-open offline continue (warn log, no blocking dialog) all run today. Default timeout 120 s; custom `timeoutMs` is supported by the function but boot does not pass one.

## Alignment notes
Cross-checked `main/ensure-database.ts:27-98` against `main/index.ts:121-138` (candidates) and `main/index.ts:227-233` (fail-open warn + continue): statuses, messages, and continuation semantics match. `README.md:52-56` first-run paragraph (120 s, error box + continue, `db:push`, pg_dump rollback) is stale on the dialog (now warn-and-continue) — desktop README update pending. No other drift found.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in Desktop Shell domain spec.
* First launch leaves local Postgres migrated and seeded without manual steps. Broken or missing DB never hard-crashes the shell into silence.
* Migrate reuses the server one-shot db/bootstrap.js by forking as a child with ELECTRON_RUN_AS_NODE=1, never importing it because it auto-runs main on import.
* Result is a migrated, skipped, or failed envelope with fail-open boot: skipped and failed log a warning and continue offline. Backend routes 500 until Postgres is up.
* Fail-open window has an explicit write-safety contract: no write path corrupts or half-initializes state against an unmigrated DB.
* Concurrent launches racing the same migrate are prevented by single-instance lock ordering versus boot, explicitly documented.
* timeoutMs has an explicit production value fitting large seed and migration runs on slow disks. Packaged skipped path has packaged-friendly guidance, never npm-only instructions. Authority: Desktop Shell domain standard.
## Open gaps
- DB-005 fixed 2026-10-07 (tooling policy): migrations after 0010 are hand-written; `meta/*_snapshot.json` stay frozen (0009 never emitted) and `drizzle-kit generate`/`push` must not run against this folder (would re-emit applied DDL). Journal tags <-> SQL files <-> snapshots consistency is enforced in CI by `src/db/db-migrations-consistency.test.ts` (hermetic); policy text in `src/db/migrations/README.md`.
- DB-009 fixed 2026-10-07 (tooling policy): the unwired `packages/server/scripts/check-single-db.mjs` guard is deleted — it was never in `lint:gates`/CI, and its FORBIDDEN list (getWorkspaceDb/runWithDb/ensureSchema/LEGACY_BOOTSTRAP) bans the record-only workspace-DB routing that is the documented current architecture (150+ live hits). Retirement pinned by `src/db/single-db-guard-retired.test.ts` (hermetic).
- DB-010 fixed 2026-10-07: `src/db` now executes tests without `DATABASE_URL` — `src/db/channel-sequences.hermetic.test.ts` pins the allocator contract (single atomic upsert, MAX(messages.sequence_number) seed, bigint->number, no-row error, local-first fallback); the 20-way concurrency invariant stays DB-gated in `channel-sequences.concurrency.test.ts` (CI).
- Fail-open means the backend starts against an unmigrated DB and routes 500 until Postgres is up (per README) — whether any write path can corrupt or half-initialize state in that window is unverified.
- Concurrent launches racing the same migrate (single-instance lock should prevent it, but lock timing vs `boot()` ordering) is unverified.
- `timeoutMs` is injectable but boot never sets it — whether 120 s fits large seed/migration runs on slow disks is unverified.
- The `skipped` "run npm run db:push manually" path in a packaged install (no npm) has no packaged-friendly guidance — UX gap, unverified intent.
