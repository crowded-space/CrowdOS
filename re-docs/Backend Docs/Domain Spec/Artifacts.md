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
- `[Observed]` Every create that actually inserts emits; emit failure never fails the insert (try/catch swallow). A dedupe hit (ART-6) inserts nothing and therefore emits nothing.
- `[Observed]` Canon (2026-09-22): `create` first writes the artifact BODY to the workspace's `artifactDir` — `<workspaceFolder>/vfs/artifacts/<runId>/<artifactId>.<ext>` — and stores the FOLDER-RELATIVE path in `artifacts.path`. `artifactDir` comes from the workspace record (default `vfs/artifacts`); an absolute or traversal value falls back to the canon default, so generation can never write outside the workspace folder.
- `[Observed]` ART-8 path semantics: `artifacts.path` holds ONLY the path the writer produced (folder-relative), and is `null` when the body write failed. The caller-supplied `input.path` is never stored as the row path — it is kept in `metadata.sourcePath`. `metadata.artifactPath` mirrors the written path and is absent when nothing was written. A failed write therefore can never leave a repo-relative path in `artifacts.path` for a client "apply" to target.
- `[Observed]` The file write is best-effort: a filesystem failure does not fail artifact creation (the DB row remains a valid pointer, and the panel reports the missing file honestly). An artifact with no body (`contentRef`/`patch` both absent) writes no file, so `path` is `null` and `metadata.sourcePath` keeps the caller path.
- `[Observed]` 2026-10-20: a `contentRef` shaped `data:<mime>;base64,...` is written as BINARY bytes (`Buffer.from(payload, "base64")`); every other body keeps the utf8 path. This is how browser screenshots land as real PNG files rather than base64 text. The artifact type and row shape are unchanged.
- `[Observed]` ART-6 idempotency: `create` accepts an optional caller `dedupeKey`. The key is stored in `metadata.dedupeKey` (no dedicated column) and is scoped per workspace: a retry with the same key returns the EXISTING row unchanged and writes no second file and no second row. The lookup runs before the body write, so a retry is a no-op (no `artifact.created`/`diff.created` emit). Sequential path only — a concurrent same-key race is not yet covered by a DB unique index.
- `[Observed]` `diff` type emits `diff.created`; every other type emits `artifact.created`; every create additionally emits `artifact.updated`.
- `[Observed]` ART-13 emit contract: the payload is typed as `BrokerEventMap["artifact.created"]` (no `as never` cast), so a contract shape change fails typecheck at the emit site. `metadata.channelId` is narrowed at RUNTIME — only a string is forwarded as the event's `channelId`; a non-string value (e.g. the number `123`) is dropped instead of being passed through by a cast.
- `[Observed]` Listings truncate `patch`/`contentRef` to 500 chars in SQL; callers must use `getById` for full bodies.
- `[Observed]` Listing limits clamp to 1–200 (default 200) and offsets clamp to 0–10000; `listByRunAndType` is fixed limit 200 with no paging.
- `[Observed]` ART-5 bounded purge: `purgeExpired(before)` hard-deletes `createdAt < before` in batches of at most 500 ids per DELETE statement (select ids → delete that id set → repeat until no expired row remains) and returns the total count; `runRetentionSweep` derives `before` from `RETENTION_DAYS`.
- `[Observed]` 2026-10-12 local-first: `create` commits the file body plus a `<workspaceFolder>/vfs/.crowdos/artifacts.json` index row FIRST (`artifact-local-store.ts`); the DB insert is a best-effort replica. `create`/`getById`/`listByRun`/`listByWorkspace` serve the local index when `DATABASE_URL` is unconfigured, and degrade to it on connection-class PG failures (`isConnectionError`); other DB errors still throw. `create_artifact` therefore works in local-mode and DB-mode with an unchanged `ArtifactRow` shape. Local listings keep DB parity (500-char blob cap, 1–200 limit, 0–10000 offset, `createdAt desc`).
- `[Observed]` The local tier mirrors the same create semantics: `localFindArtifactByDedupeKey` resolves a `dedupeKey` against the workspace index, so a keyed retry is idempotent with no `DATABASE_URL` too; `path`/`metadata.sourcePath` come from the same row builder as the DB tier.
- `[Inferred]` `create` is not idempotent UNLESS the caller supplies a `dedupeKey` — each call without one mints a new `art_<rand>_<time>` id, so caller retries duplicate.

