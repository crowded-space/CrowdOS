# Shared Domain (non-auth) — Phase 1 Inventory (audit, 2026-10-07)

Scope: `packages/server/src/shared/` minus `auth/` (covered by `audit/domains/shared-auth/`): `config/` (2 src), `core/` (36 src + 14 test files), `sockets/` (4 src + 1 test). This is the gate-exempt cross-cutting layer (AGENTS.md §2: `Shared/`, `lib/`, `config/` exempt) — nothing here owns a gate; consumers import internals directly. That makes it the system's highest-blast-radius folder and the hub for tenant scoping, config, transport, and local-first I/O.
Method: full read of `config/database.ts`, `config/env.ts`, `sockets/*`; export-surface sweep of every `core/*` module; grep-verified caller map; test-file inspection; baseline commands run. READ-ONLY except the XD-016/ART-2 fix (see bug-ledger SH-001) which edited `sockets/register-socket-server.ts` in this task.

## 1. Files

### config/ (tenant + env truth)
| File | Bytes | Role |
| --- | --- | --- |
| `config/database.ts` | 15119 | `getDb()` (ALS store ?? global pool), `runWithDb` (AsyncLocalStorage tenant handle), `dbScopeKey()` cache namespace, `dbForWorkspace` (record-only resolver; throws NO_DATABASE), `resolveTier`/`withStoreFallback`/`dualWrite` (local-first), `isConnectionError`, outage window, `withTransaction`, pool init, `ensurePgVectorExtension` |
| `config/env.ts` | 22959 | dotenv + zod schema (~80 vars), strict unknown-var boot check (`CONFIG_STRICT`), redacted config report, `env` const + `appConfig` proxy + `initConfig` |

### sockets/ (transport hub)
| File | Bytes | Role |
| --- | --- | --- |
| `sockets/register-socket-server.ts` | 60105 (1250 L) | Socket.io server: handshake auth (SEC-2), room scoping (§30), broker fan-out, `user:message` dispatch (§10 serial), `run:resume`, cancellations, approvals, compensations, snapshots, heartbeats. `executeRunScoped` (XD-016/ART-2 tenant wrapper) now used by both dispatch and resume; SH-005 adds a structured degrade warn on the fail-open path. |
| `sockets/socket-auth.ts` | 2568 | `resolveSocketIdentity` (key-first), `extractHandshakeKey`, re-exports `isLoopbackPeer` |
| `sockets/room-keys.ts` | 2361 | One room scheme: `ws:<wsId>` / `ws:<wsId>:channel:<chId>` + parse/classify helpers |
| `sockets/rate-limiter.ts` | 3691 | Per-socket token bucket (SEC-5), env-driven capacity/refill, throttled-event list |
| `sockets/register-socket-server.test.ts` | 46959 | 28 tests: SEC-2 trust, §30 rooms, CAN-1 cancel, §10 serial dispatch; mostly uses the `deps.executeRun` stub seam (TG-1/TG-3 run the real wrapper unstubbed) |

### core/ (grouped by role)
- Persistence/tenant helpers: `local-file.ts` (workspace folder resolution + locked JSON I/O + JSONL), `outbox.ts`, `workspace-sync.ts` (push/pull/converge/drain), `sequence-number.ts`, `thread-sequence.ts`, `token-tracker.ts`, `agent-lock-store.ts`, `agent-heartbeat.ts`.
- Security/privacy: `loopback.ts`, `redact.ts`, `secret-box.ts` (AES-GCM envelope), `reflection-sanitizer.ts`, `url-guard.ts`, `untrusted-wrapper.ts`, `local-mode-guard.ts`, `process-guards.ts`.
- Runtime support: `librarian-runtime.ts`, `index-builder.ts`, `model-routing.ts`, `tool-expansion-registry.ts`, `google-model-helpers.ts`, `http-agent.ts`, `http-cache.ts`, `stream-coalescer.ts`, `loop-arbiter.ts`.
- Infra/misc: `env`-adjacent `errors.ts`, `validation.ts`, `structured-log.ts`, `perf-metrics.ts`, `ttl-cache.ts`, `ulid.ts`, `mention-parser.ts`.

## 2. Caller map (who imports shared internals)
- `shared/config/database.ts` ← agents, approvals, messages, runs, memories, observability, tools, create-app, worker, routes (ALS makes every bare `getDb()` tenant-scoped on request paths).
- `shared/core/local-file.ts` ← channels, agents, messages, channel-mounts, skills, modules, state, events local stores, socket server.
- `shared/core/workspace-sync.ts` ← routes/workspace (sync panel) — direct writes to channels/agents/messages tables (XD-021).
- `shared/core/mention-parser.ts` ← socket server (now scoped, AGT-003), agents tests.
- `shared/sockets/register-socket-server.ts` ← create-app (boot); orchestrates agents/channels/messages/runs/queue/runtime/state/approvals/artifacts(implicit) — the XD-022 hub.
- `shared/core/agent-heartbeat.ts` ← socket server + queue maintenance worker (Q-1 wired).

## 3. Naming (AGENTS.md §1)
- `*.ts` kebab-case: compliant throughout. No `.tsx`. Exempt layer has no gate file (expected — gates only for domains).

## 4. Test surface
- `sockets/register-socket-server.test.ts` (28) — fake DB via `test-setup.ts` (`__SOCKET_FAKE_DB__`), stub executor seam.
- `config/database.test.ts` (ALS/scope), `config/env.test.ts`, `config/local-first-truth.test.ts`.
- core: heartbeat, lock store, failure-modes, http-agent, model-routing, redact, secret-box, stream-coalescer, token-tracker, tool-expansion, ulid, url-guard, workspace-sync (11.9 KB).
- Gaps: TG-1 (socket dispatch scope + degrade warn, real `executeRunScoped`) and TG-4 (worker scope) landed 2026-10-07 in `register-socket-server.test.ts` / `queue/run-worker.scope.test.ts`; TG-2 (deferred ALS) landed in `config/database.test.ts`. A direct resume-path scope assertion remains optional (resume shares `executeRunScoped`; covered transitively). See `test-gaps.md`.
