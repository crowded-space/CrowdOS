# Stores

## Purpose

Own all client state in two Zustand stores plus pagination helpers, seed data, and shared types: one god-store (`crowdOsStore`) for workspace/chat/roster/modules/UI, one tiny store (`screenLockStore`) for the lock veil, with localStorage mirrors for restart survival.

## Feature Scope

In-scope: state slices and actions, socket→state ingestion (streaming, presence, approvals, artifacts, budgets, delegation), keyset pagination helpers, localStorage persistence/caps, seed/demo data, shared client types.

Non-goals (other areas): component rendering (each UI doc), lock/unlock UX (LockScreen), app boot/shell/API/socket wiring (Client Infra), server behavior behind the REST/socket contracts.

## Expect

- `[Observed]` `useCrowdOSStore` is a single ~3.2k-line store holding every domain slice: workspaces, agents, messages, 5 module lists, profiles, tools, roles, budgets, UI/layout state, pagination, approvals, artifacts, cancel/c mute/reconnect state (`crowdOsStore.ts:279-475`).
- `[Observed]` Tenant slices (agents, messages, modules, profiles, archived channels) are cleared on workspace switch, on logout-ish leave, and on any failed/partial refresh — never carried across workspaces (`crowdOsStore.ts:2331-2348`).
- `[Observed]` Message mirror in localStorage is capped at 200 per channel; seq cursors persist debounced (~500 ms, `requestIdleCallback` when available) (`messagePagination.ts:15`, `crowdOsStore.ts:99-116,225-246`).
- `[Observed]` With `DEMO_FALLBACK` off (default), backend failure surfaces `workspaceError` and clears slices instead of showing seed data (`crowdOsStore.ts:2028-2039`).
- `[Observed]` Streaming chunks coalesce to ≤32 ms cadence (`requestAnimationFrame` when available) into virtual `stream-<agentId>` messages, replaced by the final `message:new` (`crowdOsStore.ts:698-784,793-873`).
- `[Observed]` `runtime:snapshot` applies overrides always but replaces the agent roster only on workspaceId match; untagged snapshots never clobber the roster (`crowdOsStore.ts:1201-1262`).
  - `[Observed]` `runtime:snapshot` applies overrides always but replaces the agent roster only on workspaceId match; untagged snapshots never clobber the roster (`crowdOsStore.ts:1201-1262`).
  - `[Observed]` Phase D jobs slice: `jobsByRun: Record<runId, jobRow>` (`jobRow { runId; channelId; agentIds; runtime; status; step?; elapsedMs?; tokens?; cost?; firstSeenAt; updatedAt }`) is projected inside the existing `run.status_changed` handler from the same ingestion the header uses — never a second run model, no new socket events/endpoints. Runtime comes from `runtimeType`/`runRuntimeByRun`; step/tokens/cost stay null until a real source provides them (view renders a dash); `elapsedMs` is wall-clock `now - firstSeenAt`. `setJobsByRun(runId, patch)` merges with timestamps; `stopRun(runId)` resolves the channel from `jobsByRun` and calls the existing `cancelRun` transport; `retryRun(runId)` is the existing `POST /api/runs/:id/resume`. No `pauseRun`: the server exposes no pause endpoint (`routes/runs.ts` has only resume/compensations/get). Resumable rows persist across restart via the `crowdos_jobs_by_run` localStorage mirror (cap 200). Narrow `useShallow` selectors; `camelCase` actions.
  - `[Observed]` Phase D inbox: `inboxDeferred: Record<approvalId, true>` + `deferLater`/`undeferInbox` (local-only Later flag — no server defer endpoint exists; deferred ids hide from Pending but stay listed under Later); `inboxItems()` is a DERIVED projector (not a stored slice) over live `approvalRequests` (pending only) + message failures (`turnStatus` failed/cancelled) + channels with `hasMention` set, honoring `inboxDeferred`. Deep-link targets are channel-only via `setActiveChannel`; run/inbox targets arrive via `deep-link.ts`, never invented.
  - `[Observed]` Renderer run-completion notifications honor the structured `isChannelMuted` map (same localStorage source, never raw reads at call sites) with permission gating + background-only rule; the web `Notification` click routes to `applyDeepLink({ channelId, runId })` best-effort. DND is the mute map; no invented DND store.
  - `[Observed]` 2026-10-04 Phase E composer slice: `draftByChannel: Record<channelId, draftRow>` (`draftRow { text; mentionIds; runtime; mountSnapshot { path; source } | null; updatedAt }`) with `setDraft`/`clearDraft`; `outbox: outboxEntry[]` (`outboxEntry { id; channelId; content; mentionIds; runtimeMode; queuedAt; status: queued|failed }`) with `queueSend`/`flushOutbox`/`removeOutboxEntry`; `appliesTo: Record<channelId, 'current'|'next'>` (default `next`) with `setAppliesTo` (`crowdOsStore.ts:133-160,741-761,3934-4033`). Store is source; `crowdos_drafts` (debounced write-through) and `crowdos_outbox` (synchronous write-through) mirrors are restart caches rehydrated at boot (`crowdOsStore.ts:249-345,841-845,1914-1918`). `flushOutbox` runs after gap replay on reconnect, emitting queued rows in `queuedAt` order via the existing `user:message` transport (idempotent by entry id; emit failure marks the row `failed`, never silent loss). Composer restore + offline-queue wiring lives in `MainChatArea.tsx` (draft restore/persist `MainChatArea.tsx:239-271`, offline `queueSend` when `navigator.onLine === false` `MainChatArea.tsx:562-576`, `appliesTo` toggle `MainChatArea.tsx:1551-1553`); palette recent-first ordering reads the `crowdos_palette_recent` mirror (cap 10) owned by `modals/palette-verbs.ts`.
