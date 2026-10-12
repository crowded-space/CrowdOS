# Channels

## Purpose
Channel identity store for workspace chat topology. It owns `channels` rows, guards creation/rename against missing categories and duplicate names, hides archived rows from listings, and protects the top-level `#general` channel from deletion.

## Feature Scope
In-scope:
- Channel row CRUD + `db`-overridable reads/writes (`channels` table).
- Category-existence guard on create/update (read-only check against `categories`).
- Case-insensitive duplicate-name guard scoped to `(lower(name), categoryId)`.
- Keyset `(position, id)` listing with legacy numeric-offset fallback. Successful explicit `db` reads retain PostgreSQL offset behavior; in-memory Local/PG union reads cap numeric offsets at 10,000, including when an explicit handle falls back after a schema mismatch. Deeper union pages use keyset cursors. A union read derives active page rows and all shadow IDs, including archived rows, from one workspace-scoped Local snapshot; PG candidates are fetched in batches of at most 200, checked against that snapshot, and paged monotonically until the merged target is filled or PG is exhausted. No Local IDs are bound into PG SQL, and Local rows take precedence for duplicate IDs.
- Archive-via-`type` (`archived` sets `archivedAt`, un-archive clears it) + hard delete with `#general` protection.
- Per-channel composer pins (§6-8): `pinnedRuntime` / `activeAgentId` / `defaultAgentId` on `channel_settings` (null = unset), written through `dualWrite` — local commit first, PG replica second, failed replica leg queued on the outbox (`channelSettings` entity) for replay. §30: keyed by the `(channel_id, workspace_id)` PAIR (composite PK, migration 0020) so two workspaces that each own a channel with the same id keep independent pins.
Non-goals (other domains):
- Category lifecycle, workspace lifecycle → Workspace/Categories paths (this domain only reads `categories.id`).
- Messages, threads, summaries, index rows → Messages/Threads (own `messages`, `channel_index`, `compressed_summaries` FK readers of `channels`).
- Mount resolution (`folderPath` reads/writes) → Channel-Mounts (shares the `folderPath` column).
- File I/O, execution, approvals → Tools/Runtime/Approvals.
- Transport (REST validation, auth, socket rooms) → Routes/Sockets (call the gate/service, emit `workspace:sync` themselves).

## Expect
- 2026-09-17 dual-boot (order corrected 2026-10-07, CHN-032): reads union both tiers (gets: local-first-miss→PG; lists: merged dedupe local-wins); writes commit LOCAL-first through `dualWrite` and feed PG as a best-effort replica, queueing an outbox entry on any replica failure (settings included — CHN-008/009); explicit `db` handle still pins PG exactly.
- `[Observed]` `list` never returns archived rows; `get` can return an archived row (no `archivedAt` filter).
- `[Observed]` `create`/`update` with unknown `categoryId` fail without writing, returning `{ error: category }`. 2026-09-23 tenant guard: a create with no workspace scope (no x-workspace-id header) is rejected before any write instead of silently filing the row under the default folder; category creation also rejects duplicate names in the same workspace (channels already did).
- `[Observed]` Duplicate names are compared case-insensitively (`lower(name)`) within the same category (or both uncategorized); match fails the write with `{ error: duplicate_name }`. PG compares `lower(name)` on both sides (CHN-002), archived rows are excluded from every dup scan on both tiers (CHN-003), renames carry the same guard (CHN-001), and a local guard-failure union never reaches the PG replica leg (CHN-033).
  2026-09-25 audit fix: the duplicate guard is WORKSPACE-SCOPED (`(workspaceId, lower(name), categoryId)`) — previously the union-aware check scanned all workspaces, so a null-category channel named "general" in ws-a blocked creating one in ws-b, and the unscoped local scan could report cross-workspace false duplicates (`channel-service.ts`, regression test in `channel-local-mode.test.ts`).
- `[Observed]` `update`/`delete` on a missing id return `{ notFound: true }`, never throw.
- `[Observed]` Setting `type: archived` stamps `archivedAt`; setting any other type clears `archivedAt`.
- `[Observed]` Deleting the uncategorized channel named `general` (case-insensitive) is rejected with `{ conflictGeneral: true }`, even by id.
- `[Inferred]` `list` limit clamps to 1–200 (default 200); malformed cursors are ignored (no filter) rather than erroring.
- `[Observed]` `getSettings` returns the pin row or null; `updateSettings` rejects unknown `pinnedRuntime` with `{ error: pinned_runtime }` and upserts otherwise (local commit first, PG replica second via `dualWrite`; a failed replica leg queues an outbox entry instead of diverging silently).
- `[Observed]` §30: both take an optional `workspaceId` scope as their last argument. The scope resolves from the caller when given, else from the channel row's own `workspaceId` (server truth), else the documented `"default"` unscoped placeholder — so the legacy 2-arg call shape keeps working. Reads and writes are always constrained to that single scope.

