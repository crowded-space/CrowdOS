# State Domain - Invariant Catalog (read-only audit, 2026-10-06)

Legend: Enforced = guarded on all production paths; Partial = holds on some paths; Unenforced = intent only; Broken = code contradicts intent.

## A. Emission invariants (this domain's own contract)

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-1 | run.status_changed is emitted exactly once per changed executor-driven transition | Enforced (single path) | state-gate.ts:23 (emit only when changed), :30-44 (one emit) | No test pins it; verified by read |
| INV-2 | No emission on rejection (null) or no-op ({changed:false}) | Enforced | state-gate.ts:23 early return | app code |
| INV-3 | Emit failure never fails the caller transition | Enforced | state-gate.ts:25-47 try/catch -> console.error | app code |
| INV-4 | Every run.status_changed carries the run's channelId as the room tag | Enforced | state-gate.ts:43 { channelId: outcome.row.channelId } | payload also carries channelId at :35 |
| INV-5 | All run-status changes emit run.status_changed | Broken | 17 direct runsGate.transition sites persist with no emit (tool-executor.ts:468,515,542,545,695,719,730,732; approval-sweeper.ts:41; routes/approvals.ts:79; register-socket-server.ts:1160; research-runtime.ts:404-405,454-456) | STATE-002; the state-gate header comment (:3-5) admits it as follow-up |
| INV-6 | All message commits from execution paths go through stateGate.applyMessage | Unenforced | zero callers of applyMessage (grep); runtime writers call messageGate.append / kernel paths directly | Doc "Architectural Standard (Target)" claims it; STATE-004 |
| INV-7 | run.status_changed payload keys are identical across all emitters | Partial | three hand-rolled copies: state-gate.ts:32-42, runs-service.ts:24-35, orphan-sweep.ts:47-56 | EventBrokerMap type pins keys, but copies can drift silently; STATE-006 |
| INV-8 | errorCode passthrough preserves runs-repository sticky semantics (undefined = leave stored code) | Broken | state-gate.ts:28 normalizes undefined -> null, and runs-repository writes errorCode: null (clears); runs-repository.ts:130 comment + apply-transition.test.ts RUN-001 cases define the opposite | STATE-003 |

## B. Persistence-ordering invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-9 | State is persisted before the event is emitted (no event for a rejected write) | Enforced | state-gate.ts:22 (await transition) before :30 (emit) | app code |
| INV-10 | Emit happens iff the persisted outcome changed | Enforced | state-gate.ts:23 | app code |
| INV-11 | A lost event (crash/broker outage between persist and emit) is replayed or compensated | Unenforced | none; no outbox/retry in the gate; console.error at :46 is terminal | STATE-005 |
| INV-12 | The gate never writes runs/messages past the owning gates | Enforced | only runsGate/messageGate calls; check-gates 0 violations | gate lint green |

## C. Concurrency / idempotency invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-13 | Concurrent transitions on one run cannot both emit changed events for the same hop | Enforced | runs-repository CAS WHERE status=from + retry-once; loser gets null or changed:false, so at most one emit per real change | runs-repository.ts:123-131 |
| INV-14 | Duplicate applyRunTransition calls for the same target are no-ops that emit nothing | Enforced | second call returns { changed: false } -> gate returns early | state-gate.ts:23 |
| INV-15 | The gate is safe under ALS-less worker execution | Enforced | broker passed explicitly by executor; fallback shared broker is worker-local (worker.ts:48) | read |
| INV-16 | Gate calls are tenant-correct for dual-tier workspaces | Enforced (executor path, external XD-002) | state-gate.ts:20,29 threads workspaceId; runtime-executor.ts:251 supplies the row's id; runs-repository routes it to dbForWorkspace | STATE-001 Fixed externally during audit; regression test still missing (test-gaps item 3) |

## D. Facade-shape invariants (AGENTS.md)

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-17 | Gate is a thin facade: wire + re-export only, no fetch/DB/branching | Partial | state-gate.ts:21-55 contains an emit branch (if !broker, if changed) and a try/catch - arguably wiring, but it is the only gate with emission logic | AGENTS.md section 2 says "no logic... in gate"; emission wiring is the accepted exception per doc |
| INV-18 | Nothing outside state/ imports past state-gate.ts | Enforced | only file is state-gate.ts | check-gates 0 violations |
| INV-19 | Gate-to-gate imports only; no cycles | Enforced | state -> runs-gate/message-gate/event-broker-gate; none import state | grep + check-gates |
| INV-20 | Naming: kebab-case files, camelCase types | Enforced | state-gate.ts, RunTransitionInput | AGENTS.md section 1 |

## E. Documentation invariants

| ID | Invariant | Status | Where enforced | Evidence / gap |
| --- | --- | --- | --- | --- |
| INV-21 | Domain Spec/State.md Ports equal gate exports | Enforced | doc lists applyRunTransition/applyMessage/aliases/RunTransitionInput; code matches | read of both |
| INV-22 | Docs reflect the direct-transition bypass as a known gap | Enforced | State.md Gaps paragraph + state-gate.ts:3-5 comment | both documents exist; bug not tracked in a ledger until now |
