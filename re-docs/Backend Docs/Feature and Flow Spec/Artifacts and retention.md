# Artifacts and retention
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Run and workspace outputs (diffs, reports, files, traces) need durable storage that list views can browse cheaply while detail views pay for full blobs on demand. This feature exists so runtimes persist outputs as `artifacts` rows, clients sync off creation/update events, listings stay bounded via SQL-side truncation, and expired rows are hard-purged by retention sweep.

## Architectural decision
Listings truncate `patch`/`contentRef` to 500 chars in SQL with full bodies only via `getById`, so list views stay bounded while detail views fetch blobs explicitly [Observed]. Explicit-column selects enforce the truncation contract at the query layer, not in JS post-processing [Observed]. `diff` gets its own `diff.created` event while every create also emits generic `artifact.updated`, so diff consumers subscribe narrowly without losing the timeline signal [Observed]. Emit failures are swallowed, so broker outage never fails the insert — storage is source of truth, sync is best-effort [Observed]. Dynamic `import()` of the broker avoids cycles and keeps the repository importable without booting brokers [Observed]. `art_<rand>_<time>` string ids give sortable, greppable handles distinct from run UUIDs [Observed]. Retention logs only when `purged > 0` — silent steady-state, noisy only on deletion [Inferred].

## How it works
Runtimes compute `beforeHash/afterHash/patch/contentRef`, then call `artifactsGate.create` (`coding-runtime.ts` diff/file on edit/write, `research-runtime.ts` report/citations, `swarm-runtime.ts` run output, `delegation-service.ts` delegation rows). The repository mints an `art_<8hex>_<base36time>` id, inserts with `createdAt = now`, then emits `diff.created` for `diff` type else `artifact.created`, plus always `artifact.updated`, carrying `{ runId, artifactId, artifactType, workspaceId }` and `channelId` from `metadata.channelId` — emit failure caught and swallowed. `getArtifactById` returns the full row or `null` (route → 404). `listArtifactsByRun` / `listArtifactsByWorkspace` project the truncated columns, filter by `runId`/`workspaceId`, order `createdAt desc`, with limits clamped 1–200 (default 200) and offsets 0–10000; `listArtifactsByRunAndType` adds the type filter at a fixed 200 cap with no paging and no route exposure. `purgeExpiredArtifacts(before)` hard-deletes `createdAt < before` and returns the count; `runArtifactRetentionSweep` derives `before` from `RETENTION_DAYS` (default 30; `0` purges everything before now; negative/NaN falls back) and logs only on non-zero purges. There is no in-domain sweep timer — scheduling is the caller's job.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Artifacts.md> | Owns `artifacts` rows, truncated listings, creation emits, purge + retention sweep |
| <../Domain Spec/Runtime.md> | Produces rows — computes hashes/patch/contentRef and calls `create` from coding/research/swarm runtimes |
| <../Domain Spec/Swarm.md> | Produces delegation artifacts via `delegation-service.ts` |
| <../Domain Spec/Runs.md> | Owns `runs` rows; artifacts only FK-reference `runId` (cascade) |
| <../Domain Spec/Workspace.md> | Owns `workspaces` rows; artifacts only FK-reference `workspaceId` (cascade) |
| <../Domain Spec/EventBroker.md> | Receives `diff.created` / `artifact.created` / `artifact.updated` emits (never subscribed here) |

## Current state
Real: `art_`-prefixed inserts, dual creation emits + always-`artifact.updated`, SQL-truncated listings by run / workspace / run+type, full-body `getById`, time-based hard purge, `RETENTION_DAYS` retention sweep. Transport: `GET /api/artifacts` (run/workspace filter, 400 when neither), `GET /api/artifacts/:id` (404 on miss), `GET /api/runs/:id/artifacts`. Flag-gated: `RETENTION_DAYS` only. Stub: none.

## Alignment notes
- 2026-09-22 canon artifact files: generation writes the artifact body to the workspace `artifactDir` (`<workspaceFolder>/vfs/artifacts/<runId>/<artifactId>.<ext>`) and stores the FOLDER-RELATIVE path in `artifacts.path`, so a moved workspace folder keeps its pointers valid. `artifactDir` comes from the workspace record and is normalized to a folder-relative path (an absolute/traversal value falls back to `vfs/artifacts`). The write is best-effort: a filesystem failure leaves the DB row as the pointer rather than failing creation.
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in the linked domain specs.
* Truncated listings stay; full blobs only via getById. Consumers never depend beyond 500 chars.
* Create validates metadata.channelId when present with explicit channel-less fan-out rule.
* purgeExpired is batch-bounded with documented lock behavior. Unbounded purges are forbidden.
* Retention scheduling has one owner with documented timer. RETENTION_DAYS has one owner and one semantic.
* Authority: Artifacts domain standard. This flow does not duplicate rules.
## Open gaps
- `listByRunAndType` has no route exposure; live callers beyond tests unverified — runtime-internal or dead surface unknown.
- `listByWorkspace` uses offset paging with no cursor stability — concurrent inserts during pagination may skip/duplicate rows.
- `metadata.channelId` is unvalidated at create; emit room fan-out for channel-less artifacts unverified.
- `purgeExpired` has no batch limit — a large expired backlog deletes unbounded rows in one statement.
- Whether any worker subscribes to the artifact events (vs socket fan-out only) was not traced beyond emit sites.
- `RETENTION_DAYS` is also read by other domains — cross-domain retention-window coupling unverified.
