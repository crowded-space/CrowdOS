# Workspace Domain — Phase 2 Contract Matrix (per facade op)

Legend: Auth/Tenant = who is trusted (single-user local-first; tenant = x-workspace-id -> record pool). Order = side-effect order. All paths cited as file:line.

| Op | Preconditions / Validation | Result / Errors | Auth/Tenant | Idempotency | Txn / Concurrency | Side-effect order | Observability | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| getWorkspaceDb(id) | id non-empty; record or env key has URL | ResolvedWorkspaceDb {db, source:'workspace'}; NO_DATABASE error otherwise | tenant-scoped by design; any caller with id | yes (pool reuse by URL hash) | per-process Map; rotation races leak (WS-007) | resolve record -> env fallback -> close stale -> evict idle -> LRU evict -> open | none (no logs) | never global fallback (record-only) |
| closeWorkspaceDatabase(id) | none | void; close errors swallowed | any | yes | best-effort | remove map -> sql.end(timeout 5) | none | |
| closeAllWorkspaceDatabases() | none | void | any | yes | parallel closes | snapshot keys -> close each | none | shutdown path |
| getWorkspaceDbPoolStats() | none | [{workspaceId,lastUsed}] no secrets | any | n/a | sync | none | none | 0 external callers |
| forEachWorkspaceDb(fn) | none | void; per-target errors swallowed | any | yes | serial, dedup by handle | list records -> open each -> run fn | none (silent skips WS-008) | no global target anymore (docs stale) |
| parseWorkspaceDatabaseUrl(raw) | non-empty, <=2000 chars, no control chars, postgres scheme, host | {url,host,port,database}; Error 'Invalid workspace database URL: ...' | any | pure | pure | none | none | decodeURIComponent can throw URIError unredacted (WS-021) |
| describeWorkspaceDatabaseUrl(raw, schemaReady=false) | same as parse | non-secret descriptor | any | pure | pure | none | none | 0 external callers; schemaReady never flipped (WS-010) |
| testWorkspaceDatabaseConnection(url, timeoutMs=8000) | parse first | {host,port,database}; redacted Error map | any | read-only probe | short-lived conn; abort+end race | parse -> connect -> select 1 -> end | none | never echoes URL |
| provisionWorkspaceDatabase(url, timeoutMs=120000) | parse first | {migrationsApplied,message}; redacted errors | any | idempotent (drizzle journal) | caller should hold withProvisionLock | parse -> migrate -> count -> end | none | |
| provisionWorkspaceDatabaseSchema | alias | alias | alias | alias | alias | alias | alias | |
| withProvisionLock(url, fn) | any url | fn result; fn error propagates; lock released | any | n/a | per host:port/db promise chain | queue -> run -> cleanup | none | malformed URL key = raw:len (collision, harmless) |
| seedWorkspacePresets(db, workspaceId='default') | db handle with schema | void; per-row failures swallowed | any | yes (findFirst guards) | none; partial states possible | instruction module -> category -> channels -> welcome msg -> agents -> settings | none (WS-016) | message insert depends on channel success |
| resetWorkspaceDatabase(url) | parse first | void; raw errors | any | NOT idempotent-safe with survivors (WS-003) | single connection; drop CASCADE | drops hardcoded list | none | drop list drifts from migrations |
| upsertWorkspaceDatabaseEnv(id, url, opts) | parse; env path | env key; fs errors thrown | any | yes | in-process envWriteChain; tmp+rename 0600 | read -> filter -> header -> append -> write tmp -> rename -> cache clear | none | dead in current flow (WS-009) |
| removeWorkspaceDatabaseEnv(id, opts) | id | void; no-op when absent | any | yes | envWriteChain | read -> filter -> tmp+rename | none | dead (WS-009) |
| resolveWorkspaceEnvFilePath(startDir=cwd) | none | nearest .env within 5 levels; override wins | any | yes (60s cache) | sync cache | walk -> cache | none | clearWorkspaceEnvCache ignores its arg (smell) |
| listWorkspaces() | none | WorkspaceDescriptor[] (no secrets) | any | yes | read-only | read file -> sanitize | none | corrupt file -> [] silently (WS-005) |
| listWorkspaceRecords() | none | raw records incl. databaseUrl + pin hash | any caller — sensitive | yes | read-only | read file | none | used by boot/pin/sweeps |
| getWorkspaceRecord(id) | id | record or null | any | yes (60s cache incl. negative) | read-only | cache -> file | none | external edits stale <=60s (WS-028, documented) |
| getWorkspaceDescriptor(id) | id | descriptor or null | any | yes | read-only | record -> sanitize | none | |
| saveWorkspaceRecord(record) | record shape | descriptor; fs errors throw | any | upsert by id | withLock serialized writes | read all -> upsert -> write file -> cache delete -> path-cache invalidate -> folder mirror | none | mirror best-effort swallow |
| removeWorkspaceRecord(id) | id | true when removed | any | yes | withLock | read -> filter -> write -> cache delete -> path invalidate | none | no folder cleanup (route owns) |
| tierContextFor(id) | id optional | {workspaceId, databaseUrl, storagePreference} | any | yes (60s cache) | read-only | record -> ctx | none | conflict state NOT reflected (WS-004) |
| resolveSandboxBase() | none | WORKSPACE_DIR or cwd/sandbox | any | pure | sync | none | none | |
| resolveWorkspaceLocalRoot(id) | id optional | record rootPath else sandbox/folder else sandbox/id | any | yes | read-only | record -> path | none | fallback uses raw id in join (Low risk) |
| resolveWorkspaceFolder(id) | id | absolute folder or null | any | yes | read-only | record -> path | none | |
| resolveRecordFolderName(record) | id/name/folderName | sanitized display-name folder | any | pure | none | none | none | dead '|| id' branch (WS-020) |
| resolveRecordArtifactDir(record) | optional | normalized folder-relative dir | any | pure | none | none | none | |
| writeWorkspaceFolderCopy(record) | record | void; failures swallowed | any | yes | none | mkdir -> write workspace.json | none | mirror best-effort by design |
| resolveWorkspaceFolderPath(base,folder) | any | resolve(base,folder) | any | pure | none | none | none | |
| sanitizeWorkspaceFolderName(name) | any string | safe folder (reserved names, 80 cap, trailing dots) | any | pure | none | none | none | duplicate sanitizer in local-file.ts differs (WS-020) |
| normalizeArtifactDir(dir) | any | folder-relative or default | any | pure | none | none | none | traversal/absolute -> default |
| resolveArtifactsDir(folder,dir) | any | absolute path inside folder | any | pure | none | none | none | refuses absolute/traversal |
| toFolderRelative(abs, folder) | any | relative slash path | any | pure | none | none | none | case-sensitive prefix (WS-019) |
| resolveVfsDir/resolveCrowdosDir/resolveAgentsDir/resolveSrcDir | any | absolute dirs | any | pure | none | none | none | 0 external callers for most (WS-010) |
| DEFAULT_ARTIFACT_DIR | n/a | 'vfs/artifacts' | any | constant | none | none | none | |
| defaultWorkspaceRuntimeConfig(input) | id | canon defaults | any | pure | none | none | none | 0 external callers |
| readWorkspaceRuntimeConfig(id, fallbackName?) | id | config; any error -> defaults | any | yes | read-only | folder resolve -> read -> normalize | none | permission errors masked (WS-024) |
| writeWorkspaceRuntimeConfig(id, patch, fallbackName?) | id | merged config; write errors throw | any | read-modify-write | none (no lock) | read -> merge -> mkdir -> write | none | concurrent writers last-wins; orphan folder if record missing |
| getScreenLockStatus(id) | id | {workspaceId,enabled}; Error 'Workspace <id> not found' | any | yes | read-only | registry -> db | none | route maps to 404 |
| getWorkspacePinHash(id) | id | hash or null (never throws) | any | yes | read-only | registry -> db | none | resolver for pin-gate |
| setScreenLockPin(id,pin,currentPin?) | pin 4..128 (validate); current proof when hash exists | {workspaceId,enabled:true}; Error 'Current screenlock PIN is incorrect.' | any; LOCAL_PIN accepted as proof | yes | registry withLock; DB best-effort | validate -> loadHash -> proof -> hash -> registry save -> db update | none | returns success even if both persists fail (WS-002); no pin-cache invalidate (WS-001) |
| clearScreenLockPin(id,currentPin?) | proof when hash exists | {workspaceId,enabled:false} | any | yes | same | proof -> registry null -> db null | none | same swallow/invalidate issues |
| sanitizeWorkspace(row) | any row | row minus hash + screenLockEnabled | any | pure | none | none | none | 0 external callers (WS-010) |

Cross-cutting: errors are swallowed at many boundaries by design (local-first degrade) — see ledger for which swallows are contract violations vs intentional.

