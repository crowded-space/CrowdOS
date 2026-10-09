# Threads Domain — Invariant Catalog (read-only audit, 2026-10-06)

Legend: **Holds** (verified in code), **Violated** (defect), **At risk** (holds only under stated conditions), **Unverified** (no test/proof).

## A. Lifecycle / state machine

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I1 | Only `active` threads accept new messages | Holds at route (409) but **unreachable** until THR-001; not enforced in gate/service | routes/threads.ts:89-91; THR-001 |
| I2 | Status transitions are `active → archived|expired`; no resurrection | **Violated** — `update` accepts any transition incl. expired→active with no TTL recompute and no archivedAt clearing | thread-service.ts:100-112; THR-006 |
| I3 | `archivedAt` is stamped when (and only when) a thread leaves active | **Violated** — only `status==="archived"` stamps; manual `expired` leaves null; re-archiving overwrites the timestamp | thread-service.ts:106-109; THR-014 |
| I4 | Sweep flips only `active` rows with `expiresAt < now` | Holds (single UPDATE...WHERE) | thread-service.ts:114-120 |
| I5 | Ephemeral threads have expiresAt; persistent (`isEphemeral=false`) never expire | Holds at create (`expiresAt=null` when not ephemeral or ttl≤0) | thread-service.ts:34-36 |
| I6 | `status` domain ⊆ {active,archived,expired} | Holds (PG enum `thread_status`) | schema.ts:37,1022 |

## B. Parentage / identity

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I7 | A parent message anchors at most one thread | **Violated under race** — check-then-insert with no unique index on `parent_message_id`; two concurrent creates mint duplicates | thread-service.ts:11-25,38-60; THR-004 |
| I8 | `rootMessageId` reflects the thread root (nesting support) | **Violated** — always = parentMessageId; nesting not implemented | thread-service.ts:10,26,43; THR-027 |
| I9 | Thread's channel exists and parent belongs to the same channel | Holds on the sequential path | thread-service.ts:12-18 |
| I10 | Deleting a thread removes or detaches its replies deliberately | **Violated** — `messages.thread_id` has no FK; delete orphans replies invisibly | schema.ts:297; migration 0012:10; THR-005 |
| I11 | `thread_sequences` row exists for every thread | Holds at create (same txn, onConflictDoNothing); allocator self-heals if missing | thread-service.ts:56-58; thread-sequence.ts:15-19 |

## C. Message sequencing

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I12 | Thread reply sequence numbers are unique per thread | Holds in local tier (separate counter key) and in allocator; **PG unique index does not back it** (index is channel-scoped) | message-local-store.ts:49-62; thread-sequence.ts:21-25; schema.ts:310; THR-002 |
| I13 | `(channel_id, sequence_number)` stays unique for channel messages | **Violated for thread rows in PG** — thread replies reuse small per-thread seqs in the same channel → replica insert hits the unique index and is dropped (onConflictDoNothing) | message-service.ts:494-497; 0000_baseline.sql:478; THR-002 |
| I14 | `messageCount` = number of replies in the thread | **At risk** — one increment per post, but (a) increment is skipped/not retried on failure (THR-010), (b) direct `messageGate.append(..., threadId)` callers bypass it (THR-017), (c) no decrement path exists (messages are never deleted) | routes/threads.ts:108; thread-service.ts:160-165 |
| I15 | `lastActivityAt` advances only on real activity | At risk — `incrementCount` bumps it; post-race no-op when thread not active; sweep does not touch it | thread-service.ts:164 |

## D. Pagination / reads

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I16 | Message pages are stable keyset pages over `(timestamp, seq)` | At risk — `timestamp` is set client/process-side at append; equal timestamps handled by seq tiebreak; invalid cursor silently resets to head (THR-011) |
| I17 | `nextCursor` points at the oldest returned row and only when more exist | Holds in service | thread-service.ts:153-156 |
| I18 | List pages are stable keyset pages over `(lastActivityAt, id)` | At risk — ties broken by id; legacy offset fallback can skip/duplicate under writes; no nextCursor surfaced (THR-013) |
| I19 | Unknown/foreign ids are 404, never leak other tenants' rows | At lease: rows are fetched by PK in the ambient tenant DB; no explicit workspace filter in SQL (THR-025) |

## E. Transaction / durability

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I20 | Thread + sequence row commit atomically | Holds | thread-service.ts:38-60 |
| I21 | Message append + counter bump are atomic | **Violated by design** — counter bump is a separate statement after commit; crash window leaves counter behind | routes/threads.ts:98-108; Threads.md:106 |
| I22 | Deleting a thread cannot leave dangling FK references | Holds for thread_sequences (cascade); Violated for messages (no FK, THR-005) |
| I23 | Expiry sweep is idempotent and restart-safe | Holds (single UPDATE; second run flips 0) |

## F. Contract / boundary

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I24 | Nothing outside the domain imports past `thread-gate.ts` | Holds (grep + `lint:gates` exit 0) |
| I25 | Every facade port is reachable from production | **Violated** — all 8 ports are unreachable (route unmounted); gate is dead public surface | THR-001 |
| I26 | Domain never touches another domain's tables | **Violated** — reads `channels`, reads/creates `messages`; messages domain writes `thread_sequences` | thread-service.ts:4,13-15,28,149-151; message-service.ts:433-435; THR-015/016 |
| I27 | Errors cross the gate as unions, never throws | Holds for expected paths; unexpected DB errors propagate as exceptions (documented behavior) |
| I28 | Facade ports are idempotent where semantics require (create/delete) | Partially — create dedupes sequentially only; delete not idempotent-200 | THR-004 |

## G. Tenant / security

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| I29 | Every thread read/write is scoped to the caller's workspace DB | At risk — scope exists only when the HTTP request carried `x-workspace-id` (ALS); non-HTTP callers use global DB; no SQL-level workspace predicate | create-app.ts:235-303; THR-025 |
| I30 | Sweep endpoint is not a public unauthenticated mutation | At risk — depends entirely on global hooks; no route-level guard/secret | routes/threads.ts:119; THR-008 |
| I31 | Message authorship cannot be forged by the client | **Violated** — `authorId`/`authorName` accepted from body with defaults | routes/threads.ts:95-96; THR-023 |
| I32 | Thread lifecycle changes are observable to clients | **Violated** — no broker events for create/update/archive; clients poll | Threads.md:100,113; THR-019 |
