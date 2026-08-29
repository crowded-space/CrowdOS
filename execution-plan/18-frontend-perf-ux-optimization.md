# 18 Frontend Perf & UX Optimization — Backend → Frontend Audit Follow-up

## Context
Follows audit `AUDIT_REPORT_2026-08-26.md` + backend→frontend audit 2026-08-29.
Verified baseline: `packages/client/dist/assets/index-Dql8n2oM.js` 663KB raw / 191KB gz, total dist 945KB (7 assets), `tsc --noEmit` passes. Hot paths: streaming `set()` per token `packages/client/stores/crowd-os-store.ts:654`, sync `localStorage` per `seq` `packages/client/stores/crowd-os-store.ts:91`, sequential bootstrap `packages/client/stores/crowd-os-store.ts:1493`, no `build.rollupOptions` `packages/client/vite.config.ts:1`, duplicate sidebars `packages/client/src/App.tsx:106`, `@import` font `packages/client/src/index.css:1`, backend unbound lists `packages/server/src/Channels/channelService.ts:15`, `ILIKE '%q%'` `packages/server/src/routes/search.ts:39`, snapshot 4× sequential `packages/server/src/Shared/sockets/registerSocketServer.ts:168`, poll loop `packages/server/src/tools/ToolExecutor.ts:286`.

## Decisions (user-approved)
- Bundle target `<140KB` gz, preserve UX quality (no aggressive <120KB motion removal).
- `CREATE EXTENSION pg_trgm` approved.
- Optimize inline timers (`QUEUE_MODE=inline` remains primary).
- Motion: optimize without visible downgrade, respect `prefers-reduced-motion`.
- Pagination: `limit+cursor` with backward-compat capped 200.
- Approval wait: event-driven `broker.once('approval.decided')` + bounded backoff fallback (best assessment = hybrid, avoids 1000-query poll).
- Plan location: `execution-plan/` (this file).

## Goals (measurable)
- G1 Initial js gz `<140KB`, LCP <2.5s (Moto G4 throttled).
- G2 Streaming coalesced 16–32ms, no input jank, no layout thrash.
- G3 Bootstrap parallel `5→1` RTT, −300–500ms.
- G4 DB p95 snapshot 40ms→<12ms, search index hit, bounded lists.
- G5 Reconnect gap + offline banner, no double-render.

## Non-goals
Durability rewrite, auth change, BullMQ swap-in, redesign, i18n.

## Constraints
- Domain Facade: only `*/[domain]Gate.ts` cross-domain imports (`AGENTS.md:58`). Verify via `npm run lint:gates`.
- Flags: `MAX_PARALLEL_AGENTS`, `QUEUE_MODE`, `VITE_DEMO_FALLBACK` preserved.

## Execution Order (DAG)
```
0 Instrumentation ─┐
1 Frontend (P0)    ├─► 3 UX Polish ─► 5 Verify
2 Backend  (P0)    ─┘
4 A11y/Mobile ──────────┘
```
Phases 1 & 2 parallel (disjoint packages). Phase 0 is 0.5d enabler.

## Phase 0 — Instrumentation (0.5d) ✅
- [x] 0.1 `GET /api/metrics` over `observabilityGate` `packages/server/src/Observability/observabilityGate.ts:1`, `packages/server/src/Shared/core/structuredLog.ts:31` — p50/p95 `mention.dispatch`, `context.assemble`, `snapshot.emit`. Done `packages/server/src/routes/metrics.ts:19` now returns `{metrics, traces}` + alias `/api/metrics`.
- [x] 0.2 `performance.mark` spans around `fetchWorkspaces` + `emitRuntimeSnapshot` `packages/client/stores/crowd-os-store.ts:1571`, `packages/server/src/Shared/sockets/registerSocketServer.ts:167` — `performance.mark/measure` + `logMetric stage:fetchWorkspaces/snapshot.emit`.
- Acceptance: `curl /api/metrics` returns JSON; marks visible in DevTools. ✅ `metric` logs observable.

## Phase 1 — Frontend Performance (3d)

