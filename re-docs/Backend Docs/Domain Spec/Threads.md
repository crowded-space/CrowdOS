# Threads

> Status: implemented · Updated: 2026-10-09 · Sweep scheduled (THR-007), sweep guarded (THR-008), thread-aware indexes (THR-002/004), SET NULL delete rule (THR-005), guarded transitions (THR-006), local tier (THR-003), Messages-owned message-page port (THR-015), single-owner sequences (THR-016), explicit tenant context (THR-025), workspace storage-mode selection aligned (2026-10-09).

## Purpose
Ephemeral sub-conversation lifecycle inside a channel. It owns `threads` rows plus their `thread_sequences` counters, validates parentage against `channels`/`messages`, and serves keyset-paginated thread listings and thread-scoped message reads — while actual message writes go through `messageGate.append` (Messages owns the `messages` table) from route transport.

## Feature Scope
In-scope:
- Thread row CRUD + guarded status moves (`active → archived/expired`, `archived → active`, `expired → archived`; no resurrection) (`threads` table).
- Per-thread sequence-row bootstrap in the same transaction as creation (`thread_sequences`).
- TTL expiry sweep (single-statement bulk archive) with a scheduled caller (`thread-expire` repeatable, 60s) and a manual admin-gated endpoint.
- Thread-scoped message reads with `timestamp;seq` cursor pagination.
- `messageCount`/`lastActivityAt` maintenance entry point.
- Local-first tier (file store) for every read/write when the effective workspace tier is local; workspace DB selection uses the registry or matching `CROWDOS_WS_<ID>_DATABASE_URL` setting.
Non-goals (other domains):
- Message authoring, sequencing, and broadcast → Messages (`messageGate.append` thread-sequence branch; emits `message:new`).
- Channel existence/ownership → Channels (reads via `channelGate.list`/`channelGate.get`; `db/schema.ts` channel reads for PG validation).
- Full-text or channel-wide message queries → Messages.
- Push/transport fan-out → Sockets (no broker use in this domain).

## Expect
- `[Observed]` New threads default to ephemeral with a 24h TTL; only ephemeral threads with `ttlHours > 0` get an `expiresAt`.
- `[Observed]` `create` never throws for bad references — it returns `{ error: "channel_not_found" | "parent_not_found" }` and the route maps both to 404.
- `[Observed]` One thread per parent message: the partial unique index `threads_parent_message_idx` (migration 0026) rejects a second thread; `create` maps the 23505 race to the existing winner (`created: false`) instead of a 500 (THR-004, drizzle cause-chain walk at `thread-service.ts:17`).
- `[Observed]` `list` hides non-`active` threads unless `includeArchived` is set; limit clamps to 1–200 (default 50), and Local and DB tiers both honor keyset and numeric-offset cursors.
- `[Observed]` `update`/`delete` on a missing id return `{ notFound: true }`, never throw; every non-active transition stamps `archivedAt` once (never overwritten) and illegal moves return `{ error: "illegal_transition" }` → HTTP 409 (THR-006).
- `[Observed]` `getMessages` returns messages oldest-first with `hasMore`-driven `nextCursor` taken from the oldest returned row; an unknown thread returns `{ error: "thread_not_found" }`.
- `[Observed]` `archiveExpiredThreads` only touches `active` rows with a past non-null `expiresAt`, and reports how many it archived.
- `[Observed]` Deleting a thread SET NULLs its replies' `thread_id` — replies survive as channel messages, never dangle (THR-005, `thread-service.ts:222`).
- `[Observed]` Every operation selects Local or DB from its explicit workspace context; a workspace URL can select the DB tier even when the process-wide `DATABASE_URL` is unset. Local-tier operations, including `get` and `getMessages`, use that workspace's file store (THR-003). Local channel scope discovery and expiry traversal follow the Channel gate's `(position,id)` cursor pages, so channels after the first page remain reachable. A Local expiry sweep propagates channel-page and thread-store failures and returns a count only after every selected scope completes. A workspace-scoped `list` returns empty when its channel cannot be resolved there; it never falls through to the default store. Context-free legacy listing keeps its default-store behavior.
- `[Inferred]` Thread ids (`thr_<8hex>`) are random, not ULID-ordered — listing order comes solely from `(lastActivityAt, id)` keyset, never from the id.