## Flow
1. Produce: runtimes compute `beforeHash/afterHash/patch/contentRef` then call `artifactsGate.create({ runId, workspaceId, producerAgent, type, path, beforeHash, afterHash, patch, contentRef, semanticTags, metadata, dedupeKey })` (`createArtifact`; callers `coding-runtime.ts`, `research-runtime.ts`, `swarm-runtime.ts`, `delegation-service.ts`).
2. Dedupe (ART-6): when the caller supplies `dedupeKey`, `findArtifactByDedupeKey` looks the key up in `metadata` scoped to the workspace (DB leg `metadata->>'dedupeKey'`, file tier `localFindArtifactByDedupeKey`); a hit returns the existing row unchanged — no body write, no insert, no emit. A miss continues to step 3.
3. Write body: `writeArtifactFile` writes `<workspaceFolder>/vfs/artifacts/<runId>/<artifactId>.<ext>` and returns the folder-relative path (or `null` on failure/no body). `buildArtifactMetadata` then fixes the row metadata: `sourcePath` = caller path (ART-8), `artifactPath` = written path, `dedupeKey` = caller key (ART-6).
4. Insert: repository mints `art_<8hex>_<base36time>` id and inserts with `createdAt = now`; `path` is the written folder-relative path or `null` (ART-8). `workspaceId` FK cascades from `workspaces`, `runId` FK cascades from `runs` (`schema.ts:524-541`). The local index row is written first and the DB insert is a best-effort replica.
5. Emit: after insert, the shared `EventBroker` emits `diff.created` for `diff` else `artifact.created`, then always `artifact.updated`, with the payload typed as `BrokerEventMap["artifact.created"]` and `channelId` forwarded only when `metadata.channelId` is a string (ART-13); failures swallowed.
6. Fetch one: `getArtifactById` selects by id, `null` on miss, full blobs intact; `GET /api/artifacts/:id` maps miss to 404 (`routes/artifacts.ts`).
7. List by run: `listArtifactsByRun(runId, { limit, offset })` selects explicit columns with `substring(patch/contentRef, 1, 500)`, filters `runId`, orders `createdAt desc`; `GET /api/artifacts?runId=` and `GET /api/runs/:id/artifacts` wrap it.
8. List by workspace: same truncated projection filtered by `workspaceId`; `GET /api/artifacts?workspaceId=` wraps it, 400 when neither filter given (`routes/artifacts.ts`).
9. List by run+type: no dedicated repository port exists (`listArtifactsByRun` takes only `{ limit, offset }`); no route exposes it — runtime/internal use only.
10. Purge: `purgeExpiredArtifacts(before)` selects up to 500 expired ids, deletes that id set, and repeats until no expired row remains (ART-5 bounded batches); returns the total count.
11. Retention sweep: `runArtifactRetentionSweep(now)` reads `RETENTION_DAYS` (default 30, `0` purges everything before `now`, negative/NaN falls back); computes `cutoff = now - days`, purges, logs only when `purged > 0`.
11a. Retention wiring (ART-3 fixed): the `retention` maintenance job now calls `artifactsGate.runRetentionSweep()`; without it artifacts grew unboundedly. `writeArtifactFile` sanitizes the runId path segment (ART-7 fixed). Client Apply fetches the full row via `GET /api/artifacts/:id` before writing (ART-1 fixed) since listings truncate to 500 chars.