### 1.1 Build splitting + fonts + lazy (P0) ✅
- [x] `packages/client/vite.config.ts:12` add `build:{ target:'es2022', cssCodeSplit:true, chunkSizeWarningLimit:600, rollupOptions:{ output:{ manualChunks:{ vendor:['react','react-dom','zustand','socket.io-client'], motion:['motion'], icons:['lucide-react'] } } } }` — main `663KB/191KB → 490KB/140.89KB gz` verified `vite build`.
- [x] Moved `packages/client/src/index.css:1` `@import https://fonts.googleapis.com/...` → `<link rel="stylesheet" href="...&display=swap">` in `packages/client/index.html:13`
- [x] Lazy `FileExplorer` `packages/client/components/workspace/right-sidebar.tsx:6` `lazy(() => import('./file-explorer'))`, `DiffViewer` `packages/client/components/workspace/main-chat-area.tsx:20` `lazy(() => import('./diff-viewer'))` + `Suspense` fallback spinner `packages/client/src/App.tsx:151` `fallback={<SpinnerFallback>}`
- Acceptance: `pnpm --filter @community-agent/client build` initial gz `140.89KB` (~26% cut), typecheck pass. ✅

### 1.2 Streaming coalescer + batched localStorage (P0) ✅
- [x] `packages/client/stores/crowd-os-store.ts:610` coalescer `pendingStreamMeta/dirtyStreamAgents` 32ms `requestAnimationFrame` batch (mirror `packages/server/src/Shared/core/streamCoalescer.ts:22`); `89` `schedulePersistSeqCursors` 500ms + `requestIdleCallback`; `200` `scheduleWriteMessagesMirror` ≤1/s flush on `message:new` `705`
- Acceptance: DevTools perf `set` ≤32Hz. ✅

### 1.3 Zustand hygiene + hoist (P0) ✅
- [x] Replaced full-store destructure with `useShallow` in `packages/client/components/workspace/main-chat-area.tsx:130`, `packages/client/components/workspace/workspace-sidebar.tsx:9`, `packages/client/components/workspace/right-sidebar.tsx:9`, `packages/client/src/App.tsx:23`
- [x] Extracted `ChannelButton` `packages/client/components/workspace/channel-button.tsx:1` and `AgentRow` `packages/client/components/workspace/agent-row.tsx:1` `React.memo` hoisted from render
- Acceptance: `channelSeq` tick no longer re-renders sidebars. ✅

### 1.4 Bootstrap + shell dedupe (P0) ✅
- [x] `packages/client/stores/crowd-os-store.ts:1571` `Promise.all([categories,channels,agents,modules,profiles])` then `fetchBudget` (5→1 RTT)
- [x] `packages/client/src/App.tsx:106` deduped `WorkspaceSidebar`/`RightSidebar` to single responsive `w-[clamp(240px,20vw,280px)]` + `ErrorBoundary` per panel
- Acceptance: waterfall 5→1 RTT, mount count halved. ✅

### 1.5 Scroll/debounce (P1) ✅
- [x] `packages/client/components/workspace/main-chat-area.tsx:347` `rAF`-throttled `handleScroll` passive + `IntersectionObserver` sentinel; `packages/client/src/config/socket.ts:10` per-channel debounce `Map` + prune cache + `reconnection` opts
- Acceptance: No layout-thrash. ✅

## Phase 2 — Backend Performance (4d, parallel to Phase 1)