- `[Observed]` Channel switches clear unread/mention badges, persist the channel, push history, rejoin the socket room, and refetch messages + gap digest (`crowdOsStore.ts:2414-2497`).
- `[Observed]` 2026-09-23 QA fixes: budget telemetry (`fetchBudget` and the post-refresh call) is skipped for DB-less workspaces so local mode never hits the PG-only 501; the runtime-snapshot log is demoted to `console.debug`; every store fetch carries `x-workspace-id` via the pin.ts global patch with the active-workspace getter registered at module load.
- `[Inferred]` Selectors (not the store) carry the render-performance burden — nothing in the store memoizes derived data.

## Flow

1. Boot: store initializer hydrates workspaces/agents/profiles/messages/modules/mode from localStorage (with `ws-crowdos`→`crowdos` migration), resolves active channel as hash > persisted > first, and registers all socket listeners (`crowdOsStore.ts:479-567,650-1477`). 2026-10-04 Phase E adds `draftByChannel` + `outbox` mirror rehydration so per-channel drafts and queued sends survive restart (`crowdOsStore.ts:841-845`); composer/sidebar wiring for those slices lives in `MainChatArea.tsx`.
2. Refresh: `fetchWorkspaces` → roster via `apiClient.getWorkspaces()` → 5 parallel tenant GETs (30 s abort) → 401-screenlock locks, 503 marks DB-offline, any other failure clears slices + sets `workspaceError` → maps categories/channels/agents/modules/profiles → persists mirrors → reloads active channel (`crowdOsStore.ts:1708-2049`).
3. Realtime: socket events unwrap `{payload, seq}` envelopes, persist seq per channel, and patch state (messages, presence, tools, approvals, artifacts, run status, delegation, budget, sandbox revision) (`crowdOsStore.ts:131-136,793-1477`).
4. Reconnect: `connect` after a disconnect triggers gap-fetch (`/api/events/recent?afterSeq`) plus a "while you were away" digest banner (auto-clears ~9 s); `disconnect`/`connect_error` show offline banners (`crowdOsStore.ts:568-674`). The endpoint serves the server's §29 event log (real events, `afterSeq` exclusive, `lastSeq` = returned tail or head; `events: []` when caught up) — the store's handling is unchanged and the cursor contract it reads (`{ seq, type, agentId?, payload, createdAt }` + `lastSeq` + `channelId`) is preserved exactly.
5. Paginate: `loadOlderMessages` uses the per-channel keyset cursor (`before=timestamp;seq`) and prepends deduped pages; `cursor: null` means exhausted (`crowdOsStore.ts:2500-2527`, `messagePagination.ts:17-34`).
6. Send/cancel/retry: `addMessage`/`editResend`/`regenerate` emit `user:message`; `cancelRun` emits `user:cancel` with a 5 s optimistic `cancellingByAgent` flag; `retryRun`/`decideApproval`/`applyDiff`/`revertDiff` go through `apiClient` (`crowdOsStore.ts:1532-1565,3367-3430`).