## Current Implementation
| File | Role |
| ---- | ---- |
| `artifact-types.ts` | Pure types, no I/O. `ArtifactType` (10-variant union), `CreateArtifactInput`, `ArtifactRow` |
| `artifacts-repository.ts` | DB owner + emits + retention. `createArtifact`/`getArtifactById`/`listArtifactsByRun`/`listArtifactsByWorkspace`/`purgeExpiredArtifacts`/`runArtifactRetentionSweep` plus `numEnv` helper; local-first file/index commit with best-effort DB replica (2026-10-12); `buildArtifactMetadata` (ART-6/ART-8 row metadata), `findArtifactByDedupeKey` (ART-6 lookup), `emitArtifactEvents` (ART-13 typed payload); `writeArtifactFile` decodes base64 data-URI bodies to binary bytes (2026-10-20) |
| `artifact-local-store.ts` | File-tier index (`vfs/.crowdos/artifacts.json`): `localUpsertArtifact`/`localGetArtifact`/`localFindArtifactByDedupeKey`/`localListArtifactsByRun`/`localListArtifactsByWorkspace` with DB listing parity (2026-10-12) |
| `artifacts-gate.ts` | Thin facade, wire + re-export only. Re-exports types verbatim; `artifactsGate` maps `create/getById/listByRun/listByWorkspace/listByRunAndType/purgeExpired/runRetentionSweep/writeFile` |
| Types (from `artifact-types.ts:1`, `db/schema.ts:527`) | `ArtifactType` (`reasoning_trace/execution_log/analysis_report/generated_component/task_result/runtime_snapshot/file/diff/report/citations`), `ArtifactRow` (id/workspace/producer/type/path/tags/metadata/createdAt/runId/hashes/patch/contentRef) |

## Ports
- `ArtifactType` — artifact kind union type.
- `CreateArtifactInput` — creation input type (`workspaceId` + `producerAgent` + `type` required, rest optional; optional `dedupeKey` makes the create idempotent per workspace).
- `ArtifactRow` — artifact record type.
- `artifactsGate.create` — inserts row and emits creation events. Local-first since 2026-10-12: file body + local index commit first, DB is a best-effort replica (works with no `DATABASE_URL`). Idempotent per workspace when the caller supplies `dedupeKey` (ART-6): a retry returns the existing row and writes no second file. `path` is the written folder-relative path (or `null`); the caller path is kept in `metadata.sourcePath` (ART-8).
- `artifactsGate.writeFile` — writes the artifact body under the workspace `artifactDir`, returns the folder-relative path (or null when there is no body / the write failed).
- `artifactsGate.getById` — fetches one artifact with full blobs (`null` on miss). Serves the local index when DB is unconfigured/unreachable (2026-10-12).
- `artifactsGate.listByRun` — truncated listing by run with `{ limit, offset }` paging. Serves the local index when DB is unconfigured/unreachable (2026-10-12).
- `artifactsGate.listByWorkspace` — truncated listing by workspace with `{ limit, offset }` paging. Serves the local index when DB is unconfigured/unreachable (2026-10-12).
- `artifactsGate.purgeExpired` — hard-deletes rows with `createdAt < before` in bounded batches (max 500 ids per DELETE statement, ART-5), returns the total count.
- `artifactsGate.runRetentionSweep` — derives cutoff from `RETENTION_DAYS` and purges, returns `{ purged }`.

