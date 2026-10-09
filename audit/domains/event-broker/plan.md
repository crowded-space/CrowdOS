# event-broker - ordered incremental fix plan (no rewrite; facade contract preserved)

Rule: each item ships code + docs sync (Domain Spec Ports/Relations + _index/_flow-index if links change) in the SAME task per AGENTS.md s6. No branches, main only, ask before commit.

1. B4 - approval.requested guaranteed-or-loud (High): emit BEFORE runsGate.transition no; instead assert broker present before creating pending approval, or escalate dropped-emit warn to metric + sweeper-visible flag. Touches tool-executor.ts:452-483 + approval-gate emitDecided. Test: no-broker case resolves via poll + counter increments.
2. B1 - oversize drop observability (Medium): add dropped counter / return flag without changing emit signature (attach non-breaking field or stats export). Test: oversize payload asserts no-delivery + counter.
3. B3 - single-handle hygiene (Medium): narrow tool-executor fallback to getSharedBroker only; remove globalBroker read (register-socket-server.ts:47 stays as owner reference). Document worker-local invisibility in Domain Spec. Test: worker emit does not leak (by construction) + shared-only resolution.
4. B7 - move Mode/isValidMode out of broker gate (Medium, codemod-only separate task): new home TBD (runtime or composer domain); keep re-export shim one release. Docs: Ports update.
5. B2/B5 - listener hygiene (Low): reconcile LISTENER_WARN_AT with emitter count (use emitter.listenerCount) and note synchronous fan-out in Domain Spec; no behavior change.
6. Dedicated broker unit suite: create event-broker/event-broker.test.ts covering gaps 1-4,8 (throw isolation, off semantics, channel fallback, seq-null live). In-domain test may import internals per AGENTS.md.

Rewrite decision: NO rewrite. Broker is ~120 lines, thin gate, 0 gate violations, callers healthy. Incremental items above close the real risks (B4, B1, B3) at low blast radius.
