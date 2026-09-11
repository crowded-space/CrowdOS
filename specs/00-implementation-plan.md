# Implementation Plan — Local-First Rework Program

Index + master ordering for the six per-scope specs in this directory.
Decisions frozen with the user: **keep `workspace_id` scoping, kill BYODB remnants · JSON full replacement (writes to files) · FS mounts keep the Guard jail · local-first config covers both budget singleton and env flags.**

| # | Spec file | Scope | Risk |
|---|---|---|---|
| 1 | `01-workspace-creation.md` | One canonical creation entry point + storage handoff seam | Low-medium |
| 2 | `02-local-first-config.md` | `data/config.json` + `budget.json` + `secrets.json`, layered loader, hot counter stays Postgres (Option A) | Medium |
| 3 | `03-single-db.md` | Delete BYODB remnants, legacy DDL, dead flag; conformance check | Near-zero |
| 4 | `04-postgres-vectors.md` | Keeps-what matrix; formalize `embedding_vec` + HNSW; cut over non-vector readers | High (coupled with 05) |
| 5 | `05-json-catalog.md` | Agents/rosters/modules/skills/stacks → JSON files, full replacement, drop 10 tables | Highest |
| 6 | `06-fs-mounts.md` | Drop `workspace_nodes` mirror; real FS mounts; Guard jail kept | Medium-high |

## Master order

```
SPEC 03 (single-DB cleanup) ── hygiene, no dependencies, unblocks all
   │
SPEC 01 (workspace creation) ── one entry point + storage handoff seam
   │                                │
   │                          SPEC 06 (FS mounts) ── consumes the handoff seam
   │                                │
SPEC 02 (local-first config) ────────┤ (parallel-safe after SPEC 03)
                                    │
SPEC 04 (pgvector matrix) + SPEC 05 (JSON catalogs) ── LAST, as one migration
```

**Why this order:** 03 is zero-risk hygiene. 01 must precede 06 (creation defines the `rootPath`/status contract mounts depend on — otherwise creation gets rewritten twice). 02 is parallel-safe once 03 settles the DB contract. 04+05 are coupled (the keeps-what matrix) and highest-risk, so they go last with everything else stable beneath them.

## Frozen cross-spec contracts

1. **Gate shapes never change.** `AGENTS.md` domain-facade rule holds for the whole program: other domains import only via `*Gate.ts`. SPEC 05 pins gate export shapes with snapshot tests before any store work.
2. **`rootPath` absolute/canonical + status machine + `(workspace_id,path)` uniqueness** frozen by SPEC 01 for SPEC 06 (until SPEC 06 drops the nodes table via its own migration).
3. **Keeps-what matrix** (SPEC 04 §3.1): `agent_memory_notes`, `embedding_model_profiles`, `channel_index`, `compressed_summaries`, `memory_update_log` (+ cost view, `vector` ext) stay in Postgres. Must be signed by SPEC 05 + SPEC 02 owners before code.
4. **Budget counter stays Postgres** (SPEC 02 Option A). File holds caps only. No bare-JSON hot counter — ever (SQLite-WAL is the named escape hatch, not files).
5. **Secrets stay enveloped.** `enc:v1:` at rest in both DB columns and JSON files; `CREDENTIALS_ENCRYPTION_KEY` stays env-only, never on disk next to ciphertexts.
6. **Guard jail survives.** SPEC 06 keeps containment + blacklist; no `cwd` fallback; `deleteWorkspace` never `rm`s a mount.
7. **`CATALOG_BACKEND` / shadow-compare discipline** (SPEC 05): readers behind gates first, dark-read + dual-compare for a week, flag flip, then drop tables. No table drops before mismatch rate hits 0.

## Verification spine (every spec)

- `npx tsc -p tsconfig.json --noEmit` (from `packages/server/`)
- `npm run lint:gates` (`check-gates` + `check-redaction` + `check-events`, plus new `check-single-db.mjs` once SPEC 03 lands)
- Targeted suites per spec (each spec §6 lists exact files + new tests required)
- Full `npx vitest run` before each spec merge
- Real-DB integration tests need `DATABASE_URL` + migrated dev DB (`drizzle-kit migrate` + `db:seed`); memory unit tests run hermetic via fakes

## Known pre-existing conditions (do not mistake for regressions)

- `approvalFlow.integration.test.ts` (4 tests) and `toolExecutor.batch.test.ts` (1 test) fail identically on the clean tree (environmental: safety-verdict timing / RWP concurrency). `providerHttp` / `httpAgent` / `ratelimit` are flaky under load, green in isolation.
- `drizzle-kit generate` is broken (meta snapshot collision: `0010` points at `0008`'s parent, `0009` snapshot missing). Runtime `migrate` works via hand-maintained journal entries; repair the snapshot chain before relying on `generate` (SPEC 03 or a drive-by fix).
- `packages/server/.env` is gitignored and required for DB-backed tests; dev values: `DATABASE_URL=postgresql://postgres:nemoid148@localhost:5432/CrowdOS`.
- Migration numbering: `0011_workspace_scoping` is taken; the next specs' migrations (`0012_drop_catalog_tables`, `0012_vectors_formalize`) must coordinate numbering at implementation time.