## Relations
Gates this domain calls:
- `event-broker-gate.ts` — shared `EventBroker` for `diff.created` / `artifact.created` / `artifact.updated` emits (type-only `BrokerEventMap` import + dynamic `getSharedBroker()`); never subscribes.
- `workspace-gate.ts` — `resolveWorkspaceFolder` / `getWorkspaceRecord` / `resolveRecordArtifactDir` / `resolveArtifactsDir` / `toFolderRelative` for the body write.
- Non-gate internals used: `shared/config/database.ts` (`getDb`), `db/schema.ts` (`artifacts` def).
Known outside callers of `artifactsGate`:
- Runtime: `runtime/runtimes/coding-runtime.ts` (diff/file creates on edit/write), `runtime/runtimes/research-runtime.ts` (report/citations creates), `runtime/runtimes/swarm-runtime.ts` (run output creates).
- Swarm: `swarm/delegation-service.ts` (delegation artifact create).
- Tools: `tool-registry.ts` `create_artifact` handler (L0+L1 agent verb; server-derived workspace/producer/run/path; forwards the optional `dedupeKey` argument).
- Routes: `routes/artifacts.ts` (listByRun/listByWorkspace/getById).
- Tests: `artifacts/artifacts-gate.test.ts`, `runtime/runtimes/research-runtime.test.ts` (mocked `create`), `artifacts/artifact-local-mode.test.ts` (no-DB create/get/list + tool dispatch + local-tier dedupe, 2026-10-12), `artifacts/artifacts-fix-art5.test.ts`, `artifacts/artifacts-fix-art6-8.test.ts`, `artifacts/artifacts-fix-art13.test.ts` (ART-5/ART-6/ART-8/ART-13 regression guards).
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
- `[Observed]` ART-6: the idempotency key lives in `metadata.dedupeKey`, not in a new column — why: no schema/migration change (the artifacts table contract stays intact) and the key is workspace-scoped by the lookup predicate.
- `[Observed]` ART-8: `path` = written path only, caller path = `metadata.sourcePath` — why: `path` is what the panel resolves on disk, so it must never be a repo-relative path that a client "apply" would write into a user repository.
- `[Observed]` ART-5: purge selects ids first, then deletes them in batches of 500 — why: a bounded DELETE never holds locks on the whole expired backlog; the id set makes each statement deterministic and re-runnable.
- `[Inferred]` Retention logs only when `purged > 0` — why: silent steady-state, noisy only on actual deletion.

## User Decision:

## Architectural Standard (Target)
> Status: Target. Truncated listings stay; channel scoping and retention ownership are the gaps. Purge bounds are satisfied (ART-5).
Listings are truncated by contract; full blobs only via getById. Consumers must not depend on patch or contentRef beyond 500 chars.
Create must validate metadata.channelId when present; channel-less artifacts have an explicit fan-out rule, never silent room ambiguity. (Runtime narrowing shipped with ART-13; the channel-less fan-out rule is still open.)
purgeExpired must be batch-bounded with lock and timeout behavior documented. Unbounded single-statement purges are forbidden. (Satisfied: at most 500 ids per DELETE statement.)
runRetentionSweep scheduling has one owner with a documented timer; caller-owned scheduling without a port is forbidden.
RETENTION_DAYS has one owner and one semantic. Cross-domain reads of the same env with different meanings are forbidden.
listByRunAndType is either a public port with documented callers or removed. Reachable-but-unlisted surface is not acceptable.
Artifact events have a documented subscriber contract beyond socket fan-out, or are explicitly fan-out only.
## Failure + Resume
- Insert failure throws to the runtime caller; emit failure is caught and swallowed so the row survives broker outage (`emitArtifactEvents`).
- A body-write failure never fails `create`: the row is inserted with `path = null` and the caller path kept in `metadata.sourcePath` (ART-8).
- `getById` miss returns `null`, surfaced as HTTP 404 (`getArtifactById`, `routes/artifacts.ts`); listing with unparseable cursor/offset falls back to `undefined` (no offset) rather than erroring (`routes/artifacts.ts`).
- Purge deletes in bounded batches and returns the total count with no retry; a failing DELETE statement aborts the sweep (the rows stay, the next sweep retries); `runRetentionSweep` has no timer in-domain — scheduling is the caller's job (no `startSweeper` port observed).
- A keyed retry (`dedupeKey`) is a no-op: it returns the existing row without writing a file, inserting a row, or emitting events (ART-6).
- Resume is manual: re-list after purge; purged rows are unrecoverable (hard-delete, no archive).

