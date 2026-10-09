# Channels Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: `packages/server/src/channels/` (6 files), facade `channel-gate.ts`, transports `routes/channels.ts` + `routes/categories.ts`, persistence (schema + migrations 0012/0017/0020/0021), local file tier, callers (mounts, messages, sockets, runtime middleware, shared core), tests, docs.
Method: full read of every domain file and every cross-domain importer; grep across packages; typecheck + focused vitest runs (read-only). No production file modified. Time-boxed: some deep links (settings-sync wipe paths) are marked Low confidence.
Baseline git state: branch `main`; working tree pre-dirty with unrelated modifications; nothing committed/staged by this audit.

## 1. Domain files (all read)

| File | Role |
| --- | --- |
| `channel-gate.ts` | Facade. 11 type re-exports, 6 validator re-exports, 13 bare function re-exports, `channelGate` object with 13 ports (aliases). Wire + re-export only. |
| `channel-service.ts` | All logic: category CRUD + channel CRUD + settings pins. Dual-tier (local file first, PG replica / merged reads). `db`-overridable on every op. |
| `channel-local-store.ts` | File truth: `<workspaceFolder>/vfs/.crowdos/{categories,channels,channel-settings}.json`. Guards mirrored (tenant, dup, #general, cascade). |
| `channel-types.ts` | Pure types: `Category`, `ChannelType`, `Channel`, `ChannelIndex`, `CompressedSummary`. |
| `channel-validators.ts` | Zod: `channelTypeSchema`, `fsMountSchema`, `fsMountsSchema`, `createChannelSchema`, `updateChannelSchema`, `paramIdSchema` + inferred types. |
| `channel-local-mode.test.ts` / `channel-settings.test.ts` | In-domain tests (local tier only, no PG). 13 tests, all pass. |

## 2. Facade surface (exact, channel-gate.ts:1-73)

Type re-exports (l.38,40,42): `Category, ChannelType, Channel, ChannelIndex, CompressedSummary, ChannelSettingsPatch, CreateChannelBody, UpdateChannelBody, ChannelParams, FsMountBody, FsMountsBody`.
Value re-exports (l.39,41,43-57): `channelTypeSchema, createChannelSchema, updateChannelSchema, paramIdSchema, fsMountSchema, fsMountsSchema` + bare functions `categoryExists, getCategoryById, listCategories, createCategory, updateCategory, removeCategory, listChannels, getChannel, createChannel, updateChannel, deleteChannel, getChannelSettings, updateChannelSettings`.
`channelGate` object (l.59-73): `categoryExists, getCategory(=getCategoryById), listCategories, createCategory, updateCategory, removeCategory, list(=listChannels), get(=getChannel), create(=createChannel), update(=updateChannel), remove(=deleteChannel), getSettings(=getChannelSettings), updateSettings(=updateChannelSettings)`.

Dual surface: routes use the BARE named exports (routes/channels.ts:3-13, routes/categories.ts:4-9); sockets/mounts/runtime/shared use the `channelGate` object. Both must stay in sync (AGENTS.md `2 contract = gate shape).

## 3. Entry points

- REST: `GET/POST /api/channels`, `PATCH|PUT /api/channels/:id`, `GET/PATCH /api/channels/:id/settings`, `DELETE /api/channels/:id` (routes/channels.ts); `GET/POST /api/categories`, `PUT|PATCH /api/categories/:id`, `DELETE /api/categories/:id` (routes/categories.ts). Registered in routes/index.ts:26-29. Auth: global default-deny API-key + loopback trust (create-app.ts:347); tenant scope from `x-workspace-id` (create-app.ts:235-318).
- Sockets: `channel:join/leave` (register-socket-server.ts:551-568, 634-648), `user:message` (l.680-724) → `channelGate.get` for admission/room scope, `getSettings` for pins (l.701, 808), `getCategory` (l.821).
- Runtime: channel-awareness middleware `channelGate.get/getCategory` (channel-awareness-middleware.ts:27-32).
- Shared core: agent-lock-store.ts:72, token-tracker.ts:59, workspace-sync.ts:46/74/213/238/287/339/532/641 (file rows + types).
- Jobs/CLI: outbox drain (create-app.ts:385-390) replays channel/category entries (workspace-sync.ts replayEntry); workspace creation seeds via `localCreateCategory/localCreateChannel` (routes/workspace.ts:274-278); db/seed.ts seeds #general + categories directly (PG).
- UI: client crowdOsStore.ts:3436-3625 (CRUD), 1986-2046 (pins), api/client.ts:355-392.

## 4. Dependency map (Caller → Facade → Service → Port → Adapter)

    routes/channels.ts ── bare fns ──┐
    routes/categories.ts ────────────┤
    channel-mounts/channel-mount-service.ts ── channelGate object ──┤
    shared/sockets/register-socket-server.ts ───────────────────────┤
    runtime/kernel/middlewares/channel-awareness-middleware.ts ─────┤
    shared/core/{agent-lock-store,token-tracker}.ts (dynamic) ──────┤
      → channels/channel-service.ts
          ├─ channel-local-store.ts → shared/core/local-file.ts → <ws>/vfs/.crowdos/*.json   [COMMIT POINT, local-first]
          ├─ shared/config/database.ts getDb()/dualWrite() → drizzle → postgres-js → PG (channels, categories, channel_settings)
          ├─ workspace/workspace-gate.ts tierContextFor()          (gate-to-gate, one-way)
          └─ shared/core/outbox.ts appendOutbox() → outbox.jsonl → workspace-sync.drainOutbox replay (entity channel/category)
    shared/core/workspace-sync.ts ── direct file access: categories.json/channels.json (type import LocalChannelRow/LocalCategoryRow)  [Shared exempt, but owns row writes]
    routes/workspace.ts ── dynamic import channel-local-store (BYPASS, allowlisted in check-gates.mjs KNOWN_VIOLATIONS)

Cycles: none introduced. Hidden deps: none in-domain; module-level mutable state only via shared helpers. Global state: local-file per-file promise mutexes (single-process only), TtlCache folder cache (2s).

## 5. Persistence

- PG: `categories` (schema.ts:256-270), `channels` (272-291, indexes: category, archived+position; NO workspace/name unique), `channel_settings` (1045-1058, PK (channel_id, workspace_id), migration 0020). Migrations: 0012 (channels.workspace_id), 0017 (pins), 0020 (settings workspace PK), 0021 (fs_mounts jsonb).
- FK readers of channels.id: messages, channel_sequences, channel_index, compressed_summaries, spawn_requests, scheduled_tasks (all cascade) — hard delete cascades.
- Local: JSON arrays under the owning workspace folder; ISO-string dates revived on read; fsMounts defaulted to inherit on read.
- Settings are NOT part of outbox replay nor workspace-sync push/pull (replayEntry switch covers category/channel/agent/message only — workspace-sync.ts:404-450; grep finds no channelSettings in workspace-sync).

## 6. Auth / tenant / ownership

- REST: tenant header → request.db pin + request.workspaceId (create-app.ts). Routes thread workspaceId into list/create/createCategory/settings; update/delete do NOT thread it (updateChannel/deleteChannel take no workspaceId).
- Domain tenant guards: createCategory throws without workspaceId (non-db); createChannel fails closed to `{error:"category"}` without a resolvable workspace; dup guards scoped by workspace.
- categoryExists / getCategoryById / getChannel are UNSCOPED lookups (search all local workspaces for gets); createChannel validates the parent category unscoped → a category from workspace B satisfies a create into workspace A (cross-workspace parent reference).
- Settings scope: explicit arg → channel row workspaceId → "default"; never throws (degrades to default).

## 7. Tests / baseline (run 2026-10-06)

- `npx vitest run src/channels/channel-local-mode.test.ts src/channels/channel-settings.test.ts` → 2 files, 13 tests PASS.
- `npx vitest run src/channel-mounts/channel-mount-gate.test.ts src/routes/index.test.ts src/shared/core/workspace-sync.test.ts` → 3 files, 61 tests PASS.
- `npx vitest run src/runtime/local-chat-e2e.test.ts src/events/events-integration.test.ts` → 2 FAILED (pre-existing, unrelated: "Agent default-assistant has no model module"), 1 passed.
- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `node scripts/check-gates.mjs` → exit 0, 0 violations, 46 test-only findings, 3 allowlisted (one is routes/workspace.ts → channels/channel-local-store.js).

## 8. Docs

- `re-docs/Backend Docs/Domain Spec/Channels.md` (draft) + `Feature and Flow Spec/Channels and archive.md` (drifting). Drift: doc claims the service never writes `workspaceId` (create does, channel-service.ts:388), claims "no cross-domain deps at runtime" (calls workspace-gate tierContextFor), and several line numbers are stale. Recorded CHN-023; doc sync deferred per this turn's read-only scope (AGENTS.md `6).