## Current Implementation

| Piece | Role |
|---|---|
| `stores/crowdOsStore.ts` (~3.2k lines) | All slices + ~60 actions + all socket ingestion + REST tenant fetch + localStorage mirrors |
| `stores/screenLockStore.ts` (73 lines) | `locked`/`lastActivity` + lock/unlock; delegates PIN to `pin.ts`, refetch to `crowdOsStore` |
| `stores/messagePagination.ts` (56 lines) | `PageCursor`, `encodeBeforeParam`, `parseMessagesEnvelope`, `prependOlderMessages`, `capMessagesMirror` |
| `stores/initialData.ts` | Seed data: 5 tools, 4 roles, 3 model profiles, 4 instruction + 2 model + 2 toolkit modules, 5 agents, default workspace, 1 system message |
| `types/crowdOs.ts` | `Agent`, `Message` (+`DelegationInfo`, `ToolExecution`, turn steps), `Channel`, `Category`, `Workspace`, 5 module types, `RuntimeOverride`, `Tool`, `Role`, `ComposerMode` + `COMPOSER_MODE_META` |

## Props & Store

No props (stores, not components). `CrowdOSState` (`crowdOsStore.ts:279-475`) groups: data slices, budget telemetry, selection/UI (sidebars, modals, tabs), search, composer mode (`selectedMode`/`isPinned`/`modeByChannel`, persisted only when pinned), async flags (`isFetching/Creating/Updating`, `isDatabaseOffline`, `workspaceError`), pagination (`channelCursors`, `isLoadingOlder`), realtime (`channelSeq`, `reconnectDigest`, `cancellingByAgent`, mute helper), approvals (`approvalRequests`), diffs (`artifactsByRun`). `ScreenLockState`: `locked`, `lastActivity`, `touchActivity`, `setLocked`, `lock`, `unlockWithPin`.

## Relations

- Parents: every feature component selects from these stores (e.g. `App` uses `useShallow` for 6 fields, `App.tsx:36-44`).
- Children: none.
- sibling/helper imports: `socket` + `emitChannelJoin` (`config/socket`), `stripToolCalls` (`@community-agent/shared`), pagination helpers, `apiClient`/`setActiveWorkspaceId` (`api/client`), `screenLockStore` (cycle: screen-lock store also imports `crowdOsStore` for unlock refetch).
- REST: roster/budget/categories/channels/agents/modules/profiles via mixed `apiClient` + bare `fetch` with hardcoded `BACKEND_URL = ''` (relative URLs); PIN on bare calls depends on the global fetch patch (Client Infra).
- Socket subscribes: `connect`, `disconnect`, `connect_error`, `message:new`, `message:stream`, `tool:start/complete`, `agent:status/thinking/spawned/paused/resumed`, `workspace:sync`, `budget:exceeded/warning`, `delegation:start/completed` (as-any), `escalation:created`, `strike:initiated`, `sandbox:updated`, `approval.requested/decided`, `artifact.created/updated`, `diff.created`, `run.status_changed`.

## Emits-Listens