## Flow
1. Create: `threadGate.create({ channelId, parentMessageId?, title?, createdBy, isEphemeral?, ttlHours? })` validates the channel always, and additionally requires the parent message to exist in the same channel when `parentMessageId` is given (`thread-service.ts:26`); computes `expiresAt` from TTL rules; inserts the `threads` row and its `threadSequences` row (`lastSeq: 0`) in one transaction. A duplicate-parent race hits the partial unique index → 23505 → the cause-chain walk maps it to the existing thread (`created: false`) (`thread-service.ts:17`, `thread-service.ts:74-80`). Local mode creates into the file store with an idempotent parent lookup.
2. Read/list: `threadGate.get(id)` is a single `findFirst` in the selected workspace database or a workspace-scoped file lookup in local mode; `threadGate.list(channelId, { includeArchived?, limit?, cursor? })` filters `active` by default, applies an `(lastActivityAt,id) < (ts,id)` keyset clause for `ISO;id` cursors with a numeric-offset fallback in both Local and DB tiers, and orders newest-first in `listThreads`.
3. Update/delete: `threadGate.update(id, { title?, status? })` enforces the transition map `active→{active,archived,expired}`, `archived→{archived,active}`, `expired→{expired,archived}`; illegal moves return `{ error: "illegal_transition", from, to }` → 409; every non-active move stamps `archivedAt` once and `active` clears `expiresAt` (`thread-service.ts:148`). `threadGate.delete(id)` SET NULLs the replies' `thread_id`, then hard-deletes the thread (`thread-service.ts:222`).
4. Message post (route transport): `POST /api/threads/:threadId/messages` requires an ACTIVE thread (else 409), validates content non-empty, parses mentions, appends via `messageGate.append` with `threadId` (thread-sequence branch, single `message:new` emit), then calls `threadGate.incrementCount` (`routes/threads.ts`).
5. Message read: `threadGate.getMessages(threadId, { limit?, before? })` parses the `timestamp;seq` cursor tolerantly (garbage → unfiltered head read), then delegates to the Messages-owned port `messageGate.getThreadPage` (raw rows, `threadId` kept; `limit + 1` newest-first fetch, slice, reverse to chronological, `nextCursor` only when more remain) — local tier passes the resolved channel scope, PG tier the tenant handle. The cursor clause binds the cursor timestamp as an ISO string with an explicit `::timestamptz` cast — a raw `Date` binding crashes postgres.js (fixed 2026-10-07) (`thread-service.ts:252`, `message-service.ts:556`).
6. Count: `threadGate.incrementCount(threadId)` atomically `messageCount + 1` and refreshes `lastActivityAt`/`updatedAt`, filtered to `status = 'active'` so no caller path can advance a dead thread's counters (`thread-service.ts:293`).
7. Sweep: `threadGate.archiveExpired()` bulk-updates stale actives (`status = 'active' AND expiresAt < now`) to `expired` in one statement and returns the count; the predicate binds `now` as an ISO string with `::timestamptz` (raw-Date binding crash fixed 2026-10-07) (`thread-service.ts:185`). It runs from two callers:
   - Scheduled (THR-007): the `thread-expire` repeatable (60s, `queue/repeatables.ts:21`) dispatches to `handleThreadExpire` (`queue/maintenance-worker.ts:130`, processor cases at `:269`/`:289`), which passes each workspace id with its fan-out handle so the gate selects that workspace's effective tier; it then sweeps the ambient/global handle, with context-free Local mode scanning searchable workspace folders.
   - Manual: `POST /api/threads/sweep` (rate-limited 30/min) — admin-guarded when `WORKSPACE_ADMIN_TOKEN` is configured (THR-008, `routes/threads.ts:41`, `:137`); tokenless single-user setups keep loopback trust.
8. REST surface: channel-scoped list/create, id-scoped get/patch/delete, message list/post, manual sweep — expected domain errors map to 404/400/409. Local expiry traversal and storage failures propagate, so a failed sweep cannot report a partial count as success.

## Current Implementation
| File | Role |
| ---- | ---- |
| `thread-gate.ts` | Thin facade: re-exports service functions and thread types as `threadGate` |
| `thread-service.ts` | All logic: validation, transactional create + 23505 mapping, guarded transitions, keyset list, message reads, sweep, count, local-tier branches |
| `thread-local-store.ts` | File truth per channel (`threads/<channelId>.json`) for the workspace Local tier |
| `thread-types.ts` | `Thread` / `CreateThreadInput` / `UpdateThreadInput` / `ThreadStatus` types |

