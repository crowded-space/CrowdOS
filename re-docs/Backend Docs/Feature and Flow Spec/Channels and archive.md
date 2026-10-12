# Channels and archive

> Type: Feature · Status: aligned · Updated: 2026-10-09

## Intent

Workspace chat needs stable topology — named channels grouped under categories — where removing a channel from daily view does not destroy its history or break direct links. This feature exists so channel identity stays guarded (valid categories, no confusing duplicates), listings stay clean (archived rows hidden), and the one channel everything assumes exists (`#general`) can never be hard-deleted.

## Architectural decision

Business failures return unions (`{ error }` / `{ notFound }` / `{ conflictGeneral }`) instead of throwing, because they map to caller-branchable HTTP statuses (400/404/409) rather than exceptions `[Observed]`. Archive is a `type` transition that stamps `archivedAt` (any other type clears it), giving single-field UX without a separate archive column write path `[Observed]`. Listings hide `archivedAt IS NOT NULL` rows while `get` does not, so rosters stay clean but direct links and admin reads still resolve archived rows `[Observed]`. The `#general` guard keys on `(categoryId null + name general, case-insensitive)` rather than a fixed id, so the default channel survives regardless of which row it is `[Observed]`. Listing paginates by keyset `(position, id)` with a numeric-offset fallback. Local/PG union reads derive active page rows and all scoped Local IDs (including archived) from one Local snapshot, then fetch PG candidates in pages of at most 200 and check each bounded page against that set; no Local IDs are bound into PG SQL. The PG tuple cursor advances until the merged target page is safely filled or PG is exhausted. Union numeric offsets retain merged-list semantics through 10,000; larger offsets return HTTP 400 with keyset guidance. Successful explicit `db` reads keep PostgreSQL's uncapped OFFSET behavior; a schema-mismatch fallback enters the capped union path. This avoids repeated Local-file scans and oversized bind lists while preserving Local precedence and archived-row shadowing. Every op takes an optional `db` override so routes and tests can pin a workspace DB without ambient state `[Observed]`.

## How it works

`channelGate.list` queries non-archived rows ordered `(position asc, id asc)`. For Local/PG union reads, valid `pos:id` cursors are applied to each tier. One Local read supplies both active page rows and all workspace-scoped IDs, including archived rows. PG candidates arrive in batches of at most 200 and each batch is checked against that in-memory set; no Local IDs are bound into PG SQL. Archived Local state suppresses stale PG replicas without repeated full-file scans. The service advances the PG tuple cursor until the merged target page is full and every earlier PG candidate has been considered, or PG is exhausted. Bare numeric cursors retain merged-list offset handling through offset 10,000 on the union path; larger union offsets return HTTP 400 with keyset guidance. A successful explicit `db` handle retains uncapped PostgreSQL OFFSET behavior; if its query fails for schema mismatch, the request falls back to the capped union path. `GET /api/channels` passes `cursor ?? offset` through (`channelRoutes`). Create checks category existence (workspace-scoped) plus a duplicate `(lower(name), categoryId, workspaceId, non-archived)` lookup on both tiers in parallel, returning `{ error: category }` or `{ error: duplicate_name }` before any write, then `dualWrite`s with a fresh UUID. Update runs the same duplicate guard for renames, returns `{ notFound: true }` on a miss, patches only supplied fields, and stamps or clears `archivedAt` on `type` change. Settings PATCH validates the pin, then `dualWrite`s local-first (outbox on PG failure). Delete returns `{ notFound: true }` on a miss, `{ conflictGeneral: true }` for uncategorized `general`, else hard-deletes. Routes map these unions to 400/404/409 (delete to 204, unknown-channel settings to 404) and emit `workspace:sync` themselves — nothing is emitted in-domain. A local guard-failure union never reaches the PG replica leg (`dualWrite` CHN-033), so PG holds no phantom rows for API-rejected writes.

## Components involved

| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Channels.md> | Owns `channels` rows: category-existence and duplicate-name guards, keyset listing excluding archived rows, archive-via-`type` stamping, and hard delete with `#general` protection |

## Current state

Real: category-guarded create/update (workspace-scoped parent check, CHN-007), duplicate-name guard on create AND rename (case-insensitive, archived-excluded, both tiers — CHN-001/002/003), missing-id `{ notFound }` returns, archive stamping via `type`, `#general` delete conflict, keyset plus numeric-offset listing through 10,000 (deeper pages use keyset cursors), `db` overrides on every op. Settings pins commit local-first through `dualWrite` with `channelSettings` outbox replay + push/pull sync legs (CHN-008/009/032) and the local guard-failure union skips the PG leg (CHN-033). Transport-thin: validation lives in Zod schemas, HTTP mapping and `workspace:sync` emission live in routes, room admission in sockets. CHN-004 fixed: `duplicate_name` answers 409 while category errors answer 400, so HTTP callers can branch without reading the union.

## Alignment notes

- Resolved 2026-10-07 (fix-channels): the duplicate guard is now genuinely case-insensitive on both tiers (SQL `lower()` on both sides, CHN-002), covers renames (CHN-001), excludes archived rows on both tiers (CHN-003), and a local guard-failure union skips the PG replica leg (CHN-033). Regression coverage: `channel-local-mode.test.ts`, `channel-dual-mode.test.ts`, `channel-routes.test.ts`.
- Resolved 2026-10-09: Local/PG listing derives active rows and archived-inclusive IDs from one scoped Local snapshot, checks bounded PG candidate pages against the in-memory set, then advances the `(position, id)` cursor until the merged page is safe or PG is exhausted. Numeric offsets on the union path retain merged semantics through 10,000; larger offsets reject at the service and REST returns 400 with keyset guidance. Successful explicit DB offsets remain uncapped, while explicit-handle schema mismatch falls back to the capped union. Regression coverage: `channel-local-mode.test.ts`, `channel-dual-mode.test.ts`, and `channel-routes.test.ts`.
- Verified consistent: archive stamp/clear on `type` change, the `#general` guard predicate, union-to-HTTP mappings in routes, and no in-domain broker import all match the domain doc.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Keyset listing plus offset fallback stays. Archive stamp and clear on type change stays.
* Identity is case-insensitive at DB level with uniqueness on lower(name) plus categoryId.
* Renames run the same duplicate guard as creates. Unguarded rename is forbidden.
* Delete path is explicit hard-delete with cascade or archive-via-type. Authority: Channels standard.
## Open gaps

- `create` stores `body.name` verbatim while comparing lowered, so casing is preserved but identity is fuzzy — display-vs-identity intent unverified.
- `delete` is hard-delete with cascade to messages/sequences/indexes; whether hard-delete vs archive-via-`type` is the intended operator path is unverified.
- `position` has no uniqueness or reorder helper; concurrent creates at default `position 0` ordering behavior is unverified.
- `ChannelIndex` / `CompressedSummary` types are exported with no reader/writer in the folder — possibly stale contracts.
- `channels.workspaceId` and `channels.folderPath` are never written by this domain; their writers split ownership with Channel-Mounts — see `Channel mounts.md`.
- CHN-010 partial: unresolved settings scope warns then degrades to `"default"`; reject/retry semantics are still unimplemented.
- Unprovisioned tenant schema (stale BYODB, 42P01/42703) falls through explicit-handle list/get/create/update/delete/settings/category reads and writes to the local-first path instead of 500 (2026-10-08); PG replica legs still converge via the outbox once the database is provisioned.
