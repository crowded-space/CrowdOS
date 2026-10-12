# Artifacts

## Purpose
Durable artifact store for run and workspace outputs. It owns `artifacts` rows, emits creation/update events for observability and client sync, serves truncated listings (full blobs only via `getById`), and purges expired rows via retention sweep.

## Feature Scope
In-scope:
- Artifact row insert + fetch (`artifacts` table, `art_` prefixed ids).
- Truncated listings by run, workspace, and run+type (500-char `patch`/`contentRef` cap).
- Time-based hard purge + `RETENTION_DAYS` retention sweep.
- Creation/update event emits (`diff.created` vs `artifact.created` + always `artifact.updated`).
Non-goals (other domains):
- Execution, diff computation, hash chaining → Runtime (`coding-runtime.ts`, `research-runtime.ts`, `swarm-runtime.ts` build `beforeHash/afterHash/patch/contentRef`).
- Run lifecycle, checkpointing, resume → Runs (`runsGate`; artifacts only reference `runId`).
- Workspace lifecycle/sharding → Workspace (owns `workspaces` rows; artifacts only FK to them).
- Transport (REST query validation, auth) → Routes (call `artifactsGate`, never contain logic).

## Expect
- `[Observed]` `create` always emits after insert; emit failure never fails the insert (try/catch swallow).
- `[Observed]` Canon (2026-09-22): `create` first writes the artifact BODY to the workspace's `artifactDir` — `<workspaceFolder>/vfs/artifacts/<runId>/<artifactId>.<ext>` — and stores the FOLDER-RELATIVE path in `artifacts.path`. `artifactDir` comes from the workspace record (default `vfs/artifacts`); an absolute or traversal value falls back to the canon default, so generation can never write outside the workspace folder.
- `[Observed]` The file write is best-effort: a filesystem failure does not fail artifact creation (the DB row remains a valid pointer, and the panel reports the missing file honestly). An artifact with no body (`contentRef`/`patch` both absent) writes no file and keeps `path` as given.
- `[Observed]` `diff` type emits `diff.created`; every other type emits `artifact.created`; every create additionally emits `artifact.updated`.
- `[Observed]` Listings truncate `patch`/`contentRef` to 500 chars in SQL; callers must use `getById` for full bodies.
- `[Observed]` Listing limits clamp to 1–200 (default 200) and offsets clamp to 0–10000; `listByRunAndType` is fixed limit 200 with no paging.
- `[Observed]` `purgeExpired(before)` hard-deletes `createdAt < before` and returns the count; `runRetentionSweep` derives `before` from `RETENTION_DAYS`.
- `[Observed]` 2026-10-12 local-first: `create` commits the file body plus a `<workspaceFolder>/vfs/.crowdos/artifacts.json` index row FIRST (`artifact-local-store.ts`); the DB insert is a best-effort replica. `create`/`getById`/`listByRun`/`listByWorkspace` serve the local index when `DATABASE_URL` is unconfigured, and degrade to it on connection-class PG failures (`isConnectionError`); other DB errors still throw. `create_artifact` therefore works in local-mode and DB-mode with an unchanged `ArtifactRow` shape. Local listings keep DB parity (500-char blob cap, 1–200 limit, 0–10000 offset, `createdAt desc`).
- `[Inferred]` `create` is not idempotent — each call mints a new `art_<rand>_<time>` id, so caller retries duplicate.

