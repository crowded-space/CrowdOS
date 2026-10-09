# Artifacts Domain — Inventory (Phase 1)
> READ-ONLY audit. Time-boxed partial: items marked [Low-confidence] not fully traced.
> Repo: C:/Users/Asus/Documents/GitHub/.ThisCrowd · Domain: packages/server/src/artifacts

## Files (4)
| File | Role | Evidence |
| ---- | ---- | -------- |
| artifacts-gate.ts | Public facade: wire + re-export only (7 ports + 3 types) | artifacts-gate.ts:1-15 |
| artifact-types.ts | Pure types: ArtifactType (10), CreateArtifactInput, ArtifactRow | artifact-types.ts:1-39 |
| artifacts-repository.ts | Impl: file write, insert, reads, purge, retention sweep, emits | artifacts-repository.ts:68-197 |
| artifacts-gate.test.ts | DB-backed integration tests (4 its), skipIf(!probe.ok) | artifacts-gate.test.ts:44,109,161 |

## Gate exports (exact — must equal Backend doc Ports)
- Types: ArtifactType, CreateArtifactInput, ArtifactRow (artifacts-gate.ts:4)
- Ports: create, getById, listByRun, listByWorkspace, purgeExpired, runRetentionSweep, writeFile (artifacts-gate.ts:6-15)

## Dependency map
Caller -> Facade -> Service/Repo -> Ports -> Adapter
- routes/artifacts.ts:3,38,42,50,60 -> artifactsGate.{listByRun,listByWorkspace,getById}
- runtime/runtimes/coding-runtime.ts:248-259 (write_file), 360-371 (edit_file) -> artifactsGate.create
- runtime/runtimes/research-runtime.ts:540-568 (citations), 580-602 (report) -> artifactsGate.create
- runtime/runtimes/swarm-runtime.ts:230-244 (report) -> artifactsGate.create
- swarm/delegation-service.ts:89-101 (report, truncated subagent output) -> artifactsGate.create
- tests: artifacts-gate.test.ts (gate), research-runtime.test.ts:77 (spyOn create)
- artifacts-repository.ts -> workspace-gate.ts (getWorkspaceRecord, resolveArtifactsDir, resolveRecordArtifactDir, resolveWorkspaceFolder, toFolderRelative) [gate-to-gate, OK]
- artifacts-repository.ts -> shared/config/database.ts getDb() [exempt]; db/schema.ts artifacts [exempt]
- artifacts-repository.ts -> event-broker-gate.ts (dynamic import getSharedBroker) [gate-to-gate, OK]
- No imports past artifacts-gate from outside (check-gates: 0 violations; test-only findings only)

## Persistence
- Table artifacts: id text PK, workspace_id FK->workspaces cascade, producer_agent, artifact_type enum, path, semantic_tags[], metadata jsonb, created_at, run_id uuid FK->runs cascade, before_hash, after_hash, patch, content_ref (schema.ts:517-534; migrations 0000:98-107,451; 0008:4-7,43-47,52; 0014:7-8)
- Indexes: artifacts_run_idx, artifacts_workspace_idx (schema.ts:532-533)
- Enum artifact_type: reasoning_trace, execution_log, analysis_report, generated_component, task_result, runtime_snapshot, file, diff, report, citations (schema.ts:40)
- Files: body written to <workspaceFolder>/<artifactDir>/<runId|unscoped>/<artifactId>.<ext>; DB stores folder-relative path (repo:68-85; workspace-paths.ts:30,81-95)

## Events
- Emits diff.created when type=diff else artifact.created; always artifact.updated; channelId from metadata.channelId (repo:112-131; event-types.ts:177-179)
- Consumer: socket fan-out via broker.onAny (register-socket-server.ts:414-461); no domain worker/listener found [Low-confidence: full worker scan not exhaustive]

## Entry points
- GET /api/artifacts?runId= | workspaceId= (400 if neither) (routes/artifacts.ts:27-46)
- GET /api/artifacts/:id (404 miss) (routes/artifacts.ts:48-53)
- GET /api/runs/:id/artifacts (routes/artifacts.ts:55-63)
- Registered globally; auth = requireAuthMounted (loopback trust) (routes/index.ts:51; create-app.ts:347)
- Tenant routing: x-workspace-id header -> ALS db handle (create-app.ts:235-303)

## Jobs / queues / config
- queue/repeatables.ts:16 "retention" every 6h -> maintenance-worker.ts:93-102 handleRetention -> ONLY token-tracker reconcileBudgetUsage; artifacts sweep NOT called (dead path — see ledger ART-3)
- Config: RETENTION_DAYS (env.ts:185; default 30); numEnv fallback (repo:179-184)
- No caches in-domain. No queue producers in-domain.

## Bypasses / violations
- None confirmed for imports (check-gates 0 violations). Test-only cross-domain imports in artifacts-gate.test.ts (runs-repository, coding-runtime, provider-registry) — non-fatal per check-gates.
- Runtime artifact creation bypasses tenant ALS: socket run path (register-socket-server.ts:323-334) has no runWithDb; createArtifact uses bare getDb() (repo:88) -> global/env DB or throw. See ART-2.
