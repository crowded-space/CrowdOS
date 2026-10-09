# Artifacts Domain — Invariants (Phase 3)
> I = invariant, with verification status.

| ID | Invariant | Verified? | Evidence / Notes |
| -- | --------- | --------- | ---------------- |
| I1 | Every artifacts row has a workspaceId that exists (FK cascade) | Confirmed at DB | schema.ts:519; 0000:451 |
| I2 | runId is null or an existing runs.id (FK cascade) | Confirmed at DB | schema.ts:526; 0008:52 |
| I3 | DB path is folder-relative when a body was written; caller path otherwise | Confirmed, mixed semantics | repo:94-95; ART-8 |
| I4 | Body file lives under workspace artifactDir; traversal artifactDir falls back to default | Confirmed for artifactDir; NOT for runId segment | workspace-paths.ts:81-95; repo:76-77 (ART-7) |
| I5 | listByRun/listByWorkspace rows carry patch/contentRef <= 500 chars | Confirmed (SQL) | repo:150-151,165-166 |
| I6 | create emits exactly: (diff?diff.created:artifact.created) then artifact.updated | Confirmed, failure-swallowed | repo:118-130 |
| I7 | Emit failure never fails create | Confirmed | repo:129-130 catch{} |
| I8 | File-write failure never fails create | Confirmed | repo:68-84 catch -> null |
| I9 | limit in [1,200]; offset in [0,10000] | Confirmed | repo:142-143,158-159 |
| I10 | purge deletes createdAt < before (strict) | Confirmed | repo:173 lt() |
| I11 | Retention sweep is scheduled somewhere in production | VIOLATED (dead path) | repeatables.ts:16 -> maintenance-worker.ts:93-102 (no artifacts call) — ART-3 |
| I12 | Clients apply full bodies (contentRef truth), not truncated list rows | VIOLATED | crowdOsStore.ts:3796-3799 vs repo:150-151 — ART-1 |
| I13 | Artifact writes land in the run's tenant DB | VIOLATED for socket runs | register-socket-server.ts:323-334 (no runWithDb) vs repo:88 getDb() — ART-2 |
| I14 | Workspace-scoped reads bound to caller identity | VIOLATED | routes/artifacts.ts:42 — ART-4 |
| I15 | listByRun/listByWorkspace paging is stable under concurrent inserts | NOT satisfied (offset paging, no cursor tie-break) | repo:140-169; docs gap |
| I16 | Idempotent create (retry-safe) | VIOLATED (by design, undocumented at gate) | repo:89; docs admit |
| I17 | Writes outside workspace folder impossible | Confirmed for artifactDir; runId-segment caveat | I4; ART-7 |

## State/transition model
No lifecycle states: artifacts are append-only rows; only transition is delete (purge/retention, or FK cascade from workspaces/runs). No updatedAt, no status column. Concurrent purge vs read is a hard-delete race (unverified impact, Low).

## Phase 3 rule scan (summary)
- partial writes: file-before-DB (orphan file if insert fails) — Medium, repo:94-102
- races: purge vs create; offset pagination skip/dup — Medium
- leakage: ART-4 (workspaceId), ART-2 (env DB fallback) — High
- auth: routes rely on global loopback/API-key gate only; no per-route role — note
- validation: only DB enum + clamps; no path/runId sanitize, no metadata.channelId validation — Medium
- null/boundary: contentRef 500 truncation; contentRef empty -> no body; patch empty -> no body — Confirmed repo:54-57
- tz: createdAt timestamptz; cutoff via Date arithmetic — OK (repo:192)
- error/retry: emit + fs swallow; runtime callers record persisted:false — OK by design
- event/cache leak: broker listeners per socket; artifacts add none — OK
- N+1: none (single queries)
- migration bypass: none in-domain; migration 0019 dropped workspace_vfs — note
- dead telemetry: retention console.log unreachable (no caller); broker-drop warn text incomplete (ART-11) — Confirmed