## Flow
1. Produce: runtimes compute `beforeHash/afterHash/patch/contentRef` then call `artifactsGate.create({ runId, workspaceId, producerAgent, type, path, beforeHash, afterHash, patch, contentRef, semanticTags, metadata })` (`artifacts-repository.ts:87`; callers `coding-runtime.ts:227`, `coding-runtime.ts:360`, `research-runtime.ts:537`, `swarm-runtime.ts:231`, `delegation-service.ts:90`).
2. Insert: repository mints `art_<8hex>_<base36time>` id and inserts with `createdAt = now` (`artifacts-repository.ts:89`); `workspaceId` FK cascades from `workspaces`, `runId` FK cascades from `runs` (`schema.ts:519`, `schema.ts:526`).
3. Emit: after insert, dynamic `EventBroker` emits `diff.created` for `diff` else `artifact.created`, then always `artifact.updated`, with `{ runId, artifactId, artifactType, workspaceId }` plus `channelId` from `metadata.channelId` (`artifacts-repository.ts:123-128`, `artifacts-repository.ts:123-128`); failures swallowed (`artifacts-repository.ts:130`).
4. Fetch one: `getArtifactById` selects by id, `null` on miss, full blobs intact (`artifacts-repository.ts:134-137`); `GET /api/artifacts/:id` maps miss to 404 (`routes/artifacts.ts:50`).
5. List by run: `listArtifactsByRun(runId, { limit, offset })` selects explicit columns with `substring(patch/contentRef, 1, 500)`, filters `runId`, orders `createdAt desc` (`artifacts-repository.ts:140-152`); `GET /api/artifacts?runId=` and `GET /api/runs/:id/artifacts` wrap it (`routes/artifacts.ts:38`, `routes/artifacts.ts:60`).
6. List by workspace: same truncated projection filtered by `workspaceId` (`artifacts-repository.ts:156`); `GET /api/artifacts?workspaceId=` wraps it, 400 when neither filter given (`routes/artifacts.ts:42`).
7. List by run+type: no dedicated repository port exists (`listArtifactsByRun` takes only `{ limit, offset }`, `artifacts-repository.ts:140-152`); no route exposes it — runtime/internal use only.
8. Purge: `purgeExpiredArtifacts(before)` hard-deletes `createdAt < before` returning ids count (`artifacts-repository.ts:171-174`).
9. Retention sweep: `runArtifactRetentionSweep(now)` reads `RETENTION_DAYS` (default 30, `0` purges everything before `now`, negative/NaN falls back) (`artifacts-repository.ts:186-187`); computes `cutoff = now - days`, purges, logs only when `purged > 0` (`artifacts-repository.ts:192`).
9a. Retention wiring (ART-3 fixed): the `retention` maintenance job now calls `artifactsGate.runRetentionSweep()`; without it artifacts grew unboundedly. `writeArtifactFile` sanitizes the runId path segment (ART-7 fixed). Client Apply fetches the full row via `GET /api/artifacts/:id` before writing (ART-1 fixed) since listings truncate to 500 chars.

## Current Implementation
| File | Role |
| ---- | ---- |
| `artifact-types.ts` | Pure types, no I/O. `ArtifactType` (10-variant union), `CreateArtifactInput`, `ArtifactRow` |
| `artifacts-repository.ts` | DB owner + emits + retention. `createArtifact`/`getArtifactById`/`listArtifactsByRun`/`listArtifactsByWorkspace`/`purgeExpiredArtifacts`/`runArtifactRetentionSweep` plus `numEnv` helper; local-first file/index commit with best-effort DB replica (2026-10-12) |
| `artifact-local-store.ts` | File-tier index (`vfs/.crowdos/artifacts.json`): `localUpsertArtifact`/`localGetArtifact`/`localListArtifactsByRun`/`localListArtifactsByWorkspace` with DB listing parity (2026-10-12) |
| `artifacts-gate.ts` | Thin facade, wire + re-export only. Re-exports types verbatim; `artifactsGate` maps `create/getById/listByRun/listByWorkspace/listByRunAndType/purgeExpired/runRetentionSweep/writeFile` |
| Types (from `artifact-types.ts:1`, `db/schema.ts:527`) | `ArtifactType` (`reasoning_trace/execution_log/analysis_report/generated_component/task_result/runtime_snapshot/file/diff/report/citations`), `ArtifactRow` (id/workspace/producer/type/path/tags/metadata/createdAt/runId/hashes/patch/contentRef) |

## Ports
- `ArtifactType` — artifact kind union type.
- `CreateArtifactInput` — creation input type (`workspaceId` + `producerAgent` + `type` required, rest optional).
- `ArtifactRow` — artifact record type.
- `artifactsGate.create` — inserts row and emits creation events. Local-first since 2026-10-12: file body + local index commit first, DB is a best-effort replica (works with no `DATABASE_URL`).
- `artifactsGate.writeFile` — writes the artifact body under the workspace `artifactDir`, returns the folder-relative path (or null when there is no body / the write failed).
- `artifactsGate.getById` — fetches one artifact with full blobs (`null` on miss). Serves the local index when DB is unconfigured/unreachable (2026-10-12).
- `artifactsGate.listByRun` — truncated listing by run with `{ limit, offset }` paging. Serves the local index when DB is unconfigured/unreachable (2026-10-12).
- `artifactsGate.listByWorkspace` — truncated listing by workspace with `{ limit, offset }` paging. Serves the local index when DB is unconfigured/unreachable (2026-10-12).
- `artifactsGate.purgeExpired` — hard-deletes rows with `createdAt < before`, returns count.
- `artifactsGate.runRetentionSweep` — derives cutoff from `RETENTION_DAYS` and purges, returns `{ purged }`.

