# Shared Domain (non-auth) — Contract Matrix

Legend: Pre=preconditions · Res=result · Err=error · Ten=tenant scoping · Idem=idempotency · Txn=transactionality · Side=side effects · Ev=events · Obs=observability. File:line = code evidence. Confidence: C=Confirmed, H=High, M=Medium, L=Low.

## config/database.ts

### getDb() (`:317-319`)
- Res: ALS store when inside `runWithDb`, else lazily-created global pool (env DATABASE_URL; throws NO_DATABASE-code error via `requireDatabaseUrl` when unset). Ten: ALS is the single tenant mechanism for request scope. Side: pool init once per process (`getSqlClient` `:284-315`); pool max 20 default, statement_timeout 15s.

### runWithDb(db, fn) (`:20-22`)
- Pre: caller resolved a handle (e.g. via `dbForWorkspace`). Res: `fn` return; every bare `getDb()` inside `fn` (sync and async continuations) resolves to `db`. Err: none (pass-through). Ten: the mechanism HTTP onRequest uses (`create-app.ts:303`), and the fix target of XD-016. Idem: yes. Side: ALS scope ends when `fn` settles.

### dbScopeKey() (`:34-44`)
- Res: `"global"` outside scope; stable `wsN` per pooled handle inside. Purpose: in-memory caches (roster/modules/skills/routing) keyed so workspace A's cached row is never served to B. WeakMap id; rotation = cold cache (safe direction); TTL bounds staleness.

### dbForWorkspace(workspaceId) (`:329-343`)
- Pre: workspace id; record has `databaseUrl`. Res: drizzle handle for the workspace DB. Err: throws `NO_DATABASE` when id falsy or tier resolves local (record-only; env URL NEVER consulted — documented). Ten: THE tenant resolver. Note: dynamic-imports `workspace-gate` (shared → domain import, allowed direction; gate-exempt layer).

### resolveTier / withStoreFallback / dualWrite (`:154-279`)
- resolveTier: URL exclusively from `ctx.databaseUrl` (record-only); env URL is CLI-only. `local` when preference=local, no URL, or outage window.
- withStoreFallback: local-first read; PG only as gap-filler when local empty/throws; PG connection errors degrade to local, logic errors propagate (`:204-236`).
- dualWrite: local commit FIRST (durability), PG replica best-effort, failure queued to outbox (`:248-279`).

### isConnectionError / noteDbFailure / isUrlReachable (`:92-137`)
- Walks `cause` chain ≤5 deep (drizzle wraps driver errors); connection-class codes (ECONNREFUSED family, 08*, 57P0x, 53300) or message heuristics; NO_DATABASE counts as connection-class for fallback purposes. Outage window 20s per URL.

## config/env.ts

### env / appConfig / initConfig (`:118-473`)
- `env` = parsed-at-import singleton (`loadEffectiveConfig`). `appConfig` proxy throws until `initConfig()`. Strict boot: unknown project-prefixed vars throw (`CONFIG_STRICT` default true) (`:333-357`). Redacted report: secret-ish keys masked, `*_URL` reduced to origin (`:385-402`).
- Drift (documented, not fixed): `RETENTION_SWEEP_MS` retired-no-reader (`:184`), `MAX_PARALLEL_AGENTS` deprecated-ignored (`:157`), `DURABLE_EVENTS` deprecated-kept (`:158-159`).

## sockets/

### resolveSocketIdentity / extractHandshakeKey (`socket-auth.ts:31-73`)
- Key sources: `auth.key`, `auth.token`, `Authorization: Bearer`, `x-api-key`. Res: identity `{mode:'apikey', userId:'apikey:<id>', workspaceId:'default', role}` or null. Ten: apikey identity workspace is the `default` placeholder — real workspace comes from `workspace:join`/channel row. Confidence C.

### io.use handshake middleware (`register-socket-server.ts:386-405`)
- keyed identity ?? loopback mint (`local-user`/`default`) ?? reject. Client claims (userId/workspaceId in auth payload) are ignored (SEC-2). Confidence C (tested).

### Room scoping (`room-keys.ts` + `:423-479, 569-672`)
- Channel join derives workspace from the channel ROW (`channelGate.get`), denies `channel_forbidden` when declared workspace differs; legacy null-workspace channels are global by design. Broker fan-out: payload workspaceId authoritative when present, else live-room scan; workspace-room mirror only for payload-tagged channel events; global events scan `ws:*` rooms. Confidence C (tests §30).

