# Thread lifecycle flow
> Type: Flow · Status: aligned · Updated: 2026-10-09

## Intent
A channel sometimes needs a side conversation anchored to one message without forking the channel. This flow exists so that side conversation has a visible temporal shape: create (with its sequence counter bootstrapped in the same transaction) → messages posted through route transport → TTL archive by a single-statement sweep — with reads staying correct even when counters lag.

## Architectural decision
Threads default to ephemeral with a 24h TTL, and only ephemeral threads with `ttlHours > 0` get an `expiresAt` — expiry is opt-out at creation and the sweep only ever sees rows that opted in `[Observed]` (`thread-service.ts:29-31`, `thread-service.ts:114-120`). Thread + sequence-counter rows are created in one transaction, so a crash can never leave a thread without its counter `[Observed]` (`thread-service.ts:33-53`). Expected domain outcomes use `{ error }` / `{ notFound }` unions; storage and traversal failures propagate to callers `[Observed]`. Reply insertion goes through `messageGate.append` (thread-sequence branch), keeping allocation, insert, and broadcast in one owned block `[Observed]` (`routes/threads.ts:87-103`, `message-service.ts:387-406`).

Storage mode is selected from the workspace context: registry or matching `CROWDOS_WS_<ID>_DATABASE_URL` configuration can select the workspace DB while process-wide `DATABASE_URL` is unset. Local-tier operations use that workspace's file store; channel ownership, thread-id lookup, and expiry traversal page through the Channel gate's `(position,id)` cursor while staying within the selected workspace. Context-free calls retain the global-pool behavior (`thread-service.ts`, `workspace-registry.ts`).

## How it works
1. `threadGate.create({ channelId, parentMessageId?, title?, createdBy, isEphemeral?, ttlHours? })` validates the channel always, and requires the parent message to exist in the same channel when `parentMessageId` is given (`thread-service.ts:26-40`).
2. It computes `expiresAt` from the TTL rules — set only for ephemeral threads with `ttlHours > 0` — and inserts the `threads` row plus its `threadSequences` row (`lastSeq: 0`) in one transaction. A duplicate-parent race hits the partial unique index → 23505 → the cause-chain walk returns the winner thread with `created: false` (`thread-service.ts:17`, `:56-80`).
3. Replies are posted by the route via `messageGate.append`: `POST /api/threads/:threadId/messages` refuses non-active threads (409), validates non-empty content, parses mentions, and appends the `messages` row with `threadId` (thread-sequence branch, emits `message:new`) (`routes/threads.ts`, `message-service.ts:413-560`).
4. After the append, the route calls `threadGate.incrementCount` (atomic `messageCount + 1`, refreshes `lastActivityAt`, filtered to `status = 'active'`) (`thread-service.ts:293`).
5. `threadGate.list` serves the channel's threads newest-first via `(lastActivityAt, id)` keyset (numeric-offset fallback for legacy cursors), hiding non-`active` threads unless `includeArchived` is set (`thread-service.ts:111-146`).
6. `threadGate.getMessages` parses the `timestamp;seq` cursor tolerantly (garbage → head read), then delegates to the Messages-owned port `messageGate.getThreadPage` (raw rows, `threadId` kept): over-fetches by one newest-first to compute `hasMore`, returns the page oldest-first with `nextCursor` only when more remain (`thread-service.ts:252`, `message-service.ts:556`). The cursor clause binds its timestamp as an ISO string (`::timestamptz`) — a raw `Date` binding crashes postgres.js (fixed 2026-10-07).
7. Status moves are guarded: `active → {active, archived, expired}`, `archived → {archived, active}`, `expired → {expired, archived}`; anything else is 409. Every non-active move stamps `archivedAt` once; returning to `active` clears `expiresAt` (`thread-service.ts:148-183`, `routes/threads.ts:60-63`).
8. Expiry runs on two callers (both idempotent — a repeat tick reports 0):
   - Scheduled (THR-007): the `thread-expire` repeatable (60s, `queue/repeatables.ts:21`) → `handleThreadExpire` (`queue/maintenance-worker.ts:130`) passes each workspace id with its fan-out handle, so the gate selects the workspace's effective tier; it then sweeps the ambient/global handle. A context-free Local sweep scans searchable workspace folders. In `bullmq` mode the worker is the single owner of all timers (API suppresses local sweep timers).
   - Manual: `POST /api/threads/sweep` (rate-limited 30/min) calls `threadGate.archiveExpired()` — DB mode uses one bulk `UPDATE ... WHERE status = active AND expiresAt < now::timestamptz`; Local mode pages every channel and returns its count only after all reads and writes succeed. A page or file-store failure propagates so the caller cannot mistake a partial sweep for success. When `WORKSPACE_ADMIN_TOKEN` is configured the route demands an admin API key (401/403 otherwise, THR-008, `routes/threads.ts:41`, `:137`).
