# State Domain - Phase 1 Inventory (read-only audit, 2026-10-06)

Scope: packages/server/src/state/ (1 file), facade state-gate.ts, callers (runtime-executor), dependency gates (runs-gate, message-gate, event-broker-gate), persistence reached through them, emit fan-out, tests, docs.
Method: full read of the domain file and every cross-domain import site; grep across packages/server/src; typecheck + focused vitest runs (read-only). No production file modified, no branch created, no commit.
Baseline git state at audit time: branch main, pre-existing dirty working tree (unrelated modified files), audit/ untracked. Nothing in this audit was staged or committed.
Concurrent-change note: during this audit window an external edit landed in state-gate.ts (diff comment "XD-002") adding an optional workspaceId to RunTransitionInput and threading it into runsGate.transition, with runtime-executor.ts:243-251 now passing the fetched row's workspaceId. That edit was NOT made by this audit (this audit wrote only audit/domains/state/*). All findings below were re-checked against the post-edit file; STATE-001 is now Fixed externally, the rest stand. TSC re-verified green after the change.

## 1. Domain files (all read)

| File | Lines | Role |
| --- | --- | --- |
| state-gate.ts | 68 | Entire domain: thin facade with 2 functions + 1 type + stateGate object (post-XD-002) |

There is no service, repository, validator, test, or local-store file in this domain. All logic lives in the two gates it fronts.

## 2. Facade surface (exact, state-gate.ts)

Exports:
- Type: RunTransitionInput (state-gate.ts:13-21) - { runId, to: RunStatus, reason?, errorCode?, broker?, workspaceId? } (workspaceId added externally as XD-002).
- Value: applyRunTransition(input) (state-gate.ts:23-57) - guarded run transition + single run.status_changed emit.
- Value: applyMessage(input, opts) (state-gate.ts:59-63) - passthrough to messageGate.append.
- Value: stateGate object (state-gate.ts:65-68) with the two aliases applyRunTransition / applyMessage.

Imports (gate-to-gate only): runs-gate.ts:7, message-gate.ts:8 (value); runs-gate.ts:9, message-gate.ts:10, event-broker-gate.ts:11 (type); dynamic import of event-broker-gate.ts:26.

## 3. Entities / invariants / transitions

- Entity ownership: NONE persisted. The domain mutates runs rows (via runs-gate) and messages rows (via message-gate); it owns only the mutation ordering contract (persist -> emit).
- Run status transitions: delegated to runs/run-state-machine.ts (16 states, TERMINAL = completed/failed/cancelled, cancelling is the only funnel to cancelled). The state domain adds no transition rules.
- Message writes: delegated to messages/message-service.appendMessage (local commit point -> replica -> outbox -> message:new).
- Emit rule (the domain's real invariant): emit run.status_changed only when outcome.changed === true; no-op (changed:false) and rejection (null) emit nothing.

## 4. Ports / adapters / externals

- runsGate.transition -> runs-repository.applyTransition (DB via shared/config/database.ts getDb/dbForWorkspace).
- messageGate.append -> message-service.appendMessage (local file store, PG replica, outbox).
- EventBroker.emit -> in-process EventEmitter; subscribers: socket fan-out (shared/sockets/register-socket-server.ts:414 onAny), durable event log (create-app.ts:365 onAny -> eventsGate.recordDetached), worker-local onAny (queue/run-worker.ts:52).
- Shared broker singleton: event-broker/shared-broker.ts (set at create-app.ts:356, worker.ts:48, register-socket-server.ts:321).

## 5. Entry points / callers

| Caller | Site | Notes |
| --- | --- | --- |
| Runtime executor walkTransitions | runtime/runtime-executor.ts:239-252 (dynamic import) | ONLY production caller of stateGate; passes broker + row workspaceId explicitly (post-XD-002) |
| stateGate.applyMessage | none | zero callers (grep) |
| Direct runsGate.transition (bypasses this gate, no run.status_changed) | tool-executor.ts:468,515,542,545,695,719,730,732; approval-sweeper.ts:41; routes/approvals.ts:79; register-socket-server.ts:1160; research-runtime.ts:404-405,454-456 | 17 sites; see STATE-002 |
| Emitters of run.status_changed outside this gate | runs-service.ts:23-37 (resumeRun); orphan-sweep.ts:46-57 (sweep) | payload duplicated 3x; see STATE-006 |

No routes/sockets/jobs import state-gate directly. No test file references stateGate/applyRunTransition/applyMessage (grep).

## 6. Dependency map (Caller -> Facade -> Service -> Port -> Adapter)

    RuntimeExecutor.walkTransitions (runtime-executor.ts:231-256, called from :94,:97,:104,:199,:224)
      -> state/state-gate.applyRunTransition (state-gate.ts:23)
           -> runs/runs-gate.transition (runs-gate.ts:36-42)                [gate-to-gate]
                -> runs/runs-repository.applyTransition (runs-repository.ts:106-138)
                     -> run-state-machine.transition (pure, runs/run-state-machine.ts:69)
                     -> getDb() / dbForWorkspace() (shared/config/database.ts:316,325)
                     -> db/schema runs table
           -> event-broker-gate.getSharedBroker (dynamic import, fallback when input.broker is null)
           -> EventBroker.emit('run.status_changed', payload, {channelId})
                -> socket fan-out (register-socket-server.ts:414)
                -> durable event log (create-app.ts:365 -> events/events-gate.recordDetached)

    (zero callers) stateGate.applyMessage (state-gate.ts:51)
      -> messages/message-gate.append -> message-service.appendMessage -> local store + PG replica + outbox + broker emit('message:new')

## 7. Persistence / tables / migrations / caches / queues

- Tables touched (owned by other domains): runs (status writes), messages (via applyMessage). No migrations, indexes, or caches in this domain.
- Module-level state: NONE in state-gate.ts (no cache, no counter). The only hidden global is the shared-broker singleton read at state-gate.ts:26.
- Queues: none.

## 8. Auth / tenant / config

- No auth, no tenant checks, no env reads in this domain. Tenant routing depends entirely on the callee: runs-repository resolves via ALS getDb()/dbForWorkspace, but the gate never passes workspaceId (STATE-001). RUNS_ENABLED=false surfaces as null via runsGate.transition (indirect).

## 9. Cycles / boundary violations

- Cycles: none. state -> runs/messages/event-broker (gates); none of those import state. Runtime imports state dynamically (runtime-executor.ts:239), state does not import runtime.
- check-gates.mjs: 0 violations, state among the 23 scanned domains; no cross-domain import past a gate.
- Hidden coupling: run.status_changed payload shape is hand-rolled in 3 places (STATE-006); the "single emission point" claim only covers executor walks (STATE-002). The external XD-002 edit only touches the executor path; the 17 direct transition sites remain unthreaded/unemitted.

## 10. Tests / docs snapshot

- In-domain tests: none (vitest src/state -> no test files, exit 1).
- Indirect coverage: runs unit/integration suites cover the machine + repository mechanics the gate calls; no suite exercises the gate itself (emission, broker fallback, errorCode passthrough).
- Docs: re-docs/Backend Docs/Domain Spec/State.md matches the current gate surface (Ports = applyRunTransition/applyMessage/aliases/RunTransitionInput); _index.md:22 maps State -> state/state-gate.ts. Its Gaps section already notes the direct-transition bypass. No drift found between doc and gate exports.