## Gaps
- `listByRunAndType` has no route exposure; its live callers beyond tests were not found — whether it is runtime-internal or dead surface is unverified.
- `listByWorkspace` ordering is `createdAt desc` with offset paging and no cursor stability; concurrent inserts during pagination may skip/duplicate rows — unverified intent.
- `metadata.channelId` is the only channel scoping for emits. `create` now narrows it at runtime (a non-string is dropped, ART-13), but the fan-out rule for channel-less artifacts is still unverified.
- Whether any worker subscribes to `artifact.created` / `artifact.updated` / `diff.created` (vs socket fan-out only) was not traced beyond emit sites.
- `RETENTION_DAYS` is also read by other domains (e.g. spawn retention); cross-domain retention-window coupling is unverified.
- No `listens` observed in this domain.
- ART-4 closed (2026-10-07, fix-artifacts-micro-4-5): GET /api/artifacts?workspaceId= 403s a caller/query workspace mismatch before any gate call (routes/artifacts.ts:44-47); regression artifacts-fix-art4.test.ts.
- ART-5 closed (2026-10-07, fix-artifacts-micro-4-5; re-implemented 2026-10-20): `purgeExpiredArtifacts` selects at most 500 expired ids per statement and deletes that id set, repeating until no expired row remains — the unbounded single-statement purge is gone; regression artifacts-fix-art5.test.ts (1200-row backlog drains in 3 delete statements, no-op when nothing is expired).
- ART-6 closed (2026-10-07, fix-artifacts-micro-6-8; re-implemented 2026-10-20): `create` accepts an optional caller `dedupeKey`; the key is stored in `metadata.dedupeKey` and `findArtifactByDedupeKey` returns the existing workspace-scoped row on a retry, so no second file and no second row are written (sequential path; concurrent same-key races still await a DB unique index). The local tier mirrors it via `localFindArtifactByDedupeKey`. Regression artifacts-fix-art6-8.test.ts + artifact-local-mode.test.ts.
- ART-8 closed (2026-10-07, fix-artifacts-micro-6-8; re-implemented 2026-10-20): `artifacts.path` persists the WRITTEN folder-relative value only (null when the write failed); the caller-supplied path is kept in `metadata.sourcePath`, so a failed write can no longer leave a repo-relative path for apply to target. Regression artifacts-fix-art6-8.test.ts.
- ART-13 closed (2026-10-07, fix-artifacts-micro-13; re-implemented 2026-10-20): the create emit site no longer double-casts payload/opts `as never`; the payload is annotated `BrokerEventMap["artifact.created"]` and `opts.channelId` is string-narrowed (non-string `metadata.channelId` is dropped), so a contract shape change fails tsc at the emit site. Regression artifacts-fix-art13.test.ts.
- Known drift (recorded 2026-10-07, not fixed here): Flow/Relations line citations for the emit block are stale vs current line numbers; fix in a dedicated docs pass.
- ART-2 closed (2026-10-07, fix-artifacts-2-worker-leg): the queue worker leg now executes runs inside the workspace ALS handle (dbForWorkspace -> runWithDb, run-worker.ts:160-186; shared SH-002); TG-4 regression src/queue/run-worker.scope.test.ts:86 covers bound/default/degrade; combined vitest src/artifacts+src/queue 31 passed/4 skipped exit 0; tsc exit 0.
- Closed drift (2026-10-20): the 2026-10-12 note that `artifacts-fix-art5/art6-8/art13` failed against the current repository is resolved — ART-5/ART-6/ART-8/ART-13 are re-implemented in `artifacts-repository.ts` (`purgeExpiredArtifacts`, `createArtifact` + `findArtifactByDedupeKey` + `buildArtifactMetadata`, `emitArtifactEvents`) and the local tier in `artifact-local-store.ts` (`localFindArtifactByDedupeKey`); the three guard test files pass.
- Open follow-up (2026-10-20): ART-8 moved the repo-relative target path out of `artifacts.path` into `metadata.sourcePath`, so the client Apply/Revert flow (packages/client/stores/crowdOsStore.ts) must target `metadata.sourcePath` instead of `path`. The client is outside the Artifacts domain and was not changed here.
