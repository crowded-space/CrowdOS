# Threads Domain — Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: `packages/server/src/threads/` (3 files), facade `thread-gate.ts`, transport `packages/server/src/routes/threads.ts`, persistence (schema + migration 0012), tests, callers, docs.
Method: full read of every domain file, the route, the schema slice, message/sequence code paths, cross-repo grep (packages, e2e, load, re-docs), git history scan (49 revs), plus an audit-only vitest probe under `audit/domains/threads/probe/`.

## 1. Domain files (all read)

| File | Lines | Role |
| --- | --- | --- |
| `thread-gate.ts` | 25 | Facade: 8 function ports + 3 type re-exports (exact list below) |
| `thread-service.ts` | 166 | All logic: validation, txn create, list, update, delete, message page, sweep, counter |
| `thread-types.ts` | 33 | `ThreadStatus`, `Thread`, `CreateThreadInput`, `UpdateThreadInput` |

## 2. Facade surface (exact)

`threadGate` (thread-gate.ts:15-24):
- `create` → `createThread(input: CreateThreadInput)`
- `get` → `getThread(id: string)`
- `list` → `listThreads(channelId, opts?)`
- `update` → `updateThread(id, input: UpdateThreadInput)`
- `delete` → `deleteThread(id)`
- `getMessages` → `getThreadMessages(threadId, opts?)`
- `archiveExpired` → `archiveExpiredThreads()`
- `incrementCount` → `incrementThreadMessageCount(threadId)`

Types re-exported: `Thread`, `CreateThreadInput`, `UpdateThreadInput` (thread-gate.ts:13).
Not re-exported: `ThreadStatus` (exists in thread-types.ts:1; route duplicates the enum — THR-026).

## 3. Return contracts (as implemented)

- `create`: `{ thread }` | `{ thread, created: false }` (existing parent) | `{ error: "channel_not_found" | "parent_not_found" }`.
- `get`: row | `undefined`.
- `list`: `Thread[]` (no `nextCursor` in output — THR-013).
- `update`: `{ thread }` | `{ notFound: true }` (can yield `{ thread: undefined }` under a delete race — THR-009).
- `delete`: `{ deleted: true }` | `{ notFound: true }`.
- `getMessages`: `{ messages, nextCursor }` (oldest-first page) | `{ error: "thread_not_found" }`.
- `archiveExpired`: `number`.
- `incrementCount`: `void` (silent no-op unless status = active).

## 4. Entry points / callers

- **HTTP transport**: `packages/server/src/routes/threads.ts` (`threadRoutes`, 8 endpoints). Sole importer of the facade in the entire repo (grep: only route file imports `threads/thread-gate`).
- **CRITICAL — transport is never mounted**: `routes/index.ts` imports 22 route modules (lines 3-24) and registers them (26-53); `threadRoutes` appears nowhere except its own definition. All 49 git revisions scanned: no revision ever imported/registered it (only a stale `server.zip` binary matched the string). Mechanically confirmed by the audit probe: `registerRoutes()` mounts 0 thread endpoints; `threadRoutes()` mounts all 8 when invoked directly. → **THR-001 (S0)**.
- **UI (dead until THR-001 fixed)**: `packages/client/components/workspace/ThreadDrawer.tsx` calls `/api/channels/:id/threads` (116, 187), `/api/threads/:id/messages` (163, 210); rendered by `MainChatArea.tsx:30,1687`. Client also emits `thread:join` (ThreadDrawer.tsx:161) — no server handler exists (THR-018).
- **Scheduler/worker**: none. `POST /api/threads/sweep` has no cron caller; `REPEATABLES` (queue/repeatables.ts:10-19) has no threads entry; worker.ts only starts the approval sweeper (worker.ts:42-49). → **THR-007**.
- **Socket handlers**: none for threads.

## 5. Dependency map (Caller → Facade → Service → Ports/adapters → Side effects)