9. Deleting a thread SET NULLs its replies' `thread_id` (replies survive as channel messages), then hard-deletes the thread (`thread-service.ts:222-235`).
10. Expired threads stay readable via `includeArchived`; restoring an expired thread is refused (only `archived → active` is allowed).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Threads.md> | Owns `threads`/`thread_sequences` rows, keyset listing, thread-scoped reads, count bump, TTL sweep |
| <../Domain Spec/Messages.md> | Sole owner of `messages` rows and channel-history merging; thread replies are `messages` rows with `threadId` set, written via `messageGate.append` |
| <../Domain Spec/Channels.md> | Owns `channels` rows, read here only for existence validation |
| <./Threads and sub-conversations.md> | Owns the design (ephemerality default, transactional bootstrap, error-union convention, gate-owned reply writes) — see that doc, not duplicated here |

## Current state
Real: transactional thread + sequence bootstrap, ephemeral-by-default TTL, gate-owned reply append (`messageGate.append`), keyset thread listing, expected `{ error }`/`{ notFound }` unions, guarded status machine, thread-scoped message reads, DB single-statement expiry sweep, complete Local expiry traversal with failure propagation, scheduled caller (worker), and an admin-guarded manual endpoint. Flag: `WORKSPACE_ADMIN_TOKEN` gates the sweep route when configured. The only legacy is the numeric-offset cursor fallback.

## Alignment notes
2026-10-09 drift fixed: tier selection previously used the global `DATABASE_URL` predicate before resolving workspace context, and REST callers did not pass their decorated workspace id. Threads now uses `tierContextFor`/`resolveTier`, routes and maintenance fan-out pass workspace context, and local store lookups stay within that workspace. A local create whose channel is missing from the selected workspace now returns `channel_not_found` instead of writing into default scope. A workspace-scoped local list whose channel is missing from that workspace returns empty instead of reading default-scope rows; context-free listing retains default-store behavior. Local channel scope resolution, thread-id lookup, and expiry traversal now visit all Channel cursor pages. Regression: `thread-workspace-storage-mode.test.ts` and `thread-local-mode.test.ts`.

2026-10-07 re-sample verified TTL computation + transactional bootstrap, 23505 cause-chain mapping, guarded transitions, SET NULL delete, message reads including the ISO-string cursor bind, sweep predicate, scheduled caller, and admin guard. The raw-`Date` bindings and duplicate-create error mapping were fixed in that pass. Evidence: `src/threads/thread-integrity.test.ts` (scratch-PG), `src/threads/thread-expire-scheduler.test.ts`, `src/routes/threads-sweep-auth.test.ts`.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* incrementCount plus message commit has an atomic outcome or explicit lag-and-catch-up contract. Silent counter lag is forbidden.
* Manual expire writes expiresAt bookkeeping. Sweep inconsistency for manually-expired rows is forbidden.
* messages.threadId FK on delete is one explicit rule: cascade, set-null, or restrict.
* Thread create, update, and archive emit broker events. Poll-only lifecycle is forbidden. Authority: Threads standard.
## Open gaps
- `incrementCount` runs after the message transaction commits: a crash between the two leaves `messageCount`/`lastActivityAt` one behind with no catch-up — reads stay correct (they query `messages`), only the counter lags.
- No socket/broker events for thread create/update/archive — clients learn lifecycle only by polling; only message posts emit.
- `messages.threadId` is still a plain text column (no FK); the SET NULL rule is enforced in the service layer. A FK migration remains the target.
2026-10-07 (fix-threads-015): thread message-page reads (local + PG tiers) go through the Messages-owned port `messageGate.getThreadPage` (raw rows, `threadId` kept) — the direct `message-local-store` import is gone (THR-015 fixed; regression `thread-page-gate.test.ts`).

10. Thread deletion uses the Messages-owned `messageGate.detachThreadReplies` port with exact channel/workspace scope before the thread row is removed. Replies remain in channel history with `threadId: null` in both Local and DB tiers.

Delete/validation parity update: Thread deletion detaches replies through messageGate.detachThreadReplies with channel/workspace scope; parent validation uses messageGate.existsInChannel. Both cross-domain operations are owned by Messages and apply consistently in Local and DB tiers.
