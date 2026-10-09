# Messages Domain - Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: packages/server/src/messages/ (6 files), facade message-gate.ts, transport routes/messages.ts + routes/threads.ts, persistence (schema + migrations 0000/0003/0005/0010/0012/0016), event broker, outbox/workspace-sync, tests, callers, docs.
Method: full read of every domain file and every cross-domain importer; grep across packages, e2e, load, re-docs; typecheck + focused vitest runs (read-only). No production file modified.
Baseline git state at audit time: branch main (ahead 3), pre-existing dirty working tree (many unrelated modified files). Nothing in this audit was committed, staged, or edited.

## 1. Domain files (all read)

| File | Lines | Role |
| --- | --- | --- |
| message-gate.ts | 25 | Facade: 8 value exports + 8 type exports + messageGate object (4 ports) |
| message-service.ts | 527 | All logic: keyset page read + monologue merge engine + sole write path appendMessage |
| message-types.ts | 39 | MessageAuthorType, ChannelMessage, StructuredToolCall, MessagePageCursor, ChannelMessagesPage |
| message-validators.ts | 13 | zod getMessagesParamsSchema, getMessagesQuerySchema |
| message-local-store.ts | 129 | File truth (JSONL + sequences.json) for local tier: localAllocateSequence, localFloorSequence, localAppendMessage, localListRawMessages, localRecentMessages |
| message-pagination.test.ts | 174 | The only in-domain test (PG-gated; skips without DATABASE_URL) |

## 2. Facade surface (exact)

Re-exports (message-gate.ts:14-18):
- Types: ChannelMessage, StructuredToolCall, ChannelMessagesPage, MessagePageCursor, GetMessagesParams, GetMessagesQuery, AppendMessageInput, AppendMessageOpts.
- Values: getMessagesParamsSchema, getMessagesQuerySchema, getChannelMessagesPage, listRecentMessages, parseBeforeCursor, MalformedCursorError, DEFAULT_PAGE_LIMIT, appendMessage.

messageGate object (message-gate.ts:20-25) - 4 ports:
- getChannelMessagesPage(channelId, { limit?, before?, db? })
- listRecent(channelId, limit) -> listRecentMessages
- parseBeforeCursor(raw)
- append(input, { broker?, db?, tx? }) -> appendMessage

Not exported through the gate: MAX_PAGE_LIMIT (service-only export; docs already flag), workspaceOfChannel, all message-local-store functions (imported cross-domain by shared/core/sequence-number.ts:6 and shared/core/thread-sequence.ts:4 - Shared is exempt per AGENTS.md but this is a hidden coupling), TOOL_RESULT_RE, merge internals.

Gate file itself is a pure re-export + port object: no logic (AGENTS.md section 2 satisfied for the gate). But it exposes two parallel surfaces (bare named exports AND the messageGate object); both are used by different callers.

## 3. Entities / invariants / state transitions

- Entity: messages row (PG) / JSONL row (local). Immutable append-only; no update/delete path in-domain.
- Identity: id = caller-provided (scheduler retry key) or monotonicUlid() (message-service.ts:388).
- Sequence: channel-scoped via channel_sequences (PG) or sequences.json key ch:<channelId> (local); thread-scoped via thread_sequences / thread:<threadId> when threadId set. Monotonic, gap-tolerant, never reissued within a tier.
- Ordering: newest-first by (timestamp DESC, sequenceNumber DESC); keyset cursor = strictly-older (timestamp, seq) tuple.
- Display merge (read path only): monologue rows -> tool cards / thought attachments / synthetic monologue-<agentId> rows. DB rows unchanged.
- Write state machine: resolve workspace -> floor local seq from replica head (once/process) -> reserve local seq -> append local file (COMMIT POINT) -> best-effort PG replica insert + counter repair -> outbox on failure -> broker emit message:new.

## 4. Ports / adapters / externals