- Socket sent: `channel:join` (debounced helper), `user:message` (send/edit/regenerate), `user:cancel`.
- Socket received: all events listed above; envelope unwrapped (`unwrapEnvelope`), foreign-workspace payloads dropped (only when the server tags `workspaceId`), seq persisted per channel.
- Store actions emitted outward: `incrementFilesystemRevision` (sandbox updates), `reconnectDigest` banners, `Notification` API on background run completion (permission-gated, mute-aware, `crowdOsStore.ts:1452-1466`).

## Owns

In-store: all slices above + module-level (outside React) mutable buffers: `streamParsers`, `pendingMonologueBuffers`, `pendingStreamMeta`, `activeToolMessageIds`, `lastTurnFinishedAt`, join/seq timers, `wasDisconnected`. localStorage keys: `crowdos_workspaces/agents/messages/model_profiles/instruction_modules/model_modules/toolkit_modules/constraints_modules/capabilities_modules`, `crowdos_active_workspace/channel`, `crowdos_selected_mode/is_pinned`, `crowdos_seq_cursors`, `crowdos_mute_*`/`crowdos_muted_channels`, `crowdos_drafts` (debounced write-through per-channel draft cache), `crowdos_outbox` (synchronous write-through queued-send cache), `crowdos_jobs_by_run` (cap 200 resumable run rows). `crowdos_palette_recent` (cap 10 verb ids, recent-first ordering) is owned by `modals/palette-verbs.ts`, not the store.

## Flags

`DEMO_FALLBACK` (`crowdOsStore.ts:16-29`): `VITE_DEMO_FALLBACK` → `process.env.DEMO_FALLBACK` → default `false`. Off = honest errors + cleared slices; on = silently keep seeded demo data on outage. No other toggles.

## Decisions