## Flow
1. List: `channelGate.list({ limit, cursor, db })` queries non-archived rows ordered `(position asc, id asc)` (`listChannels` in `channel-service.ts`); `pos:id` cursors seek in both union tiers before paging. One workspace-scoped Local snapshot supplies active page rows and all shadow IDs, including archived rows. Union reads fetch PG in pages of at most 200, check only those candidates against the snapshot, and advance the PG tuple cursor until the merged target is safe or PG is exhausted. No Local IDs are bound into PG SQL. Bare numeric cursors preserve merged-list semantics up to offset 10,000 on the union path; larger union offsets fail with keyset guidance and REST returns 400. A successful explicit `db` handle retains uncapped SQL OFFSET behavior, including when the request exceeds 10,000; a schema-mismatch fallback uses the capped union path (`routes/channels.ts:46`).
2. Validate category: `categoryExists(categoryId, db?)` does `findFirst(categories.id)` and returns boolean (`channel-service.ts:39`); `create`/`update` run it in parallel with the main lookup (`channel-service.ts:313-321`, `channel-service.ts:421-424`).
3. Create guard: `createChannel(body, db?)` checks category + duplicate `(lower(name), categoryId)` together (`channel-service.ts:313-321`); unknown category → `{ error: category }` (`channel-service.ts:322-327`), name hit → `{ error: duplicate_name }` (`channel-service.ts:57`).
   2026-09-25 audit fix: `listChannels` accepts and honors a `workspaceId` scope on BOTH tiers (PG: `workspaceId = ws OR workspaceId IS NULL`; local: the workspace's own `channels.json`), and `routes/channels.ts` threads the tenant header. Previously a registry-only workspace's `GET /api/channels` served the default folder's channels regardless of the header (§30 leak). No header keeps the legacy unscoped read.
4. Create write: mints `randomUUID`, inserts `(categoryId, name, type, createdBy, position)` and returns `{ channel }` (`channel-service.ts:328-341`); `POST /api/channels` maps category error to 400 and emits `workspace:sync` on success (`routes/channels.ts:46`, `routes/channels.ts:52`).
5. Read: `getChannel(id, db?)` returns the row or `undefined` with no archived filter (`channel-service.ts:409`); socket room admission uses it as existence check AND as the source of the §30 room scope (`register-socket-server.ts` `resolveChannelRoom`).
6. Update: `updateChannel(id, body, db?)` returns `{ notFound: true }` on miss (`channel-service.ts:418`), `{ error: category }` on bad category (`channel-service.ts:91`), patches only supplied fields (`channel-service.ts:95`), stamps/clears `archivedAt` on `type` change (`channel-service.ts:101`), returns `{ channel: updated }` (`channel-service.ts:110`); `PATCH|PUT /api/channels/:id` map to 404/400 and emit `workspace:sync` (`routes/channels.ts:61`, `routes/channels.ts:72`).
7. Delete: `deleteChannel(id, db?)` returns `{ notFound: true }` on miss (`channel-service.ts:577`), `{ conflictGeneral: true }` when `categoryId === null && name.lower === general` (`channel-service.ts:582-583`), else hard-deletes and returns `{ deleted: true }` (`channel-service.ts:122`); route maps to 404/409, emits `workspace:sync`, returns 204 (`routes/channels.ts:96`).
8. Pins: `getChannelSettings` reads local-first-miss→PG (an explicit `db` handle pins PG-first); `updateChannelSettings` validates `pinnedRuntime` against the five runtime types then runs `dualWrite` — local upsert commits FIRST, the PG pin upsert (`ON CONFLICT (channel_id, workspace_id)`, pin columns only) is the replica leg, and any replica failure queues a `channelSettings` outbox entry for replay; `GET|PATCH /api/channels/:id/settings` expose them with agent-existence 400s, an unknown-channel 404, and null-clears (`routes/channels.ts`). §30: both resolve a workspace scope first (explicit arg → channel row's `workspaceId` → `"default"` with a warn) and constrain every read/upsert/update to `(channelId, workspaceId)`; the routes pass the tenant hook's `request.workspaceId` through. Socket dispatch consumes pins: unset mode → channel `pinnedRuntime` before Auto; unmentioned messages → `activeAgentId` → `defaultAgentId` → category owner → L0 → default-assistant (`register-socket-server.ts`).

## Current Implementation
| File | Role |
| ---- | ---- |
| `channel-types.ts` | Pure types, no I/O. `Category`/`ChannelType`/`Channel`/`ChannelIndex`/`CompressedSummary` shapes |
| `channel-validators.ts` | Zod boundary. `channelTypeSchema` (`standard/pair_private/archived`), `createChannelSchema`, `updateChannelSchema`, `paramIdSchema` plus inferred `CreateChannelBody`/`UpdateChannelBody`/`ChannelParams` |
| `channel-service.ts` | DB owner. `categoryExists`/`listChannels`/`createChannel`/`getChannel`/`updateChannel`/`deleteChannel` + category CRUD (`getCategoryById`/`listCategories`/`createCategory`/`updateCategory`/`removeCategory`), all `db`-overridable; file truth (`channel-local-store.ts`) when no `DATABASE_URL` |
| `channel-local-store.ts` | File truth for categories/channels (`<workspaceFolder>/vfs/.crowdos/categories.json`, `channels.json`) plus pin rows (`channel-settings.json`); same guards (category-exists, duplicate-name, `#general` protection, category-delete cascade). Canon 2026-09-22: rows live inside their workspace folder, and `fsMounts` (`inherit`/`override`) rides each row |
| `channel-gate.ts` | Thin facade, wire + re-export only. Re-exports types/validators/service verbatim; `channelGate` maps `categoryExists/getCategory/listCategories/createCategory/updateCategory/removeCategory/list/get/create/update/remove/getSettings/updateSettings/seedLocalPresets` |
| Key types/functions | `Channel` (id/categoryId/name/type/createdBy/position/createdAt/archivedAt?); `createChannel` returns `{ channel } \| { error }`; `updateChannel` returns `{ channel } \| { notFound } \| { error }`; `deleteChannel` returns `{ deleted } \| { notFound } \| { conflictGeneral }` |

## Ports
- `Category` — category record type.
- `ChannelType` — `standard | pair_private | archived` type.
- `Channel` — channel record type.
- `ChannelIndex` — channel index record type.
- `CompressedSummary` — compressed summary record type.
- `channelTypeSchema` — zod validator for channel type.
- `createChannelSchema` — zod validator for creation body.
- `updateChannelSchema` — zod validator for update body.
- `paramIdSchema` — zod validator for id params.
- `CreateChannelBody` — creation body type.
- `UpdateChannelBody` — update body type.
- `ChannelParams` — id param type.
- `categoryExists` — checks category existence, optional `db` override.
- `listChannels` — lists non-archived channels by `(position, id)`; Local/PG union reads derive active page rows and all scoped IDs, including archived rows, from one Local snapshot, then fetch PG candidates in bounded pages, checking each batch against that snapshot before merging and topping up. No Local ID list is sent to PG. Union numeric-offset cursors preserve merged-list semantics through offset 10,000; larger union offsets throw a named limit error. A successful explicit `db` override retains PostgreSQL OFFSET behavior without this union cap; schema-mismatch fallback uses the union cap.
- `getChannel` — gets one channel by id, optional `db` override.
- `createChannel` — creates channel with guards, optional `db` override.
- `updateChannel` — updates channel by id, optional `db` override.
- `deleteChannel` — hard-deletes channel by id with `#general` guard, optional `db` override.
- `channelGate.categoryExists` — alias of `categoryExists`.
- `channelGate.getCategory` — alias of `getCategoryById` (null when missing).
- `channelGate.listCategories` — categories with nested channels (limit 100 each).
- `channelGate.createCategory` — creates a category row.
- `channelGate.updateCategory` — patches a category row, null when missing.
- `channelGate.removeCategory` — deletes a category (channels cascade), false when missing.
- `channelGate.list` — alias of `listChannels`.
- `channelGate.get` — alias of `getChannel`.
- `channelGate.create` — alias of `createChannel`.
- `channelGate.update` — alias of `updateChannel`.
- `channelGate.remove` — alias of `deleteChannel`.
- `ChannelSettingsPatch` — `{ pinnedRuntime?, activeAgentId?, defaultAgentId? }` (null clears) type.
- `channelGate.getSettings` — pin row by `(channelId, workspaceId)`, null when unset; an explicit `db` handle pins PG-first (local fallback). Signature: `getSettings(channelId, db?, workspaceId?)`.
- `channelGate.updateSettings` — validates `pinnedRuntime`, `dualWrite`s the scoped pin row (local commit first; PG replica failure queues a `channelSettings` outbox entry). Signature: `updateSettings(channelId, patch, db?, workspaceId?)`.
- `channelGate.seedLocalPresets` — seeds the default category + `#general` channel into a local workspace folder (idempotent). Signature: `seedLocalPresets(workspaceId)`. Added for CHN-020; `routes/workspace.ts` seeds through this port (allowlist entry removed).

## Relations
Gates this domain calls:
- None at runtime — `categories`/`channels` reads stay in-service (DB or `channel-local-store.ts` files); only shared `shared/config/database.ts` (`getDb`/`isDatabaseConfigured`), `shared/core/local-file.ts`, and `db/schema.ts` are used.
Known outside callers of `channelGate` / service:
- Routes: `routes/channels.ts` (listChannels/createChannel/updateChannel/deleteChannel, never via `channelGate` object); `routes/workspace.ts` (`channelGate.seedLocalPresets` for local workspace seeding).
- Sockets: `Shared/sockets/register-socket-server.ts` (`channelGate.get` for room admission + §30 room scoping in `resolveChannelRoom`; also `getSettings` for the §6-8 pins).
- Tests: `test-setup.ts` (global `channel-gate.ts` mock), `Shared/sockets/register-socket-server.test.ts` (gate import).
- Shared: `shared/core/workspace-sync.ts` owns the settings push/pull/outbox-replay legs for `channel-settings.json` (Shared is gate-exempt; explicit Shared-owned bridge — see CHN-021).
Tables shared with other domains (FK readers, owned elsewhere or jointly):
- `categories.id` ← `channels.category_id` cascade (read-only here; lifecycle owned elsewhere).
- `channels.id` ← `messages.channel_id`, `channel_sequences.channel_id`, `channel_index.channel_id`, `compressed_summaries.channel_id`, `spawn_requests.channel_id`, `scheduled_tasks.channel_id` (all cascade readers).
- `channels.folderPath` is co-written by Channel-Mounts (`attachChannelMount`); `channels.workspaceId` is set outside this domain (service never writes either column).

## Emits-Listens
- None emitted in-domain (no broker import in `channel-service.ts` or `channel-gate.ts`); `routes/channels.ts:20` emits `workspace:sync` on create/update/delete outside the gate.

## Owns
- `channels` (writes: insert, `categoryId/name/position/type/archivedAt` updates, hard-delete; never writes `folderPath`/`workspaceId` itself)
- `channel_settings.pinned_runtime/active_agent_id/default_agent_id` (writes: validated upsert, null-clear; `fs_policy`/`safety_settings` columns stay with safety routes — column-split ownership)
- `channel_settings` scope keys `(channel_id, workspace_id)` — the §30 composite PK (migration 0020). This domain owns the pin columns; `routes/safety.ts` writes `fs_policy`/`safety_settings` on the same rows and now carries the same workspace scope. `workspace_id` is written by this domain's settings path and the safety route, never inferred at read time once stored.

## Flags
- None observed — no `process.env` read in `channel-service.ts`, `channel-gate.ts`, `channel-types.ts`, or `channel-validators.ts`.

## Decisions
- `[Observed]` 2026-09-22 canon storage: categories and channels live in the OWNING workspace's `vfs/.crowdos/` (one folder per workspace), not one shared `localstore/`. A channel created under a category inherits that category's workspace unless the caller names one, so the two rows always land in the same folder. Each row carries the canon `fsMounts` descriptor (`inherit`/`override`).
- `[Observed]` Union-return errors (`{ error }`/`{ notFound }`/`{ conflictGeneral }`) instead of throws — why: business failures are caller-branchable HTTP mappings (400/404/409), not exceptions.
- `[Observed]` Duplicate check on `lower(name)` scoped to category — why: prevents `General` vs `general` collisions while allowing same name across categories.
- `[Observed]` `list` hides `archivedAt IS NOT NULL` but `get` does not — why: rosters stay clean while direct links/admin reads still resolve archived rows.
- `[Observed]` Archive is a `type` transition that stamps `archivedAt` (and un-archive clears it) — why: single-field UX without a separate archive column write path.
- `[Observed]` Hard `#general` delete guard on `(categoryId null + name general)` — why: top-level default channel can be archived/renamed but never destroyed.
- `[Observed]` Keyset `(position, id)` pagination seeks within each participating tier; one Local workspace snapshot supplies both active page rows and archived-inclusive shadow IDs, checked only against each bounded PG batch. No Local IDs are bound into PG SQL, and the PG cursor advances monotonically until the merged target is filled safely or PG is exhausted. The union path preserves numeric offsets through 10,000; larger union offsets fail with keyset guidance and return HTTP 400 at REST, while a successful explicit `db` keeps uncapped PostgreSQL OFFSET behavior. Explicit-handle schema-mismatch fallback uses the union cap. This avoids repeated Local-file scans and oversized bind lists without changing direct DB pagination.
- `[Observed]` Optional `db` override on every op — why: callers (routes/tests) can pin a workspace DB or fake without ambient `getDb`.
- `[Inferred]` Category validation is existence-only, not ownership/permission-checked — why: membership model lives outside this domain (socket layer notes no per-user visibility model).

## User Decision:

## Architectural Standard (Target)
> Status: Target. New work must satisfy this. Keyset listing and general-guard stay; duplicate and rename rules are the gaps.
Channel identity is case-insensitive at the database level with a uniqueness constraint on lower(name) plus categoryId. Order-dependent application checks are not acceptable.
Renames run the same duplicate guard as creates. Unguarded rename-into-existing is forbidden.
Delete path is explicit: hard-delete with cascade or archive-via-type, chosen per operator contract and documented. Both paths silently coexisting is not acceptable.
Position ordering has an explicit rule: unique ordering helper or documented unordered contract. Silent default-zero pileup is not acceptable.
channels.workspaceId and channels.folderPath have one writer each, exposed via gates. Split ownership without a gate boundary is forbidden.
Route error messages must distinguish duplicate_name from category errors. Copy-paste conflation is not acceptable.
## Failure + Resume
- Unknown category on create/update → `{ error: category }`, route 400 `Category not found` (`channel-service.ts:322-327`, `routes/channels.ts:47`); no partial write (guard runs before insert).
- Duplicate name → `{ error: duplicate_name }`, route 409 `Channel name already exists` (CHN-004/001/002/003 fixed); category stays 400 `Category not found`. Guards are case-insensitive on both tiers, workspace-scoped, archived-excluded, and run on rename as well as create. Pin validation scopes the agent lookup to the caller workspace (XD-004 fixed); category dup check runs inside the mutate lock with union + 409 mapping (CHN-006/006b fixed).
- `dualWrite` guard-failure contract (CHN-033 fixed): a local union result (`{ error }` / `{ notFound }` / `{ conflictGeneral }`) means the write did not commit — the PG replica leg is skipped and nothing is queued, so PG never holds rows the API reported as rejected.
- Settings replica outage (CHN-008/009/032 fixed): local commit stands, the PG leg failure is logged, and a `channelSettings` outbox entry is replayed by `drainOutbox` / `pushWorkspaceToDb`; `pullWorkspaceFromDb` restores pins into `channel-settings.json`.
- Missing id on update/delete → `{ notFound: true }`, route 404 (`channel-service.ts:418`, `routes/channels.ts:62`); `#general` delete → `{ conflictGeneral: true }`, route 409 (`channel-service.ts:582-583`, `routes/channels.ts:99`).
- No retry or resume logic in-domain; listing with bad cursor degrades to unfiltered head page rather than erroring (`channel-service.ts:22`).
- Resume is manual: re-issue the write; deletes are hard (no archive, no undo).

## Gaps
- `ChannelIndex` / `CompressedSummary` types are exported but no reader/writer exists in this folder; their owner (indexer/summarizer) was not traced — possibly stale contracts.
- `create` stores `body.name` verbatim but compares `lower(name)` for duplicates, so `General` and `general` collide yet casing is preserved — display-vs-identity intent unverified.
- `delete` is hard-delete with cascade to messages/sequences/indexes; whether hard-delete vs archive-via-`type` is the intended operator path is unverified.
- `position` has no uniqueness or reorder helper; concurrent creates with default `position 0` ordering behavior is unverified.
- `channels.workspaceId` and `channels.folderPath` are invisible to this domain's writes but present in schema; their writers (Workspace vs Channel-Mounts) split ownership — see ChannelMounts doc.
- CHN-010 partial: unresolved settings scope degrades to `"default"` with a loud warn; reject/retry semantics for an unknown scope are still unimplemented.
- §30 `channel_settings` is scoped per workspace, but `channels.workspaceId` still has no writer in this domain — a channel created without a workspace lands in the `"default"` settings scope. Whether the workspace writer should also backfill settings scope is unverified.
- The `(channelId, workspaceId)` settings scope resolution reads the channel row on every call when no explicit scope is passed; the socket dispatch path passes no scope, so it pays one extra channel read per settings lookup. Whether that read should be memoized (channel workspace is immutable after create) was not decided.
