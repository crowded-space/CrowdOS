# Migrations policy (hand-written after 0010) — DB-005

`_journal.json` (idx 0..28) and the `*.sql` files are the source of truth and
are kept in lockstep. Since `0010_perf_p2_ux`, migrations are **hand-written**;
the `meta/*_snapshot.json` files are intentionally frozen at 0010 (0009 was
never emitted) and are **not** regenerated. Do **not** run
`drizzle-kit generate`/`push` against this folder: it would diff against the
stale 0010 snapshot and re-emit already-applied DDL (duplicate/conflicting
statements on fresh and migrated DBs alike).

Rules:
- Never edit an applied migration; schema changes go into a new kebab-case
  `NNNN_slug.sql` **plus** a matching `_journal.json` entry (next idx, `when`
  > previous, `breakpoints: true`).
- Prefer idempotent DDL (`IF EXISTS` / `IF NOT EXISTS` / duplicate guards) so a
  retried pending batch heals.
- Consistency is enforced in CI by `src/db/db-migrations-consistency.test.ts`
  (journal tags <-> sql files <-> snapshots). Run it via `npx vitest run src/db`.

Rationale and history: audit/domains/db/bug-ledger.csv (DB-005); drizzle-kit
generate output must stay empty-diff because these files are hand-managed.