Key functions: `allocateThreadSequence` (Threads-owned allocator, atomic `lastSeq + count` upsert with self-heal from MAX(seq), `threads/thread-sequence-allocator.ts`; exposed as `threadGate.allocateSequence` and called by the Messages append path with its tx — THR-016 fixed); expiry predicate `status = active AND expiresAt < now` (`thread-service.ts:185`); `isUniqueViolation` cause-chain walk (`thread-service.ts:17`).

## Ports
- `Thread` — thread record type (channel/parent/root links, ephemeral + TTL fields, counters).
- `CreateThreadInput` — `{ channelId, parentMessageId?, title?, createdBy, isEphemeral?, ttlHours? }` type.
- `UpdateThreadInput` — `{ title?, status? }` type.
- `threadGate.create` — validates, inserts thread + sequence row transactionally; `{ thread }` or `{ error }`.
- `threadGate.get` — one thread row or `undefined`.
- `threadGate.list` — keyset-paginated thread rows for a channel.
- `threadGate.update` — title/status update; `{ thread }` or `{ notFound: true }`.
- `threadGate.delete` — hard-delete; `{ deleted: true }` or `{ notFound: true }`.
- `threadGate.getMessages` — chronological page plus `nextCursor`; `{ error }` when missing. Delegates the page query to the Messages-owned `messageGate.getThreadPage` (raw rows, `threadId` kept; THR-015).
- `threadGate.archiveExpired` — bulk-expires stale actives; returns count.
- 	hreadGate.incrementCount — atomic count + activity bump.
- 	hreadGate.allocateSequence — Threads-owned 	hread_sequences allocator: reserves count seqs (self-heals a missing counter row from MAX(seq)); callers pass their transaction so a rollback restores the counter (THR-016).
- `threadCallContext` — `{ workspaceId?, db? }` optional context on every port (THR-025): `workspaceId` selects the effective workspace tier and resolves that workspace database when connected; Local mode stays on workspace files. `db` pins an exact handle; omitted keeps the ambient/global behavior.

## Relations
Gates this domain calls:
- `channelGate` (Channels) — local-tier channel enumeration/lookup (`channelGate.list`, `thread-service.ts:194`, `:312`, `:352`). PG validation reads the shared `db/schema.ts` tables (ungated module, outside the gate rule).
- `messageGate` (Messages) — thread message pages via `messageGate.getThreadPage` (raw rows, `threadId` kept; `thread-service.ts:252-288`), THR-015 fixed.
Verified outside callers of `threadGate`:
- Routes: `routes/threads.ts` (all eight ports across list/create/get/update/delete/messages/increment/sweep).
- Queue: `queue/maintenance-worker.ts` `handleThreadExpire` calls `threadGate.archiveExpired` per workspace DB + ambient handle (THR-007); the worker never touches thread tables directly.
Transport registration: `threadRoutes` is mounted in `routes/index.ts` alongside all other route modules (THR-001 fixed; pinned by the `serves every Threads endpoint` case in `routes/index.test.ts`).
Single-emit ownership (XD-008 fixed): the thread-post route passes the broker INTO `messageGate.append` and no longer emits `message:new` manually — exactly one emit per post, no latent double-delivery.
Local tier (THR-003 fixed): `thread-local-store.ts` JSON rows per channel + tier routing in every service op, including `get`/`getMessages` (fixed 2026-10-07), proven by `thread-local-mode.test.ts`. Workspace-local creates reject channels outside the selected workspace rather than writing into default scope (2026-10-09). One-thread-per-parent enforced by partial unique index 0026 with violation-to-winner mapping (THR-004 fixed). Delete rule is SET NULL — replies survive as channel messages (THR-005 fixed). Thread-aware message uniqueness via migration 0025 (`messages_channel_thread_sequence_idx` on `(channel_id, COALESCE(thread_id,''), sequence_number)`) (THR-002 fixed).
  2026-10-07 db-audit note: migration 0026 (and 0025/0027) was missing from `meta/_journal.json`, so drizzle never applied it — the partial unique index existed only in `schema.ts` on migrated DBs. Journal entries added; 0026 now runs on migrate. Verified end-to-end on a scratch DB by `thread-integrity.test.ts`.
Tables shared with other domains:
- `channels` (Channels) — read for existence validation; never written here.
- `messages` (Messages) — parent rows read for validation; thread replies are appended via `messageGate.append` with `threadId` set, owned by Messages. The thread message-page read goes through the Messages-owned port `messageGate.getThreadPage` (raw rows, `threadId` kept) — the direct `message-local-store` import is gone (THR-015 fixed 2026-10-07; regression in `thread-page-gate.test.ts`).
- `thread_sequences` — written only here: bootstrap in `createThread` and every later bump via `threadGate.allocateSequence` called from the Messages append path (gate-to-gate; the old `shared/core/thread-sequence.ts` is deleted) — THR-016 fixed.