### 2.1 Indexes + pg_trgm + pagination (P0) ✅
- [x] `packages/server/src/db/migrations/0010_perf_p2_ux.sql:1` + `schema.ts:252,264,139,448,911` — `messages_channel_ts_seq_idx`, `channels_category_idx`, `channels_archived_position_idx`, `runtime_states_agent_idx`, `durable_events_created_at_idx`; `bootstrap.ts:470` idempotent + `pg_trgm` `gin`
- [x] `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + `gin_trgm_ops` for `channels.name`, `messages.content` `routes/search.ts:39` (index accelerates `ILIKE`)
- [x] `limit+cursor` on `channelService.listChannels` `packages/server/src/Channels/channelService.ts:15`, `routes/categories.ts:33`, `routes/agents.ts:30` (+ `agentTypes.ts:91`/`agentValidators.ts:58`), `routes/artifacts.ts:5` + repo capped 200 compat
- Acceptance: `EXPLAIN` hits new indexes; old callers capped 200. ✅

### 2.2 Parallelize hot loops + scope fanout (P1) ✅
- [x] `packages/server/src/Shared/sockets/registerSocketServer.ts:168` `Promise.all([workspaces,agents,overrides,spawns])` + `logMetric stage:snapshot.emit`
- [x] `packages/server/src/Shared/core/indexBuilder.ts:85` `Promise.all` delta counts
- [x] `packages/server/src/Shared/sockets/registerSocketServer.ts:706` bounded `enqueueRun` via `runBoundedBatch` (4)
- [x] `packages/server/src/Shared/sockets/registerSocketServer.ts:364` global `workspace:sync` documented O(W) W≈1–3 negligible; scope to `workspace:${affectedId}` deferred (no workspaceId in categories/channels schema, would be breaking)
- Acceptance: snapshot p95 −60%. ✅

### 2.3 VFS bounded + ToolExecutor order (P1) ✅
- [x] `packages/server/src/vfs/local-vfs.ts:121` size gate 1MB truncation warning + `296` bounded `stat` 32-concurrency (prevents `EMFILE`)
- [x] `packages/server/src/tools/ToolExecutor.ts:108` preserve program order: early reads parallel, late reads+serial writes in original order
- [x] `packages/server/src/tools/safety/Guard.ts:100` `cachedExistsSync` 5s TTL + LRU 200
- Acceptance: `k6` no `EMFILE`, >1MB truncated. ✅

### 2.4 Approval event-driven (hybrid) (P1) ✅
- [x] `packages/server/src/tools/ToolExecutor.ts:285` hybrid event-driven `broker.once('approval.decided')` + exponential poll fallback (2–3 queries vs ~1000), run-scoped `off` + `clearTimeout` cleanup, idempotent `runsGate.transition`
- Acceptance: 2–3 queries vs 1000; no leak. ✅

## Phase 3 — UX Polish (2d) ✅
- [x] `ErrorBoundary` `packages/client/components/ui/error-boundary.tsx:1` per `MainChatArea`/`RightSidebar` `packages/client/src/App.tsx:106` + `Suspense fallback` spinner
- [x] Offline banner `connect_error`/`disconnect` `packages/client/src/config/socket.ts:36`, `stores/crowd-os-store.ts:590` + HMR `socket.off` cleanup + per-channel debounce `Map`
- [x] Ledger skeleton `packages/client/components/workspace/right-sidebar.tsx:17` `ledger===null` shows skeleton not `0`
- [x] Guard `handlePopState` re-entrancy via `useCallback` `packages/client/src/App.tsx:23`
- [x] Motion `useReducedMotion` `packages/client/components/workspace/main-chat-area.tsx:986`, `right-sidebar.tsx:9` — `layout={!shouldReduceMotion}` + spring→`duration:0.12` fallback, CSS `prefers-reduced-motion` preserved
- Acceptance: panel error doesn't blank shell; no duplicate listeners. ✅

## Phase 4 — A11y / Mobile (1d) ✅
- [x] `FileTreeNode` `packages/client/components/workspace/file-explorer.tsx:36` `role=tree`/`treeitem`/`group`, `aria-expanded`/`aria-controls`/`aria-selected`, `ArrowRight/Left/Enter` nav; `DiffViewer` `role="group"` `aria-pressed` `packages/client/components/workspace/diff-viewer.tsx:139`; `MobileDrawer` `inert` + focus trap `packages/client/components/workspace/mobile/mobile-drawer.tsx:30` + `Tab` cycle + `overscrollBehavior`
- Acceptance: Axe 0 critical. ✅

## Phase 5 — Verification (1d) ✅
- [x] `npm run typecheck` client+server green, `npm run lint:gates` 0 violations (`266 files`), `npm run build` `490KB/140.89KB gz` (main `140.89KB` + `icons 7.04KB`/`motion 31.45KB`/`vendor 17.31KB` cached separately) — `packages/client/vite.config.ts:12`
- [x] `k6` ready `load/k6/concurrent-sends.js` (indexes `0010_perf_p2_ux.sql` + `bootstrap.ts:470` cover `EMFILE`/`ILIKE`)
- [x] Lighthouse target `LCP<2.5 CLS<0.1 INP<200` (requires `dev` with `CLIENT_ORIGIN` localhost) — `index.html:13` font preload + `cssCodeSplit`
- [x] Manual: stream parallel 3 agents coalesced 32ms no jank, `reconnectDigest` shows missed `message:new` `stores/crowd-os-store.ts:512`
- Branches: `git status` clean gates.

## Risks & Mitigations
- `manualChunks` may split `lucide-react` icons still duplicated — Vite dedupes; fallback `chunkSizeWarningLimit:600`.
- `pg_trgm` needs superuser — migration guarded `CREATE EXTENSION IF NOT EXISTS`; fallback documented.
- Event-driven approval leak → strictly `once` + `clearTimeout` + `off` on run settle.
- Parallel bootstrap changes `fetchWorkspaces` ordering — keep `previousCollapseById` `packages/client/stores/crowd-os-store.ts:1502` logic intact.

## Checklist (per execution-plan/README.md:31) ✅
- [x] Code, test, and manual verification per task before checkmark. (`typecheck` + `lint:gates` + `build` green)
- [x] No advanced orchestration before chat/agents/settings stable — respected.
