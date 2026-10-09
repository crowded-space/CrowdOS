# Events Domain — Invariants (audited, with evidence)

Legend: status = Holds / Holds-with-caveat / Violated / Unverified.

## Core invariants

1. **One writer path.** The only production append site is the boot-registered broker onAny hook (create-app.ts:365). No producer appends by hand. — Holds. (Grep over src: importers of events/* are create-app.ts:32, routes/events.ts:3, in-domain tests only; check-gates 0 violations.)

2. **Append-only, one JSON line per record.** appendEventJsonl appends JSON.stringify(row)+"\n" (local-file.ts:402-417); reader skips non-JSON lines (local-file.ts:438-461). — Holds.

3. **Torn tail never fatal; next append repairs.** terminateTornTail writes the missing newline when last byte != 0x0A (local-file.ts:420-435); tested in events-log.test.ts "skips a torn trailing line instead of throwing" (append seq 2 after torn line). — Holds.

4. **Per-channel seq monotonicity (bump-first).** allocateEventSeq increments counter before append; crash => gap not duplicate. Floor: once per channel+workspace per process, counter is raised to file head (event-local-store.ts:96-116). — Holds within one process. Caveat: if the counter file is reset/replaced AFTER the floor ran (memoized in flooredChannels, :84), the next allocation can re-issue seqs already present in the file => duplicate seqs in the log until restart (EVT-06, Medium). The floor memo key uses (workspaceId ?? "default") (:89) — an event recorded with workspaceId=null and later with a real id floors two distinct keys but they may resolve to the same file, so the second scope's floor also protects it only once.

5. **afterSeq is exclusive; lastSeq = highest returned, else head; empty log = {[],0,0}.** listEventTail (event-local-store.ts:166-190); route test "caught up" asserts []+head; "honest empty" asserts {[],0}. — Holds.

6. **limit clamps 1..200 in store; route zod caps 200 (201 => 400).** clampLimit:51-54; MAX_EVENT_PAGE_LIMIT:48; route schema; both tested. — Holds.

7. **Classification: message:stream never persisted; channel-less events never persisted; payload-only channelId counts.** event-classification.ts:21,36,61; tested in events-log.test.ts ephemeral suite. — Holds. Note: classification uses raw event.type against a string set; a new high-frequency key added to BrokerEventMap is durable-by-default until someone edits EPHEMERAL_EVENT_TYPES (documented rule; review obligation).

8. **Appends are best-effort: never throw into the emit path; failures counted + warned.** recordBrokerEvent catch (event-log-service.ts:100-110); stats.failed tested via ENOTDIR blocker. — Holds. Caveat: the drop is only observable in-process (console.warn + counter); no metric export, no outbox/retry (EVT-08, EVT-10).

9. **Workspace isolation by path.** Log file lives under the owning workspace folder; channel->workspace resolved row-first then log-file scan (event-log-service.ts:51-64; local-file.ts:242-259). Tested: two workspaces keep independent files + independent seq spaces (events-log.test.ts §30). — Holds by path. Caveat A: WRITE scope trusts payload.workspaceId when present (event-log-service.ts:84) BEFORE the channel lookup, so a producer that tags a payload with a foreign workspaceId writes the line into that foreign workspace's folder (EVT-02, High, S2). Caveat B: READ scope is channel-derived (routes/events.ts:39 calls listRecent with no workspaceId), so the reader is not tenant-filtered by x-workspace-id; any caller who knows a channelId reads that channel's log (EVT-03, Medium, S2; loopback-trust model makes this acceptable on desktop, but it is an isolation gap in any multi-tenant deployment).

10. **Hostile channel ids cannot escape the events dir.** safeChannelFileId maps [^A-Za-z0-9_-] -> "_" (local-file.ts:389-391); tested with "../../etc/passwd". — Holds for path traversal. Caveat: two distinct raw ids can sanitize to the SAME file stem (e.g. "a/b" and "a?b" -> "a_b"), so their records share one file; the tail does NOT filter rows by row.channelId, so cross-id bleed is possible for colliding ids (EVT-15, Medium, S3).

11. **Record shape stable and JSON-safe.** createdAt ISO string, ts epoch ms, workspaceId/agentId nullable (event-log-types.ts). — Holds; tested field-by-field on first line.

12. **No dedupe.** Same eventId appended twice => two lines, two seqs (no unique constraint). — Documented behavior (spec Gaps); latent risk only if re-emission is ever introduced (EVT-12, Low).

13. **Stats counters are process-lifetime and test-resettable.** — Holds; reset helpers exported through the gate.

14. **Gate shape.** eventsGate ports equal facade exports used by outsiders; gate contains no logic (wire + re-export only, gate:1-54). — Holds for thinness; but surplus internal exports (allocateEventSeq, appendEventRecord, listEventRowsNewestFirst, EPHEMERAL_EVENT_TYPES, resolve*, DEFAULT/MAX limits) widen the contract beyond what callers use (EVT-01, Low).

15. **In-process only; worker does not append.** hook attaches to process-local broker; worker.ts has no events hook (by design, documented). — Holds. Consequence: bullmq-mode worker-produced events never reach the log (documented gap; not a new bug).

16. **Reads are O(file size).** listEventTail reads the whole file, scans, sorts (event-local-store.ts:166-190). — Holds as designed; with no retention (spec Decisions) the cost grows unbounded (EVT-05, Medium, S3 perf).

17. **Head/stats consistency across scopes.** workspaceOfChannel caches ONLY positive hits (never pins null; :52-61) to avoid first-event races. — Holds by construction; but a wrong positive memo can never be invalidated except by the >5000 clear (:60), so if a channel's workspace resolution ever changes (or two workspaces race the same channel id), the memo pins the first winner for process life (EVT-04, Low).

18. **Empty/absent log read never fabricates.** route test asserts no deprecated field, exact key set {channelId, events, lastSeq}. — Holds.

## Cross-domain invariants that touch Events

19. Message space vs event space stay separate counters (messages/sequences.json vs event-sequences.json). — Holds; client merges both into one per-channel high-water mark (documented client-side limitation, spec Gaps; not fixable server-side alone).

20. Doc-code sync: Events.md cites `create-app.ts:344` for the hook, code is at :365 (drift); Events.md is otherwise accurate vs code except the missing mention of payload-workspaceId write trust. — Violated (EVT-13, Low; docs noted, not edited per READ-ONLY scope).