## Emits-Listens
- None in-domain — the service never touches a broker; `message:new` on thread replies is emitted by `messageGate.append` (broker passed in by route transport).

## Owns
- `threads` (writes: insert, title/status/count/activity updates, hard delete, bulk expiry)
- `thread_sequences` (writes: insert-on-create + all later bumps through the Threads-owned allocator, `threadGate.allocateSequence` — single owner, THR-016 fixed)

## Flags
- `WORKSPACE_ADMIN_TOKEN` (route-level, THR-008): when set, `POST /api/threads/sweep` requires an admin API key (`routes/threads.ts:41`). No `process.env` reads in the service/gate; TTLs and limits are call-time inputs (route defaults: ephemeral `true`, `ttlHours` 24 clamped 1–720, list limit 50).

## Decisions
- `[Observed]` Thread + sequence row are created in one transaction with `onConflictDoNothing` — a crash can never leave a thread without its counter (`thread-service.ts:38-60`).
- `[Observed]` Ephemeral-by-default with 24h TTL and `expiresAt = null` for persistent threads — expiry is opt-out at creation, and the sweep only ever sees rows that opted in (`thread-service.ts:29`, `thread-service.ts:114-120`).
- `[Observed]` Both Local and DB listing use keyset pagination on `(lastActivityAt, id)` with a tolerant numeric-offset fallback — new-style cursors never skip on ties, old clients keep working in `listThreads`.
- `[Observed]` Message pages are over-fetched by one (`limit + 1`) to compute `hasMore`, then reversed to chronological — the API reads oldest-first while the index scans newest-first (`thread-service.ts:144`).
- `[Observed]` Expected validation and missing-row outcomes use `{ error }` / `{ notFound }` unions; Local channel/thread scope lookup, expiry traversal, and storage failures propagate to the caller instead of being reported as missing rows. The route layer owns status-code mapping for the domain unions (`thread-service.ts:17`, `thread-service.ts:103`, `thread-service.ts:133`, `thread-service.ts:230`).
- `[Observed]` The DB expiry sweep is a single `UPDATE...WHERE` (1 RTT, not 1+N); the Local sweep completes every channel page and propagates read/write failures before returning its count. Both run every 60s from the maintenance worker, and the manual endpoint is rate-limited + admin-guarded when configured (`thread-service.ts:230`, `queue/repeatables.ts:21`, `routes/threads.ts:41`).
- `[Observed]` One thread per parent is enforced by the DB (partial unique index 0026), not just the check-then-insert read — concurrent creates collapse to one row (THR-004).
- `[Observed]` The delete rule for replies is SET NULL: replies survive as channel messages (`thread-service.ts:222`). Manual expiry is refused for archived threads; resurrection is impossible (`thread-service.ts:148`).
- `[Inferred]` Message insertion deliberately lives in route transport rather than the gate — sequencing (`allocateThreadSequence`), the message insert, and the broadcast stay in one visible transaction-plus-emit block (`routes/threads.ts:108`).

## User Decision:

