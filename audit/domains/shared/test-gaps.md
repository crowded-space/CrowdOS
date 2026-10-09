# Shared Domain (non-auth) — Test Gaps

Baseline commands (packages/server, 2026-10-07):
- `npx tsc -p tsconfig.json --noEmit` → exit 0 (after fix).
- `npx vitest run src/shared/sockets` → 28/28 pass, exit 0 (2026-10-07 sh005-docsync run; the audit-time baseline was 24/24 on the single test file).
- `node scripts/check-gates.mjs` → 4 violations, ALL pre-existing in `threads/thread-service.ts` (not touched by this task; shared/ is exempt).

## Gaps

### TG-1 (S1) — No test proves socket run writes land in the workspace DB (XD-016/ART-2 core claim)
- What exists: socket tests inject `deps.executeRun` stub; `executeRunScoped` short-circuits to the stub (`register-socket-server.ts:329`), so the `runWithDb`/`dbForWorkspace` wrap is never exercised. No test imports `dbForWorkspace` behavior for the socket path.
- Needed: two-DB harness (or fake `dbForWorkspace` returning handle A vs B) — run a socket `user:message` without a stub, assert the executor observes handle A inside the run and that a bare `getDb()` called during execution resolves A. Same for `run:resume` inline branch.
- Why it matters: the S1 defect class (lost / cross-tenant artifact rows) has zero regression coverage today.
- RESOLVED 2026-10-07 (impl-tenant-tests-6): `register-socket-server.test.ts` TG-1 describe runs `setup()` with NO deps (real `executeRunScoped`), channel override `ch-a → ws-a`, `setFakeAls(true)`, and spies `runtimeGate.execute` after `vi.resetModules()`. Three cases: bound (bare `getDb().__workspaceMarker === "ws-a"`), default-bound (channel without workspaceId binds `"default"`), resolver-null (`setWorkspaceDbResolver(() => null)` → executor runs unbound, `boundCalls` empty). Socket dispatch leg only; the resume branch shares `executeRunScoped`, so the wrap is covered transitively — a direct resume-path assertion remains optional.

### TG-2 (S2) — ALS propagation across the fire-and-forget executor call is unverified
- `void executeRunScoped(...)` (resume `:1053`) and the awaited dispatch path both capture ALS at call time; no test asserts async continuations inside the runtime still see the bound handle after the socket handler returns.
- Needed: test that inside `runWithDb(dbA, ...)` a `setTimeout`/`await`-deferred `getDb()` still returns handle A (extend `config/database.test.ts`, which covers sync/simple-async only).
- RESOLVED 2026-10-07 (s1s2-sweep-1): `config/database.test.ts` "keeps the bound handle for deferred continuations after a fire-and-forget caller returns (TG-2)" — a `runWithDb` scope whose caller does not await keeps the bound handle across a `setTimeout` await and a long gated await that resolves after the caller has returned (tags + `dbScopeKey` asserted stable), and the scope does not leak to sibling unscoped work (`dbScopeKey()` stays `"global"` outside). database.test.ts 5/5; database+sockets+queue suites 35/35; tsc exit 0.

### TG-3 (S2) — Fallback path when `dbForWorkspace` throws/misses is silent
- `executeRunScoped` `.catch(() => null)` → unscoped execute; no test covers record-only workspace (NO_DATABASE) to prove the intended degradation, and no log line is emitted on degrade. Needed: unit test asserting unscoped fallback for local-only workspace + (recommended) a warn log.
- RESOLVED 2026-10-07 (sh005-docsync): the unscoped fallback is asserted (resolver-null case in both TG-1 and TG-4 tests: executor runs, no ALS bind, `boundCalls` empty) AND the recommended warn log now exists — `warnDegraded` emits `logWarn({ stage: "socket.run.scope_degraded", workspaceId, reason })` on both degrade branches (`register-socket-server.ts:330-358`; `logWarn` added to `core/structured-log.ts`, try/catch-wrapped so logging can never break the degrade path). New TG-3 cases in `register-socket-server.test.ts`: resolver-null (reason `resolver_null`) and resolver-throw (record-only workspace; NO_DATABASE reason) each assert exactly one structured warn plus unscoped execution. Sockets suite 28/28 pass, exit 0 (sh005-docsync run). SH-005 closed as Fixed-verified in the bug-ledger.

### TG-4 (S2) — Queue worker path (`run-worker.ts:93`) has the same unscoped-execute shape as XD-016 — code FIXED 2026-10-07 (SH-002), test landed 2026-10-07 (impl-tenant-tests-6)
- `processRunJob` called `runtimeGate.execute` directly with `workspaceId ?? "default"` and no `runWithDb`. FIXED this task: `run-worker.ts:100-120` now resolves `dbForWorkspace(workspaceId ?? "default")` and wraps execute in `runWithDb` when a handle resolves (unscoped fallback on NO_DATABASE/unknown workspace; resolver-only catch keeps BullMQ retry semantics). Still needed: same two-DB harness for the worker proving the wrap (assert a bare `getDb()` inside the executor resolves the workspace handle), or thread a scoped wrapper shared by both transports.
- RESOLVED 2026-10-07 (impl-tenant-tests-6): new `queue/run-worker.scope.test.ts` (`__SOCKET_FAKE_DB__` hoisted, fake Job with `updateProgress`/`extendLock`, `setSharedBroker`, seeded agent, spied `runtimeGate.execute` reading bare `getDb()`): bound ws-a / default-bound / resolver-null-unscoped all pass. The shared-helper idea remains optional (three call sites still duplicate the wrap).

### TG-5 (S3) — `config/env.ts` schema has no unknown-key regression test for the retired vars
- `RETENTION_SWEEP_MS`/`DURABLE_EVENTS`/`MAX_PARALLEL_AGENTS` kept parseable; `env.test.ts` exists (14 KB) but no explicit retired-var test found in sweep. Low risk.

### TG-6 (S3) — `workspace-sync.ts` (30 KB) has one 11.9 KB test file; drain/conflict branches unverified
- Not fully traced this pass (time-boxed); flagged for a follow-up read.
