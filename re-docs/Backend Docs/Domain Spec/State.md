# State

## Purpose
Event→reducer→state sole mutator for run + message state (CrowdOS §28). Every executor-driven `run.status_changed` flows through `stateGate.applyRunTransition` (validate via machine → persist → emit); messages flow through `stateGate.applyMessage` (commit → emit). Callers must not write runs/messages past this gate.

## Feature Scope
In-scope:
- Guarded run transitions with single emission point (`applyRunTransition`).
- Message commit passthrough with one entry point per entity type (`applyMessage`).

Non-goals (other domains):
- Transition guard + persistence → Runs (`applyTransition` owns the machine + `WHERE status = from` write).
- Message commit + history truth → Messages (`messageGate.append` owns sequence + local/PG commit).
- Execution walks → Runtime (`RuntimeExecutor` calls this gate per hop).

## Expect
- `[Observed]` `applyRunTransition` returns `null` on illegal transitions and `{ changed: false }` on idempotent no-ops (pass-through from `runsGate.transition`).
- `[Observed]` Broker emit happens only when `outcome.changed` is true; no-ops and rejections emit nothing.
- `[Observed]` `applyMessage` delegates to `messageGate.append`, which already commits + emits atomically.

## Flow
1. Executor `walkTransitions` calls `stateGate.applyRunTransition({ runId, to, reason, errorCode, broker })` per hop (`runtime-executor.ts`).
2. Gate calls `runsGate.transition`, then emits `run.status_changed` via the passed broker (or shared broker fallback) with `{ runId, agentId, channelId, workspaceId, runtimeType, status, from, reason, errorCode }`.

## Current Implementation
| File | Role |
| ---- | ---- |
| `state/state-gate.ts` | Thin facade: `applyRunTransition` + `applyMessage` plus `stateGate` object |

## Ports
- `applyRunTransition` (`state-gate.ts`) — guarded run transition + single `run.status_changed` emit; returns the `TransitionResult` or `null`.
- `applyMessage` (`state-gate.ts`) — message commit passthrough to `messageGate.append`.
- `stateGate.applyRunTransition` (`state-gate.ts`) — port alias.
- `stateGate.applyMessage` (`state-gate.ts`) — port alias.
- `RunTransitionInput` (`state-gate.ts`) — `{ runId, to, reason?, errorCode?, broker? }` input type.
- `RunTransitionInput` (`state-gate.ts`) — `{ runId, to, reason?, errorCode?, broker?, workspaceId? }` input type; the executor passes the run row's workspace so split-DB runs transition on their own handle (XD-002 fixed).
- `flushPendingStatusEvents` (`state-gate.ts`) — STATE-005 repair port: re-emits buffered `run.status_changed` payloads (missing-broker / emit-throw gaps) via the passed or shared broker; returns the delivered count.
- `resetPendingStatusEventsForTests` (`state-gate.ts`) — clears the pending buffer (tests only).
- `RunTransitionInput` (`state-gate.ts`) — `{ runId, to, reason?, errorCode?, broker?, workspaceId? }` input type; the executor passes the run row's workspace so split-DB runs transition on their own handle (XD-002 fixed). Approval decide paths (sweeper, REST, socket) funnel through `applyRunTransition` so every hop emits `run.status_changed` (XD-009 fixed; tool-executor waits stay direct with warn logging per XD-028).

## Relations
Gates called: `runsGate.transition` (Runs); `messageGate.append` (Messages); `getSharedBroker` (EventBroker, dynamic fallback only). Repair buffer is in-gate (no new dependency); `flushPendingStatusEvents` takes an optional `EventBroker` param (gate-to-gate callers pass one).
Known outside callers: Runtime `runtime-executor.ts` `walkTransitions` (sole executor path).

## Emits-Listens
- `run.status_changed` (emits, only on changed transitions; buffered and re-emitted by `flushPendingStatusEvents` after missing-broker / emit-throw gaps)

## Owns
- Nothing persisted (this domain owns the mutation ordering, Runs/Messages own the rows).

## Flags
- None (honors `RUNS_ENABLED=false` via `runsGate.transition` returning `null`).

## Decisions
- `[Observed]` Gate-to-gate only (`runs-gate`, `message-gate`, `event-broker-gate`); no direct repository imports, so the gate lint holds and no Runs↔State cycle exists (Runs never imports State).
- `[Observed]` Executor no longer emits `run.status_changed` itself; the gate is the single emission point for executor-driven transitions.

## User Decision:

## Architectural Standard (Target)
> Status: Target. New work must satisfy this.
All run-status writes from execution paths go through `stateGate.applyRunTransition`. Direct `runsGate.transition` + manual emit from executors is forbidden.
All message commits from execution paths go through `stateGate.applyMessage` (or `messageGate.append` where the gate alias is threaded). Ad-hoc message inserts past the gate are forbidden.

## Failure + Resume
- Illegal transition → `null` (executor treats rejected walks as fatal, refuses stale execution).
- Broker missing → transition still persists; the payload is buffered (latest-wins per run, cap 500) and repaired by `flushPendingStatusEvents()`; emit throw is swallowed (`console.error`) and buffered the same way. Never throws into execution.

## Gaps
- `runsGate.resumeRun` / `orphan-sweep` / approval/tool paths still emit via their own sites; converging every `run.status_changed` emitter onto this gate is future work.
- STATE-003 (fix-state-micro-002-003): `applyRunTransition` passes `errorCode` through unchanged (undefined = preserve stored code, null = explicit clear); pinned by `src/state/state-gate.test.ts`.
- STATE-002 (fix-state-micro-002-003, partial): header repaired and the gate-side emission contract pinned (exactly one `run.status_changed` per changed transition; silent reject/no-op; direct-writer bypass set locked to tool-executor (XD-028) + research-runtime); consolidating those writers is still future work.
- Docs drift noted: the Ports list above repeats `RunTransitionInput` three times (stacked external edits); dedupe pending a docs pass.
- STATE-005 (fix-state-micro-005-007): emit leg now has a repair buffer behind the gate — missing broker or emit throw buffers the latest payload per run (cap 500, latest-wins) and `stateGate.flushPendingStatusEvents()` re-emits; older gaps repair opportunistically on the next live emit (state-gate.ts:51-111). Durable repair across hard kills (sweep/outbox) remains open.
- STATE-007 (fix-state-micro-005-007): in-domain coverage expanded — shared-broker fallback, missing-broker warn+return, emit-throw swallow, and the STATE-005 repair path are pinned in `src/state/state-gate.test.ts` (12 tests).