### user:message dispatch (`:698-981`)
- Rate limit → mode/pin resolution (channel settings) → one channel row (admission + `msgWorkspaceId` + auto-join) → scoped mention parse + scoped roster (AGT-003) → `messageGate.append` (server-minted author) → bullmq enqueue OR inline `dispatchAgent` serial (§10). Run executor: `executeRunScoped` (`:327-358`) — wraps `runtimeGate.execute` in `runWithDb(await dbForWorkspace(ws))` when a workspace id exists and no test stub; falls back to unscoped on resolver miss/error. Obs: both degrade branches (resolver-null / resolver-throw) emit exactly one structured warn `socket.run.scope_degraded` ({ workspaceId, reason }), try/catch-wrapped so logging can never break the degrade path — SH-005 fixed 2026-10-07, TG-3 tests. Confidence C for dispatch wiring; M for the fallback path's blast radius.

### run:resume (`:983-1067`)
- role gate (operator+) → `runsGate.resumeRun` → bullmq re-enqueue OR inline execution. Inline branch: agent resolve via `agentGate`, then `executeRunScoped` (FIXED this task — was a bare `runtimeGate.execute`, the exact XD-016-cited line). Confidence C.

### run:compensations / approval:decide / approval:list (`:1069-1211`)
- Admin/operator rank gates; approvals funnel resumed runs through `stateGate.applyRunTransition` with workspaceId (XD-009 fix present). Compensations emit via `globalBroker` only when set. Confidence C.

### deps seam (`:312-323`)
- `SocketServerDeps.executeRun` injects a stub (CAN-1); when injected, `executeRunScoped` short-circuits to the stub (`:329`) — tenant wrap intentionally disabled for tests. The real (unstubbed) wrapper path is now covered: TG-1 (bound / default-bound / resolver-null) and TG-3 (degrade warn, SH-005) cases in `register-socket-server.test.ts` (28/28 pass, 2026-10-07).

## core/ (contracts, one line each; all gate-exempt helpers)
- `local-file.ts`: workspace folder = registry rootPath ?? `<WORKSPACE_DIR>/<ws>`; default scope `"default"`; per-key `withStoreLock`; JSON/JSONL I/O; path caches invalidated on workspace change. Test-dir override for vitest.
- `outbox.ts`: append/read/remove/count JSONL replay queue; threshold notice 100.
- `workspace-sync.ts`: push (local→PG), pull (PG→local, force option), converge, drainOutbox, rebuild RAG; conflict resolution explicit. Writes channels/agents/messages directly (XD-021 — known bypass, documented).
- `sequence-number.ts`: PG `channel_sequences` upsert allocator (`allocateSequence`) + local fallback; callers pass tx client when in transaction.
- `thread-sequence.ts`: same shape for `thread_sequences` (bootstrap-owned by Threads) — XD-018 split ownership.
- `token-tracker.ts`: usage insert + budget reconcile; `runWithDb` binding (`:240`) for tenant scope.
- `agent-lock-store.ts`: per-workspace lock file, `UNSCOPED_WORKSPACE` sentinel, stale TTL.
- `agent-heartbeat.ts`: 15s touch (via `agentGate.touchHeartbeat`) + 60s orphan sweep (via `agentGate.sweepOrphans`); skips sweep in bullmq mode (worker owns it).
- `redact.ts` / `secret-box.ts` / `loopback.ts` / `url-guard.ts` / `untrusted-wrapper.ts` / `reflection-sanitizer.ts`: security primitives; loopback predicate single-sourced here for both transports.
- `model-routing.ts` + fixtures: task-class → tier resolution; in-memory module table; `MODEL_ROUTE` switch.
- `librarian-runtime.ts` + `index-builder.ts`: channel index/summary maintenance (delta vs full), 10-min stale reindex from socket server; no domain gate (documented XD gap).
- `process-guards.ts`, `structured-log.ts`, `perf-metrics.ts`, `errors.ts`, `validation.ts`, `ttl-cache.ts`, `ulid.ts`, `http-agent.ts`, `http-cache.ts`, `stream-coalescer.ts`, `loop-arbiter.ts`, `tool-expansion-registry.ts`, `google-model-helpers.ts`, `mention-parser.ts`: infra utilities as named.

## Docs sync owed (AGENTS.md §6)
- No re-docs Domain Spec exists for Shared (gate-exempt; `_index.md` has no Shared row). Flow docs referencing the socket path: `Chat send-message flow.md` (inline branch wording), `Recovery and resume.md` (inline resume wording — now tenant-scoped). Both updated 2026-10-07 (SH-003 closed, impl-tenant-tests-6) — tenant-scoping lines now cite the landed TG-1/TG-4 tests; no Ports change (no gate).
