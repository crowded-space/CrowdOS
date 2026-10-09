# Artifacts Domain — Contracts (Phase 2)
> One row per gate method. Evidence file:line. Status: Confirmed unless marked.

| Method | Preconditions | Validation | Result | Errors | Auth/Tenant | Idempotency | Txn | Side effects / order | Events | Retry | Observability | Perf |
| ------ | ------------- | ---------- | ------ | ------ | ----------- | ----------- | --- | -------------------- | ------ | ----- | ------------- | ---- |
| create(input) | workspaceId + producerAgent + type required by type; workspace record exists for file write (else no file) | None at runtime (TS types only; enum enforced by DB) | ArtifactRow (id art_ + 8hex + _ + base36time) | DB insert throw; fs failure swallowed | getDb(): tenant ALS if present else global/env (ART-2) | None (new id each call; docs admit) | None (file write -> insert -> emit; no txn) | 1) write file best-effort 2) insert row 3) emit | diff.created XOR artifact.created + always artifact.updated (swallow failures) | caller (runtimes wrap in try/catch, mark persisted:false) | console.warn on broker/file issues only | 1 fs write + 1 insert per create |
| getById(id) | none | none | ArtifactRow or null; full patch/contentRef | DB throw | tenant handle per request | read-only | n/a | none | none | none | none | 1 indexed PK select |
| listByRun(runId,{limit,offset}) | none | limit clamp 1..200 (default 200); offset clamp 0..10000 | ArtifactRow[] truncated: patch/contentRef = substring(1,500) | DB throw | tenant handle | read-only | n/a | none | none | none | none | uses artifacts_run_idx; order createdAt desc |
| listByWorkspace(workspaceId,{limit,offset}) | none | same clamps; workspaceId NOT bound to identity | truncated rows | DB throw | see ART-4 (client-supplied workspaceId) | read-only | n/a | none | none | none | none | artifacts_workspace_idx |
| purgeExpired(before) | none | none (Date) | count purged | DB throw | none | not idempotent-safe for racing writers; deletes rows | none | hard delete createdAt<before | none | none | none | single unbounded DELETE (ART-5) |
| runRetentionSweep(now?) | none | RETENTION_DAYS via numEnv (NaN/neg -> 30; 0 -> purge all before now) | {purged} | DB throw | none | none | none | purge + console.log when purged>0 | none | none | console.log only | same as purge |
| writeFile(input, artifactId) | artifactId supplied; body = contentRef||patch | ext from path or type; artifactDir normalized (traversal -> default) | folder-relative path or null | never throws (catch -> null) | resolveWorkspaceFolder (registry) | overwrites same artifactId+ext | n/a | mkdir -p + write utf8 | none | none | none | 1 fs write |

## Contract notes
- Truncation is contractual (SQL-side, repo:150-151,165-166); consumers must use getById for full bodies — BUT the shipped client applies diffs from list rows (crowdOsStore.ts:3796-3799) => broken contract in practice (ART-1).
- Gate shape matches Backend doc Ports except doc's stale mention of listByRunAndType (does not exist in code) (ART-9).
- writeFile/purgeExpired/runRetentionSweep have zero external callers (grep-verified) — public surface with no consumers.
- Emit payload/opts use double cast as never (repo:122-123) — type-check bypass (ART-13).
