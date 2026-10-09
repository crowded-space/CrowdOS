# routes — contract audit (per-op, one row per endpoint group)

Route files are transport adapters over domain gates; facade NONE. Auth column = mounted hooks
(authGate loopback-trust; pinGate; tenant DB hook; optional WORKSPACE_ADMIN_TOKEN admin).

| File | Ops | Validation | Auth/Tenant | Result/Errors | Side-effects | Notes |
|---|---|---|---|---|---|---|
| index.ts | registerRoutes (25 modules) | n/a | global hooks | n/a | none | THR-001 regression guard test exists |
| rate-limit.ts | registerRateLimit, buildRateLimitOptions, isRateLimitEnabled | env ints | per-identity.id/ip | 429 body retryAfterMs | Redis store if REDIS_URL | global bucket, health allowlist |
| health.ts | GET /health, /api/health | none | global | 200 | 5s queue-probe cache | readiness probe 500ms timeout |
| metrics.ts | GET /metrics, /api/metrics | none | **no admin gate (OBS-012)** | 200 | reads perf snapshot | METRICS_ENABLED=false disables |
| agents.ts | CRUD /api/agents | zod via gate schemas | tenant via workspaceIdFrom; delete/get scoped | 201/404/400/204 | workspace:sync emit; agent:resumed | PUT pre-reads previous for resume detect |
| modules.ts | CRUD ×5 kinds + test | zod | workspaceIdFrom header or query | 201/404/409/204 | workspace:sync; redactSecrets | delete pre-check referencingAgent (M-14 double read) |
| providers.ts | CRUD ×3 profile kinds (deprecated gen) | zod partial | **no tenant scoping (dbScopeKey only)** | 201/404/204 | encrypt apiKey; 10s TtlCache | redactSecrets on read |
| workspace.ts | registry CRUD, screen-lock, db-sync, settings/budget, database hot-reload | zod | admin token only on /api/workspace/database | 201/400/409/503/404 | registry file, folder move/rm, provisioning, pairing | WS-006/013/014/017/018/023/027 open |
| categories.ts | CRUD | zod | workspaceId query/header | 201/409/404/204 | workspace:sync; maybeSend304 | CHN-006b duplicate union handled |
| channels.ts | CRUD + settings | zod | tenant for list/create/settings; **update/delete unscoped (CHN-016)** | 201/409/400/404/204 | workspace:sync | XD-004 agent pin scoped; settings orphan write 404 |
| channel-mounts.ts | mount get/set ×3, fs browse/roots/pick | zod | ownsMountTarget (fail-open when no callerWs) | 200/400/403/410 | broker emits (CM-017/019 scoping gaps) | pick-folder hard 410 (intentional) |
| messages.ts | GET page | zod + cursor | tenant check (MSG-007 class) | 200/400/403 | none | MSG-015 PG pinning caveat |
| threads.ts | CRUD + messages + sweep | zod except POST messages body (THR-022) | global only; sweep unguarded (THR-008) | 201/404/409/400 | messageGate.append with broker; incrementCount (XD-030 two writes) | THR-001 fixed (mounted); THR-007 no scheduler |
| filesystem.ts | mount, files list/read/write/delete | zod | jailed by LocalFilesystem; workspaceId query default "default" | 200/400/404/500 | FS writes | FS-007 500-for-traversal mapping |
| skills.ts | CRUD + agent assign | zod | global | 201/404/400/204 | workspace:sync | FK 23503 → 404 |
| tools.ts | list/get/execute-test | minimal | execute-test admin when token set | 200/404 | tool execution side effects | TOLS-16 accepted risk |
| mcp.ts | servers list/register/connect/disconnect | none on register | admin only when token set | 201/400/500/204 | spawns processes; workspace:sync | TOLS-16 accepted risk |
| studio.ts | manifest get/put, inspect-prompt | none on put | workspaceIdFrom | 200/404/400/503 | agentGate/skillsGate writes; cache invalidation | XD-015 fixed via agentGate.replaceInstructionStack; B-10 direct contextPipeline |
| events.ts | GET /api/events/recent | zod | tenant check added (XD-014) | 200/403 | none | EVT-14 shape accepted |
| queue.ts | failed/health | zod | global | 200/500 | none | inline mode honest empty |
| runs.ts | resume, compensations, undo, get | none | global | 200/400/404 | enqueue/execute; broker emits | Q-2/Q-5/RUN-006 fixed (delivery field); RUN-007 still open (workspaceId not threaded) |
| artifacts.ts | list, get, run artifacts | zod | ART-4 fixed (403 mismatch) | 200/403/400/404 | none | toOffset clamps ≤10000 |
| approvals.ts | list, get, decide, sweep | manual | global; sweep via approvalGate.sweepOnce | 200/400/404/409 | emitDecided; stateGate resume | AP-004 fixed (sweepOnce) |
| search.ts | GET /api/search | zod | JS filter on callerWs (XD-001) | 200 | none | similarity path filters in JS post-limit (rows may be lost) |
| observability.ts | traces ×2, cost ×3 | zod | adminPreHandler when token; local-tier degrade | 200/503 | none | OBS-008 open (oldest-first limit) |
| safety.ts | channel/workspace safety, grants list/revoke | zod | workspaceId default "default" for channel; **workspace safety path id unverified** | 200 | direct table writes | AP-015 partly stale: module IS now registered |