- PG adapter: drizzle + postgres-js (shared/config/database.ts; pool max 20; statement_timeout 15s).
- Local adapter: shared/core/local-file.ts JSONL/JSON helpers (per-file promise-chain mutex; single-process only).
- Outbox: shared/core/outbox.ts JSONL (outbox.jsonl); drained every 30s by create-app.ts:385-390 (drainOutbox(null)); replayed in shared/core/workspace-sync.ts:403-512.
- Workspace tiering: tierContextFor + resolveTier + withStoreFallback (shared/config/database.ts:149-208); per-workspace DB via workspace-gate.getWorkspaceDb.
- Broker: EventBroker in-process emitter; sockets fan out message:new to workspace-scoped rooms (shared/sockets/register-socket-server.ts:414-461).
- Gates called (gate-to-gate only): channelGate.get (workspaceOfChannel), tierContextFor + dynamic getWorkspaceDb from workspace-gate. Type-only: agent-gate.AuthorityLevel, types/mention.types.MentionMetadata, event-broker-gate.EventBroker.

## 5. Entry points

- REST read: GET /api/channels/:channelId/messages (routes/messages.ts:15-43) - zod params/query; parseBeforeCursor -> 400 on malformed; forwards (request as any).db (tenant handle).
- REST write (threads): POST /api/threads/:threadId/messages (routes/threads.ts:83-116) -> messageGate.append({threadId}); emits message:new itself via global broker (append was called without broker). NOTE: threadRoutes is not registered in routes/index.ts (pre-existing THR-001 from the threads audit) - the only REST write entry point is currently unmounted.
- Socket write: user:message (register-socket-server.ts:680-749) -> messageGate.append (broker passed).
- System writers: triggerSystemWarning (:140); scheduler worker (queue/scheduler-worker.ts:38); tools scheduler (tools/tool-registry.ts:99 + ephemeral fallback); escalation (agents/agent-errors.ts:132,156,192); librarian (shared/core/librarian-runtime.ts:134); token warnings (shared/core/token-tracker.ts:161); runtime persist (runtime/kernel/runtime-kernel.ts:198); state gate passthrough (state/state-gate.ts:54 - currently zero callers).
- Jobs: outbox drain (30s interval, API process only); index-builder per-message counter (message:new listener, register-socket-server.ts:464-471).
- CLI/seed exceptions: db/check.ts:78,122 (health roundtrip insert/delete); workspace/workspace-database.ts:564 (bootstrap seed msg-crowdos-welcome).

## 6. Dependency map (Caller -> Facade -> Service -> Port -> Adapter)

    Callers (writes, all via messageGate.append)
      routes/threads.ts:98
      shared/sockets/register-socket-server:140,738
      runtime/kernel/runtime-kernel:198
      agents/agent-errors:132,156,192
      tools/tool-registry:99
      shared/core/librarian-runtime:134
      shared/core/token-tracker:161
      queue/scheduler-worker:38
      state/state-gate:54 (no callers)
        -> messages/message-service.appendMessage
             - workspaceOfChannel -> channelGate.get -> channels domain
             - tierContextFor -> workspace-gate (registry record)
             - localAllocateSequence/localAppendMessage -> local-file JSONL (COMMIT POINT)
             - appendOutbox -> outbox.jsonl (paused/local/failure)
             - PG replica: getWorkspaceDb (workspace record DB) else ambient withTransaction
             - broker.emit("message:new")
    Callers (reads)
      routes/messages.ts:27 -> getChannelMessagesPage -> withStoreFallback(localListRawMessages, PG keyset) -> assemblePage/mergeMessageRows
      runtime/kernel/middlewares/channel-awareness + visibility-matrix (46,77) -> listRecent -> withStoreFallback
      tests: channels/channel-local-mode, runtime/local-chat-e2e, runtime/tool-call-round-trip, runtimes/monologue-e2e, events/events-integration
    Cross-domain internals imports (bypass)
      shared/core/sequence-number.ts:6 -> messages/message-local-store.localAllocateSequence
      shared/core/thread-sequence.ts:4 -> messages/message-local-store.localAllocateSequence
      shared/core/workspace-sync.ts:47 -> type LocalMessageRow only
    Table owners outside the domain (labeled exceptions)
      db/check.ts (health roundtrip), workspace/workspace-database.ts (bootstrap seed), shared/core/workspace-sync.ts:253,258,448 (pull/push/outbox replay)

