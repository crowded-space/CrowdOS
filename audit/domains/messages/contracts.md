# Messages Domain - Phase 2 Contract and Invariant Audit (read-only, 2026-10-06)

One row per facade method. Current = as implemented today; Gap = divergence from documented/ideal contract.
Line refs without a filename are packages/server/src/messages/message-service.ts.

## Contract matrix

| Method | Inputs | Preconditions / validation | Result contract | Errors | Auth / tenant | Idempotency | Txn boundary | Consistency / concurrency | Side effects and ordering | Events | Retry / cancel | Observability | Perf | Compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| messageGate.getChannelMessagesPage(channelId, opts) | channelId: string; opts: { limit?: number; before?: { timestamp: Date; seq: number }; db?: any } | None in service. Route validates channelId min 1, limit coerce int 1-200 via zod (routes/messages.ts:18-21). Direct callers unvalidated | Promise<{ messages: any[]; cursor: { before: { timestamp: string; seq: number } } | null }> newest-first merged display rows | MalformedCursorError only from parseBeforeCursor (route maps 400). DB/local errors propagate raw (500) | None in-domain. db override pins PG exactly (:308); otherwise tierContextFor(workspaceOfChannel(channelId)) | Read-only; idempotent | Single keyset query (limit+1) or local full-file scan; no txn | Keyset (timestamp, seq) strictly older; merge pairs only within one page (page-boundary loss, MSG-004) | None | n/a | None (no span/metric on read) | PG index-backed; local O(n) scan per read (documented ponytail) | Newest-first envelope + cursor pinned by client tests (packages/client/stores/messagePagination.test.ts) |
| messageGate.listRecent(channelId, limit) | channelId: string; limit: number | None | Promise<any[]> raw rows newest-first, unmerged | DB/local errors propagate | None; workspace tier via workspaceOfChannel | Read-only; idempotent | Single query; no txn | PG orders by timestamp DESC only (no seq tiebreak, MSG-006); local ties on seq | None | None | n/a | None | 1 query or local scan; memoized per context packet | Raw row shape consumed by context middlewares |
| messageGate.parseBeforeCursor(raw) | raw: string | undefined | null | Non-empty; split on LAST ; ; both sides present; seq all digits; date parseable (:149-159) | { timestamp: Date; seq: number } | undefined when raw falsy | MalformedCursorError (code PAGINATION_BAD_CURSOR) | None | Pure; idempotent | n/a | n/a | n/a | n/a | n/a | Trivial | Cursor string format shared with client encodeBeforeParam |
| messageGate.append(input, opts) | AppendMessageInput { channelId, authorId, authorName, authorLevel: string|number, authorType, content, mentions?, metadata?, toolCalls?, isInternalMonologue?, threadId?, workspaceId?, id? }; opts { broker?, db?, tx? } | NONE in service (no required-field/type/length validation; zod guards only the read route). authorType is TS-only | Promise<messages row>; authorLevel returned as caller type (string|number) though stored String() (:396 vs :438,:468) | Local-tier errors propagate (commit point). PG replica errors never propagate (outbox + console.warn :512-523). tx/db path: PG errors propagate | None in-domain; explicit tx/db pins PG exactly (:431). Workspace from input or channel row (:445) | Not idempotent by default: new seq + new row per call. Caller id + replica onConflictDoNothing only de-dup the PG leg; local JSONL still appends a duplicate line (MSG-005) | Local: seq reserve then file append (two locked ops; crash gap documented). tx/db: seq + insert in one PG txn. Dual: local commit then separate PG txn | Local per-file mutex; cross-process relies on PG counter GREATEST repair | Order: floor check, local seq reserve, local append (COMMIT), PG replica insert + counter repair (best effort), outbox on failure, broker emit. Emit after local commit even if replica failed (:525) | message:new exactly once per successful call when broker passed; thread route emits manually without passing broker (MSG-009) | No in-domain retry; outbox replay is the replica retry (insert-ignore by id) | None (console.warn only) | Dual: 1 floor read (once/process) + file append + 1-2 PG roundtrips | Broker payload keeps caller shape; local JSONL normalizes (authorLevel String, timestamp ISO, absent => null). Tier shape drift MSG-003 |
| getMessagesParamsSchema / getMessagesQuerySchema | zod schemas (message-validators.ts:1-13) | params: channelId min 1; query: limit coerce int 1-200 optional, before min 1 optional | Parsed objects | zod errors -> Fastify 400 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Route-only usage today |
| DEFAULT_PAGE_LIMIT | const 50 (:139) | n/a | number | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | MAX_PAGE_LIMIT not re-exported (MSG-013) |
| MalformedCursorError | class (:142-147) | n/a | instanceof marker; code PAGINATION_BAD_CURSOR | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Route catches by instanceof; gate re-export keeps identity |
| listRecentMessages / appendMessage (bare re-exports) | identical to listRecent / append | identical | identical | identical | identical | identical | identical | identical | identical | identical | identical | identical | identical | Two parallel surfaces in use (messageGate.* in routes/sockets; bare imports in runtime-kernel, middlewares, tests) |

## Per-method gaps

### getChannelMessagesPage
- Limit clamp Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200) (:291). NaN limit from a direct caller yields NaN -> local slice(0, NaN) = [] / PG error (MSG-014).
- db override pins PG and SKIPS the local tier (:308), inverting local-first for readers with an x-workspace-id header when the replica is behind (MSG-024).
- Cursor comes from the oldest RAW row of the page when hasMore (:339-347); merge may append synthetic rows that are not represented in the cursor.
- messages: any[] (message-types.ts:36): no discriminated union; consumers probe .type/.toolExecution defensively.

### listRecent
- dbOverride fast path (:264-271) bypasses tiering and workspaceOfChannel; NOT reachable through the gate (gate maps to the 3-arg function).
- PG ordering lacks the seq tiebreak used by the local path (MSG-006).

### parseBeforeCursor
- Splits on LAST ; by design; seq must be all digits; no length cap (route zod has no max on before).

### append
- Zero validation (MSG-012): content can be undefined via the socket path (register-socket-server.ts:688,738-749).
- authorLevel type drift (MSG-003): stored String(), returned original.
- message:new emitted after local commit even when the PG replica leg failed (:525); consumers reading PG may not see the row (MSG-018).
- tx path emits after the PG txn but before the caller outer transaction commits if opts.tx was provided by a caller (:431-443); latent (MSG-019).
- floorLocalSequenceFromReplica uses ambient getDb() instead of the workspace handle (:61-66); same asymmetry in the read gap-fill fetchPg(getDb()) (:313) (MSG-010).
- PG replica insert onConflictDoNothing() with no target swallows ANY unique violation, including (channel_id, seq) collisions with thread rows (MSG-002).
- Workspace cache can pin a stale null (MSG-011).

## Cross-cutting contract notes
- Two write tiers, one logical contract: callers cannot distinguish committed-locally-only from committed-and-replicated; the only signal is a console.warn.
- The gate re-exports implementation identifiers (not wrappers), so the facade surface is wider than the documented ports list.
- Event schema: message:new payload is the messages row, while event-types.ts imports the ChannelMessage type from the gate; ChannelMessage lacks threadId/workspaceId and its authorLevel union is AuthorityLevel | stakeholder (message-types.ts:11) while append accepts string|number. Declared type vs emitted shape drift (MSG-003).