## Architectural Standard (Target)
> Status: Target. Transactional create plus single-statement sweep stay; nesting, FK rule, transitions, and live updates are the gaps.
Thread plus sequence row creation stays one transaction with onConflictDoNothing. Crash never leaves a thread without its counter.
Ephemeral-by-default with 24h TTL plus null for persistent stays. Sweep only sees opted-in rows.
rootMessageId MUST be honored or removed. Voided existingThread fetch with always-parentMessageId is forbidden.
messages.threadId FK on thread delete MUST be one explicit rule: cascade, set-null, or restrict. Unverified delete semantics are forbidden.
updateThread MUST enforce a guarded status machine with expiresAt bookkeeping on manual expire. Any-to-any transitions are forbidden.
Thread create, update, and archive MUST emit broker events for live clients. Poll-only lifecycle is forbidden.
Cursor wire formats ISO-id plus timestamp-seq MUST be explicit versioned contracts shared with routes, with tests covering malformed input.
## Failure + Resume
- Bad channel/parent on create returns `{ error }` → HTTP 404; empty post content returns 400 before any write (`thread-service.ts:17`, `routes/threads.ts:92`).
- Missing thread on update/delete/messages returns `{ notFound }` / `{ error }` → HTTP 404 (`thread-service.ts:103`, `thread-service.ts:133`).
- Illegal status moves return `{ error: "illegal_transition" }` → HTTP 409 (`routes/threads.ts:60-63`).
- Malformed cursors (bad date, non-numeric seq, missing `;`) degrade to unfiltered head reads rather than errors (`thread-service.ts:140-146`).
- `incrementCount` runs after the message transaction commits: a crash between the two leaves `messageCount`/`lastActivityAt` one behind with no catch-up — reads stay correct (they query `messages`), only the counter lags (`routes/threads.ts:108`, `routes/threads.ts:115`).
- Expired threads stay readable via `includeArchived`; restoring an expired thread is refused (only `archived → active` is allowed; `active` clears `expiresAt`).
- The scheduled sweep is per-workspace best-effort (`forEachWorkspaceDb` skips unreachable tenants with a warning) and idempotent — a repeat tick reports 0.
- 2026-10-07: the sweep's PG branch used to throw on every tick (raw `Date` bound inside a `sql` template is not serializable by postgres.js); now binds an ISO string with `::timestamptz`. Same fix applied to the `getMessages` cursor clause.

## Gaps
- `rootMessageId` is always just `parentMessageId` — reply-in-thread nesting beyond one level is unimplemented (THR-027 open).
- No socket or broker events for thread create/update/archive — clients learn about thread lifecycle only by polling list/get; only message posts emit (THR-019 open).
- Cursor wire formats (`ISO;id`, `timestamp;seq`) are implicit contracts shared with the route file; malformed cursors silently degrade (THR-011/012/030 open).
- `messages.threadId` remains a plain text column (no FK); the SET NULL rule is enforced at the service layer. A FK migration is still the target (THR-005 note).
2026-10-07 (fix-threads-015): THR-015 fixed - thread message pages (local + PG tiers) go through the Messages-owned port `messageGate.getThreadPage` (raw rows, `threadId` kept; `message-service.ts:556`, wired at `thread-service.ts:252-288`); the direct `message-local-store` import is gone and check-gates reports 0 violations; regression `thread-page-gate.test.ts` (page shape + threadId + no-import pin).
- THR-016 open: `thread_sequences` is bootstrapped by Threads but advanced by the shared allocator from the Messages append path (two writers).
 2026-10-07 (fix-threads-micro-016-025): THR-016 fixed - allocator moved to threads/thread-sequence-allocator.ts, exposed as threadGate.allocateSequence; Messages append calls the gate with its tx (message-service.ts:665, gate-to-gate); shared/core/thread-sequence.ts deleted; ownership + gate contract tests in thread-fix-016-025.test.ts.
 2026-10-09 (storage-mode consistency): Threads previously used process-wide `isDatabaseConfigured()` for every tier decision and REST routes discarded their workspace id. The service now resolves the effective workspace tier from `tierContextFor`/`resolveTier`; routes and the scheduled workspace fan-out pass the existing workspace context, and local operations stay scoped to that workspace. Regression coverage: `thread-workspace-storage-mode.test.ts` and explicit-context cases in `thread-local-mode.test.ts`.
 2026-10-09 (local ownership): local create previously accepted a channel missing from the caller's workspace and persisted the new thread in default scope. It now returns `channel_not_found`; regression: `thread-local-mode.test.ts`.

## THR-005 Message ownership follow-up

Thread deletion delegates reply detachment to `messageGate.detachThreadReplies(threadId, { channelId, workspaceId })` before deleting the thread. The Messages gate scopes updates to the exact channel/workspace, serializes Local JSONL rewrites with message appends, and returns replies to channel history in both Local and DB modes. Threads does not update the Messages table or rewrite message files directly. Regression: `thread-local-mode.test.ts` verifies reply survival and cleared `threadId` in Local scope; `thread-integrity.test.ts` verifies database SET NULL behavior.

THR-005 implementation update: thread deletion now delegates reply detachment to the Messages-owned messageGate.detachThreadReplies port before deleting the thread row. The port receives exact channel/workspace scope, keeps Local file rewrites under the Messages JSONL lock, and uses the owning tenant database in DB mode. Local regression: thread-local-mode.test.ts verifies replies survive in channel history with threadId cleared. The DB SET NULL regression remains in thread-integrity.test.ts. Parent-message validation also uses messageGate.existsInChannel so Local and DB tiers reject missing or cross-channel parents consistently.