## Relations
Gates this domain calls:
- `event-broker-gate.ts` — dynamic `EventBroker` for `diff.created` / `artifact.created` / `artifact.updated` emits (`artifacts-repository.ts:123-128`); never subscribes.
- Non-gate internals used: `shared/config/database.ts` (`getDb`), `db/schema.ts` (`artifacts` def).
Known outside callers of `artifactsGate`:
- Runtime: `runtime/runtimes/coding-runtime.ts` (diff/file creates on edit/write), `runtime/runtimes/research-runtime.ts` (report/citations creates), `runtime/runtimes/swarm-runtime.ts` (run output creates).
- Swarm: `swarm/delegation-service.ts` (delegation artifact create).
- Tools: `tool-registry.ts` `create_artifact` handler (L0+L1 agent verb; server-derived workspace/producer/run/path).
- Routes: `routes/artifacts.ts` (listByRun/listByWorkspace/getById).
- Tests: `artifacts/artifacts-gate.test.ts`, `runtime/runtimes/research-runtime.test.ts` (mocked `create`), `artifacts/artifact-local-mode.test.ts` (no-DB create/get/list + tool dispatch, 2026-10-12).
Tables shared with other domains (FK → cascade, owned elsewhere):
- `runs.id` ← `artifacts.run_id` cascade (Runs owns); `workspaces.id` ← `artifacts.workspace_id` cascade (Workspace owns); `metadata.channelId` is a loose opts-only reference, not a FK.

## Emits-Listens
- `diff.created` (emits, only when `type === diff`)
- `artifact.created` (emits, only when `type !== diff`)
- `artifact.updated` (emits, on every create)

## Owns
- `artifacts` (writes: insert, hard-delete on purge/retention)

## Flags
- `RETENTION_DAYS` — retention window in days, default 30; `0` purges everything before now; negative/non-numeric falls back (`artifacts-repository.ts:187`).

## Decisions
- `[Observed]` 2026-09-22 canon artifact files: generation defaults to the workspace `artifactDir` (`vfs/artifacts`, canon from mock-structure-polished) and stores a folder-relative path, so a moved workspace folder keeps its artifact pointers valid. Previously the DB row was the only storage and `path` was caller-supplied.
- `[Observed]` Truncated listings (500-char `substring` in SQL) with full body only via `getById` — why: list views stay bounded while detail views pay for blobs on demand.
- `[Observed]` Explicit-column selects instead of `select *` — why: enforces the truncation contract at the query layer, not in JS post-processing.
- `[Observed]` `diff` gets its own `diff.created` event while still emitting generic `artifact.updated` — why: diff consumers subscribe narrowly without losing the generic timeline signal.
- `[Observed]` Emit failures swallowed so broker outage never fails the insert — why: storage is source of truth; sync is best-effort.
- `[Observed]` Dynamic `import()` for `EventBroker` instead of top-level gate import — why: avoids cycles and keeps the repository importable without booting brokers.
- `[Observed]` `art_<rand>_<time>` string ids instead of UUIDs — why: sortable-by-time, human-greppable artifact handles distinct from run UUIDs.
- `[Inferred]` Retention logs only when `purged > 0` — why: silent steady-state, noisy only on actual deletion.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Truncated listings stay; channel scoping, purge bounds, and retention ownership are the gaps.
Listings are truncated by contract; full blobs only via getById. Consumers must not depend on patch or contentRef beyond 500 chars.
Create must validate metadata.channelId when present; channel-less artifacts have an explicit fan-out rule, never silent room ambiguity.
purgeExpired must be batch-bounded with lock and timeout behavior documented. Unbounded single-statement purges are forbidden.
runRetentionSweep scheduling has one owner with a documented timer; caller-owned scheduling without a port is forbidden.
RETENTION_DAYS has one owner and one semantic. Cross-domain reads of the same env with different meanings are forbidden.
listByRunAndType is either a public port with documented callers or removed. Reachable-but-unlisted surface is not acceptable.
Artifact events have a documented subscriber contract beyond socket fan-out, or are explicitly fan-out only.
## Failure + Resume
- Insert failure throws to the runtime caller; emit failure is caught and swallowed so the row survives broker outage (`artifacts-repository.ts:130`).
- `getById` miss returns `null`, surfaced as HTTP 404 (`artifacts-repository.ts:134`, `routes/artifacts.ts:51`); listing with unparseable cursor/offset falls back to `undefined` (no offset) rather than erroring (`routes/artifacts.ts:23`).
- Purge deletes and returns count with no retry; `runRetentionSweep` has no timer in-domain — scheduling is the caller's job (no `startSweeper` port observed) (`artifacts-repository.ts:171-174`, `artifacts-repository.ts:186-187`).
- Resume is manual: re-list after purge; purged rows are unrecoverable (hard-delete, no archive).