Cycles: none introduced by messages (no A<->B cycle found).
Hidden deps: module-level mutable state in message-service.ts:27 (channelWorkspaceCache) and :43 (seqFloored) - process-local; outbox.ts module counter outboxSeq.
Global state: broker per server instance; local file mutexes per process only (documented ceiling: multi-process writers need PG).

## 7. Persistence

- PG messages table: id PK; channel_id FK cascade; workspace_id nullable FK; thread_id plain text NO FK; author_*; content; mentions jsonb NOT NULL default []; metadata jsonb; tool_calls jsonb; is_internal_monologue bool; sequence_number int NOT NULL; timestamp timestamptz. Indexes: UNIQUE (channel_id, sequence_number) (0000_baseline.sql:478 - NOT thread-aware), (channel_id, timestamp DESC) (0005), (channel_id, timestamp DESC, sequence_number DESC) (0010), (thread_id, timestamp DESC, sequence_number DESC) (0012), (workspace_id) (0016).
- channel_sequences(channel_id PK, last_seq bigint, updated_at); thread_sequences(thread_id PK, last_seq, updated_at).
- Local files: <workspaceFolder>/vfs/.crowdos/messages/<channelId>.jsonl; sequences.json; outbox.jsonl; per-file promise-chain mutex; single-process only.
- Migrations touching messages: 0000 (baseline + unique index), 0003 (tool_calls), 0005/0010 (indexes), 0012 (threads + thread index), 0016 (workspace_id nullable + FK + index; normalizes drifted NOT NULL DBs).

## 8. Auth / tenant / ownership boundaries

- REST: global default-deny API-key gate + loopback trust (create-app.ts:347). Tenant DB resolved from x-workspace-id into request.db via runWithDb (create-app.ts:235-318); route forwards (request as any).db -> explicit PG pin. Without the header, request.db is undefined -> tier path.
- The messages domain performs NO tenant authorization: it resolves the owning workspace from the channel row and trusts it. The REST read route never compares request.workspaceId with the channel's workspace (socket rooms DO enforce this; contrast register-socket-server.ts:551-568). With the header present the tenant hook picks the caller's DB; without it, reads resolve by channel id against the ambient/local store. See MSG-007.
- Ownership: channels -> workspace immutable after create (comment message-service.ts:24-26).

## 9. Config / env assumptions

- Domain reads no env directly. Assumes: workspace record databaseUrl decides replica target; otherwise local tier. CROWDOS_LOCALSTORE_DIR / WORKSPACE_DIR / CROWDOS_WORKSPACE_REGISTRY_FILE control local paths (via shared local-file).
- Local mode is single-process by construction (documented) - API+worker both writing local files would race.

## 10. Tests / coverage snapshot

- In-domain: message-pagination.test.ts - 5 tests, ALL SKIPPED without DATABASE_URL (verified run: 1 file skipped, 5 tests skipped, exit 0). Covers PG keyset page walk, ordering, limit, cursor parse, exhaustion. No local-tier test, no append test, no merge test, no error-path test in-domain.
- Cross-domain coverage exercising the domain: channels/channel-local-mode.test.ts (local append + paging; 6 passed), runtime/tool-call-round-trip.test.ts (merge cards via fake DB; passed), runtime/local-chat-e2e.test.ts (currently FAILING - runtime model-module issue), runtime/runtimes/monologue-e2e.test.ts (passed), events/events-integration.test.ts (failing, same unrelated root cause), shared/core/workspace-sync.test.ts (passed).
- Client contract: packages/client/stores/messagePagination.test.ts (8 passed) pins the envelope shape (messages newest-first + cursor).

## 11. Docs

- re-docs/Backend Docs/Domain Spec/Messages.md (status draft): Ports list is STALE - still lists messageGate.getChannelMessages (removed) and does not match the current gate object; _index.md:17 maps Messages -> messages/message-gate.ts; Feature and Flow Spec/Message history.md + Chat send-message flow.md. Doc/code drift recorded as MSG-016.
