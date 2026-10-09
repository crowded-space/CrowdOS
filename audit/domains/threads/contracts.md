# Threads Domain — Phase 2 Contract Matrix (read-only audit, 2026-10-06)

One row per facade port. "Route mapping" is the intended HTTP behavior in `routes/threads.ts` — currently unreachable until THR-001 is fixed.

| # | Port | Inputs | Preconditions / validation | Success result | Error result | Auth / tenant | Idempotency | Txn / concurrency | Side effects & ordering | Events | Observability | Perf notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `create(CreateThreadInput)` | channelId, parentMessageId?, title?, createdBy, isEphemeral?, ttlHours? | channel exists (always); parent exists AND parent.channelId = channelId when parentMessageId given. No UUID/format validation (route: title ≤200; ttlHours int 1-720; createdBy ≥1). | `{ thread }` (new) or `{ thread, created:false }` (parent already anchors one) | `{ error: "channel_not_found" }` / `{ error: "parent_not_found" }` | None in-domain; global pin/auth hooks; tenant from ambient ALS (THR-025) | Not idempotent under races: check-then-insert TOCTOU; no unique index on parent_message_id (THR-004). Sequential retry with parent → returns existing. | insert threads + insert thread_sequences in ONE `withTransaction` (service:38-60); pre-checks outside txn | Row inserted; sequence row lastSeq=0; `lastActivityAt = createdAt = now` | None (THR-019) | None | 3 parallel pre-checks; PK `thr_<uuid8>` (collision improbable; insert throws) |
| 2 | `get(id)` | id | none | thread row | `undefined` | global hooks; ambient tenant | pure read | none | none | none | none | single findFirst by PK |
| 3 | `list(channelId, {includeArchived?, limit?, cursor?})` | channelId, opts | limit clamped 1-200 (default 50) in-service; cursor parsed leniently | `Thread[]` newest-first | never errors (even for unknown channel → `[]`) | global hooks; ambient tenant | pure read | none | none | none | none | keyset `(lastActivityAt,id) < (ts,id)`; legacy numeric offset fallback; **no composite index (channel, last_activity_at)** → THR-020; **no nextCursor returned** → THR-013; invalid keyset cursor silently degrades to head page → THR-012 |
| 4 | `update(id, {title?, status?})` | id, input | exists (pre-checked); NO transition guard — active/archived/expired all accepted (THR-006); no title semantic validation in-domain | `{ thread }` updated | `{ notFound: true }` | global hooks; ambient tenant | last-write-wins | read-then-update, no txn: delete race yields `{ thread: undefined }` (THR-009) | sets `updatedAt`; `archivedAt` stamped ONLY when status==="archived" (re-archiving overwrites; "expired" never stamps) | none | none | 2 RTT |
| 5 | `delete(id)` | id | exists (pre-checked) | `{ deleted: true }` | `{ notFound: true }` | global hooks; ambient tenant | second call → notFound (deleting twice is not idempotent-200) | read-then-delete, no txn; messages.thread_id has NO FK → thread replies are orphaned (THR-005) | cascade: thread_sequences (FK cascade). messages NOT cascaded | none | none | 2 RTT; no audit trail |
| 6 | `getMessages(threadId, {limit?, before?})` | threadId, opts | thread must exist; limit clamped 1-200 (default 50); cursor `"<ISO>;<seq>"` parsed leniently — garbage degrades to head page silently (THR-011) | `{ messages: oldest-first page, nextCursor }` | `{ error: "thread_not_found" }` | global hooks; ambient tenant | pure read | none | none | none | none | limit+1 over-fetch + reverse; keyset `(timestamp,seq)`; index `messages_thread_ts_seq_idx` exists; rows returned raw (client must not assume merged shapes) |
| 7 | `archiveExpired()` | none | only `status="active" AND expiresAt IS NOT NULL AND expiresAt < now` | number of rows flipped to expired | never errors (empty → 0) | **unauth-guarded only by global hooks** — route is a public POST when mounted (THR-008) | idempotent (second call flips 0) | single UPDATE...RETURNING (atomic) | stamps archivedAt + updatedAt | none | none | one bulk statement; index `threads_expires_idx` |
| 8 | `incrementCount(threadId)` | threadId | thread exists AND status="active" (silent no-op otherwise) | `undefined` | `undefined` (never throws for missing/dead thread) | ambient tenant | **NOT idempotent** — each call +1; correct only if caller invokes exactly once per message (THR-010/THR-017) | single atomic UPDATE | messageCount+1, lastActivityAt=now, updatedAt=now | none | none | 1 RTT; must run AFTER message commit (no txn coupling) |

## Route transport contract (routes/threads.ts — intended HTTP mapping; unreachable today)

| Endpoint | Gate call | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/channels/:channelId/threads` | list | 200 `{ threads }` | — |
| `POST /api/channels/:channelId/threads` | create | 201 thread row | 404 channel/parent |
| `GET /api/threads/:threadId` | get | 200 row | 404 |
| `PATCH /api/threads/:threadId` | update | 200 row | 404 |
| `DELETE /api/threads/:threadId` | delete | 200 `{ success: true }` | 404 |
| `GET /api/threads/:threadId/messages` | getMessages | 200 page | 404 |
| `POST /api/threads/:threadId/messages` | get + messageGate.append + incrementCount | 201 message | 404, 409 non-active, 400 empty content |
| `POST /api/threads/sweep` | archiveExpired | 200 `{ archived }` | rate limit 30/min |

Transport-layer defects: no zod schema on the POST-message body (THR-022); `incrementCount` fire-and-forget after append (THR-010); broker emit wrapped in bare `catch {}` (THR-024); `thread:join` socket emit has no server handler (THR-018); POST-message route lets a non-owner authorId impersonate (THR-023).

## Compatibility notes

- Wire formats: list cursor `ISO;id` (+ legacy numeric offset), messages cursor `ISO;seq` — implicit, duplicated in route/service, no shared constant (THR-021). Must stay accepted when refactoring.
- Stored formats: `thr_<8hex>` ids; enum `thread_status`; `expiresAt=null` for non-ephemeral. Changing any of these breaks existing rows.
- Error semantics: unions returned, never thrown; route maps to 404/409/400. Preserve when moving logic behind the gate.