- `[Observed]` One god-store instead of per-domain stores — every socket event and every CRUD action lives in `crowdOsStore.ts`.
- `[Observed]` Tenant isolation by wiping: any failed/partial refresh clears slices rather than merging, so stale foreign rows cannot survive (`crowdOsStore.ts:1826-1838,2028-2033`).
- `[Observed]` Roster is tenant-REST-owned; `runtime:snapshot` needs a workspaceId match to touch it, while overrides flow freely (`crowdOsStore.ts:1212-1235`).
- `[Observed]` Local-only mutations with no backend: roles, tool toggles/usage, runtime overrides — never persisted beyond memory.
- `[Observed]` Socket rooms keyed by bare channel id with a client-side foreign-workspace drop; proper per-workspace namespacing deferred in-code (`crowdOsStore.ts:138-149`).
- `[Observed]` Streaming correctness guards: late chunks within 2 s of turn end are dropped; per-agent monologue buffered then attached once (`crowdOsStore.ts:811-834,884-888`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Tenant-wipe isolation plus streaming guards stay; god-store size, hydration safety, HTTP unity, and storage guards are the gaps.
Tenant isolation by wiping on failed or partial refresh stays. Stale foreign rows never survive a workspace switch.
Roster stays tenant-REST-owned with workspaceId-matched snapshot replacement. Overrides flow freely by contract.
LocalStorage mirrors MUST hydrate safely: try-catch parse with schema version plus fallback to empty, never throw during store creation. Corrupt values reset that key with a logged metric.
HMR cleanup MUST cover every subscribed event including agent:spawned, delegation, runtime:snapshot, approval, artifact, run.status_changed, governance. Duplicate handlers after reload are forbidden.
Socket listeners plus streaming buffers MUST NOT live as import side effects with module-level mutable state outside the store. Registration is explicit with disposal.
Prune timers MUST be cleared on dispose. Never-cleared intervals are forbidden.
crowdOsStore to screenLockStore import cycle MUST be broken via events or a shared session module. Direct store-to-store import cycles are forbidden.
All HTTP MUST go through apiClient with x-workspace-id plus PIN headers. Bare-fetch tenant paths alongside apiClient are forbidden.
All store writes MUST use desktop-storage safe helpers with quota guard. Raw localStorage writes alongside an unused quota module are forbidden.
reconnectDigest MUST persist across reload or be explicitly in-memory-only with a documented loss window.
Workspace mutations MUST use PIN-aware apiClient with tenant headers. Bare-fetch mutations are forbidden.
Notifications MUST honor the structured isChannelMuted map, not a raw localStorage check.
  Notifications MUST honor the structured isChannelMuted map, not a raw localStorage check.
  Tray runningCount/pendingApprovals have no live renderer-to-main path: `main/index.ts` constructs the tray with `0/0` and the template renders the idle/disabled form — honest gap, never fake counts. `getRunningCount` exists as an injected dep hook for a future live feed.
Seed timestamps MUST be fixed constants, never import-time Date. Session-relative createdAt is forbidden.
## Failure + Resume

- Roster fetch throws → honest `workspaceError` + cleared slices (fallback off) or silent demo data (fallback on).
- Tenant 401-screenlock → lock + clear; tenant 503 → `isDatabaseOffline` + message, shell stays (no portal bounce); other non-OK → clear + `workspaceError` with 30 s abort bounding hangs.
- Dual-boot (2026-09-18): only categories/channels/agents can fail the tenant refresh — module/profile catalogs degrade to empty (local mode has no catalog tier); `dbSyncStatus` (`GET db-sync`) is advisory and never breaks the shell; `resolveDbConflict`/`syncNow`/`rebuildRag` set `isSyncing` + `workspaceError` and rethrow.
- Message fetch on channel switch fails → warn + keep previous messages (`crowdOsStore.ts:2479-2481`).
- Agent/module/profile mutations set `workspaceError` and rethrow (callers toast); model-profile CRUD uniquely falls back to local mock data on transport failure.
- Reconnect: gap-fetch + digest banner; offline banners auto-clear on next successful join path.
- `cancelRun` flag self-clears after 5 s even with no server ack; `run.status_changed: cancelled` converts buffered stream into a `cancelled` message.
- HMR disposes only a subset of socket listeners (`crowdOsStore.ts:675-680`); newer events re-register duplicates on hot reload.

## Gaps

- KNOWN god-store risks (recorded honestly): (a) ~3.2k lines, single subscriber graph — any broad selector re-renders on unrelated slice churn; (b) socket listeners + streaming buffers registered as import side effects inside `create()`, with module-level mutable state outside the store; (c) HMR cleanup omits newer events (`agent:spawned`, `delegation:*`, `runtime:snapshot`, `approval.*`, `artifact.*`, `run.status_changed`, governance) → duplicate handlers after reload; (d) `JSON.parse` of localStorage mirrors at init is unguarded — corrupt values throw during store creation; (e) `setInterval(...).unref?.()` prune timer is never cleared; (f) store↔screen-lock-store import cycle (`crowdOsStore` imports `screenLockStore`, which imports `crowdOsStore`).
- Mixed HTTP plumbing: tenant fetch uses bare `fetch` (PIN via global monkey-patch) while roster/approvals/artifacts use `apiClient`; `BACKEND_URL = ''` is duplicated in both files.
- `apiClient.setActivePin` is never called anywhere observed, so `apiClient`'s own `x-pin` header path is permanently empty — PIN delivery depends entirely on the `pin.ts` fetch patch.
- `reconnectDigest` is in-memory only (no survival across reload despite the storage taxonomy reserving it).
- One `channelSeq` cursor per channel is fed from two server seq spaces (message `sequenceNumber` via the channel-switch refetch, event `seq` via gap results) while `persistSeq` only ever raises it. Message-derived cursors under-select and replay over-delivers (deduped by id), but an event-derived cursor cannot be pulled back — a per-space cursor pair is the fix. The server side of this is recorded in Events → Gaps and Reconnect digest flow → Open gaps.
- `desktop-storage.ts` (`safeSet` quota-guard) has no observed importers — the store writes raw `localStorage` directly.
- `updateWorkspace`/`deleteWorkspace`/`createWorkspace` use bare `fetch` without PIN-aware `apiClient` and without `x-workspace-id`.
- Desktop notifications ignore `isChannelMuted`'s structured map in favor of the raw localStorage check only.
- Seed data timestamps are generated at import time (`new Date()`), so "createdAt" values are session-relative, not stable.