## Gaps
- `listByRunAndType` has no route exposure; its live callers beyond tests were not found — whether it is runtime-internal or dead surface is unverified.
- `listByWorkspace` ordering is `createdAt desc` with offset paging and no cursor stability; concurrent inserts during pagination may skip/duplicate rows — unverified intent.
- `metadata.channelId` is the only channel scoping for emits, but `create` does not validate it; emit room fan-out for channel-less artifacts is unverified.
- `purgeExpired` has no batch limit; a large expired backlog deletes unbounded rows in one statement — lock/timeout behavior unverified.
- Whether any worker subscribes to `artifact.created` / `artifact.updated` / `diff.created` (vs socket fan-out only) was not traced beyond emit sites.
- `RETENTION_DAYS` is also read by other domains (e.g. spawn retention); cross-domain retention-window coupling is unverified.
- No `listens` observed in this domain.
- ART-4 closed (2026-10-07, fix-artifacts-micro-4-5): GET /api/artifacts?workspaceId= 403s a caller/query workspace mismatch before any gate call (routes/artifacts.ts:44-47); regression artifacts-fix-art4.test.ts.
- ART-5 closed (2026-10-07, fix-artifacts-micro-4-5): purgeExpired batches 500 ids per delete statement (artifacts-repository.ts:182-199), superseding the unbounded-purge gap above; regression artifacts-fix-art5.test.ts.
- ART-6 closed (2026-10-07, fix-artifacts-micro-6-8): create accepts an optional caller dedupeKey; a retry with the same key in the same workspace returns the existing row and writes no second file (sequential path; concurrent same-key races await a DB unique index). Regression artifacts-fix-art6-8.test.ts.
- ART-8 closed (2026-10-07, fix-artifacts-micro-6-8): artifacts.path persists the WRITTEN folder-relative value only; the caller-supplied path is kept in metadata.sourcePath, so a failed write can no longer leave a repo-relative path for apply to target. Regression artifacts-fix-art6-8.test.ts.
- ART-13 closed (2026-10-07, fix-artifacts-micro-13): the create emit site no longer double-casts payload/opts `as never`; payload is annotated `BrokerEventMap["artifact.created"]` and opts.channelId is string-narrowed (non-string metadata.channelId is dropped), so a contract shape change now fails tsc at artifacts-repository.ts:148-158. Regression artifacts-fix-art13.test.ts.
- Known drift (recorded 2026-10-07, not fixed here): Flow/Relations line citations for the emit block (e.g. `artifacts-repository.ts:123-128`) are stale vs current line numbers; fix in a dedicated docs pass.
- ART-2 closed (2026-10-07, fix-artifacts-2-worker-leg): the queue worker leg now executes runs inside the workspace ALS handle (dbForWorkspace -> runWithDb, run-worker.ts:160-186; shared SH-002); TG-4 regression src/queue/run-worker.scope.test.ts:86 covers bound/default/degrade; combined vitest src/artifacts+src/queue 31 passed/4 skipped exit 0; tsc exit 0.
- Observed drift (2026-10-12, left open — out of scope for the local-first fix): `artifacts-fix-art5.test.ts` (2), `artifacts-fix-art6-8.test.ts` (3), and `artifacts-fix-art13.test.ts` (1) fail against the current `artifacts-repository.ts` — the code has no bounded-batch purge, no `dedupeKey` lookup, no `metadata.sourcePath`, and forwards non-string `metadata.channelId` to the emit opts. The Gaps entries above still describe them as closed, so either the fix regressed in a later cleanup or the doc is ahead of the code. Not fixed here; restore is a separate task.