```
routes/threads.ts (HTTP, unmounted)
  ├─ threadGate.create ─────────────┐
  ├─ threadGate.get ────────────────┤
  ├─ threadGate.list ───────────────┤
  ├─ threadGate.update ─────────────┤   threads/thread-service.ts
  ├─ threadGate.delete ─────────────┤     ├─ getDb()/withTransaction()  (shared/config/database.ts:316,352)
  ├─ threadGate.getMessages ────────┤     │     └─ drizzle → postgres-js → PG (pool max 20, stmt timeout 15s)
  ├─ threadGate.archiveExpired ─────┤     ├─ tables: threads (W), thread_sequences (W),
  └─ threadGate.incrementCount ─────┘     │          messages (R), channels (R)
                                          └─ (dead import) shared/core/thread-sequence.ts
routes/threads.ts POST messages
  └─ messageGate.append (messages domain)
        ├─ local-first path: localAppendMessage + localAllocateSequence(`thread:<id>`) [no PG needed]
        ├─ PG replica path: allocateThreadSequence(tx) → thread_sequences + messages insert
        └─ side effect: message:new (route re-emits via globalBroker)
side effects outside service: none (no events/logs/metrics in the domain itself)
```

No cycles found inside the domain. External edges: routes→threads gate (clean); threads service→messages/channels **tables directly** (THR-015); messages→shared allocator→thread_sequences table (THR-016).

## 6. Persistence

- Tables (schema.ts:1014-1035; migration `0012_workspace_mounts_threads_approvals.sql:16-36`): `threads` (PK id, FK channel cascade, FK parent/root message set-null, status enum `thread_status` (schema.ts:37), is_ephemeral default true, message_count, last_activity_at), `thread_sequences` (PK thread_id, FK cascade, bigint last_seq).
- `messages.thread_id` is a **plain text column, no FK** (schema.ts:297; migration 0012:10). → THR-005.
- Unique index `messages_channel_sequence_idx (channel_id, sequence_number)` (schema.ts:310; 0000_baseline.sql:478) is **not thread-aware** and collides with per-thread sequences → THR-002.
- Indexes for threads: channel, status, expires (0012:71-73). No composite (channel, last_activity_at DESC) for the list query → THR-020.
- No caches, queues, files, or config owned by the domain. Local tier: **absent** (THR-003); `local-mode-guard.ts:6-7` explicitly lists threads as "documented pending".

## 7. Auth / tenant / ownership

- Auth: none in-domain; global hooks apply when mounted (pinGate create-app.ts:332, authGate 347).
- Tenant: resolved only from `x-workspace-id` → ALS `runWithDb` (create-app.ts:235-303; database.ts:17-22,316). Domain functions take no workspaceId; non-HTTP callers silently hit the global/default DB → THR-025. Note: `ThreadDrawer` fetches go through the patched fetch (pin.ts:175-183) which injects the tenant header — good.
- Ownership: `threads`/`thread_sequences` owned by Threads; `messages`/`channels` read cross-domain (THR-015/016).

## 8. Config / env

- None read in-domain. Transitive: `DATABASE_URL` via getDb (throws when unset → THR-003), `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_S` (database.ts:287-310). Route defaults: isEphemeral true, ttlHours 24 (clamp 1-720), limits 50 (clamp 1-200).

## 9. Docs (drift recorded)

- `re-docs/Backend Docs/Domain Spec/Threads.md` (115 lines) — Ports match the gate exports; Flow/Gaps contain stale line refs and one stale claim (`void existingThread` no longer true) → THR-021.
- `re-docs/Backend Docs/Feature and Flow Spec/Thread lifecycle flow.md`; `_index.md:28`.
- `lint:gates` passes for threads (0 gate violations; run 2026-10-06, exit 0). Redaction + events checks pass.

## 10. Test inventory

- No dedicated tests: grep of all 129 test/spec files for `threadGate|thread-gate|thread-service|threadRoutes` = **0 matches**; for `api/threads|threadId|createThread` = 0. `routes/index.test.ts` regression guard pins ChannelMounts only.
- Audit-only probe (new, under audit/): `audit/domains/threads/probe/registration.probe.test.ts` — 2 passed (proves THR-001). Not production code.

## 11. Boundary violations / smells found (details in bug-ledger.csv)

- THR-001 routes never registered (S0) · THR-002 sequence/index collision (S1) · THR-003 no local tier (S1) · THR-004 create TOCTOU (S2) · THR-005 orphan messages on delete (S2) · THR-006 unguarded status machine (S2) · THR-007 sweep unscheduled (S2) · THR-015 cross-domain table reads (S2) · THR-016 split ownership of thread_sequences (S2) · THR-025 ambient tenant context (S2) · 13 minor S3 items.
