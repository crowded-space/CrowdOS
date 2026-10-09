# State Domain - Phase 2 Contract Matrix (read-only audit, 2026-10-06)

One row per facade method. "Result" is the as-implemented contract. All error paths are return-based; the gate itself never throws for business rejection.

| # | Method | Inputs | Preconditions / validation | Success result | Error result | Auth / tenant | Idempotency | Txn / concurrency | Side effects & ordering | Events | Observability | Perf / compat notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | applyRunTransition (state-gate.ts:23) | RunTransitionInput { runId, to: RunStatus, reason?, errorCode?, broker?, workspaceId? } | None in the gate. Callee enforces: row exists, edge legal per run-state-machine, RUNS_ENABLED !== false | TransitionResult { row, from, to, changed: true } after persist; run.status_changed emitted once when changed | null (missing row / illegal edge / terminal immutability / CAS lost twice / disabled) - returned as-is, no throw | None in the gate; workspaceId is now threaded through (external XD-002) - the executor supplies the fetched row's id; no other gate caller exists | Same-state call returns { changed: false } and emits nothing; re-emitting after a crash between persist and emit is NOT reconciled (STATE-005) | Persist-then-emit, NOT atomic; emit wrapped in try/catch so an emit failure never fails the caller | runs.status + runs.updatedAt write via runsGate; errorCode normalization at :28 (see #3) | run.status_changed { runId, agentId, channelId, workspaceId, runtimeType, status, from, reason, errorCode } with { channelId } room tag; dropped with console.warn when no broker | console.warn on missing broker (:36); console.error on emit throw (:54); callee warns on CAS conflict | 2-4 RTT for the transition + 1 emit; payload duplicated 3x across emitters (STATE-006) |
| 2 | applyMessage (state-gate.ts:59) | AppendMessageInput, AppendMessageOpts { broker?, db?, tx? } | None in the gate; callee validates nothing either (Messages MSG-012) | messages row (local commit) + message:new when opts.broker passed | Throws only if the local commit path throws (propagated from messageGate.append) | None; workspace resolved by channel row inside Messages | No dedupe in local store (Messages MSG-005) | Callee: local commit point -> replica -> outbox; not this gate's concern | Identical to messageGate.append; the gate adds nothing (comment :60-61 admits passthrough) | message:new (via messageGate) only when broker threaded; zero callers today | none added | Zero callers; dead port kept for the "one entry point per entity type" story (STATE-004) |
| 3 | errorCode passthrough (state-gate.ts:28) | input.errorCode?: string \| null | - | undefined -> runsGate.transition receives null -> runs-repository writes errorCode: null (clears stored code, RUN-001 semantics reversed at this boundary) | n/a | n/a | n/a | n/a | A reason-only hop through this gate CLEARS a stored failure code because the gate normalizes undefined to null | - | - | Divergence from runs-repository's sticky contract (undefined = preserve); confirmed by RUN-001 test expectations vs gate code |
| 4 | broker fallback (state-gate.ts:34-38) | input.broker omitted/null | - | Uses getSharedBroker() (dynamic import) | No broker -> transition still persists; emit dropped with console.warn | - | - | - | Worker process has a worker-local broker (worker.ts:48); if the gate runs before registration the event is dropped forever (STATE-005) | run.status_changed may silently not emit | console.warn only | Dynamic import per call on the fallback path (negligible; only when broker omitted) |

## Cross-cutting contract notes

1. Emission ownership: the gate owns emission ONLY for executor-driven walks. 17 direct runsGate.transition sites (tool-executor, approval-sweeper, routes/approvals, socket approval resume, research-runtime) persist without run.status_changed (STATE-002).
2. Payload shape: run.status_changed payload keys are identical in state-gate.ts:39-51, runs-service.ts:23-37, orphan-sweep.ts:46-57 - three hand-rolled copies of one wire contract (STATE-006); EventBrokerMap pins the type but nothing pins the copies together.
3. Persist-then-emit has no compensation: a crash (or broker outage) between the runs write and the emit loses the event with no replay path; the event log (eventsGate.recordDetached) records only what was emitted (STATE-005).
4. Changed=false: callers must treat { changed: false } as success-already-there; the gate returns it untouched and emits nothing.
5. Return type: applyRunTransition's inferred return is Promise<TransitionResult | null>; applyMessage mirrors messageGate.append's row type. No explicit return annotations (kebab-case / thin-gate rules hold: no logic beyond the emit wiring).
6. Compat surface to preserve: RunTransitionInput field names/optionality, stateGate object keys, run.status_changed payload keys + { channelId } tag, return-null-on-rejection semantics, no-throw-on-emit-failure.

## Transport contract (as implemented, indirect)

| Path | Gate call | Notes |
| --- | --- | --- |
| Socket user:message -> executeRun -> runtimeGate.execute | via RuntimeExecutor walkTransitions only | broker passed explicitly from socket server |
| BullMQ run job (queue/run-worker.ts:93) | via RuntimeExecutor walkTransitions | worker-local shared broker |
| Inline/API execute | via RuntimeExecutor walkTransitions | API shared broker (set in create-app.ts:356) |
| Resume (routes/runs.ts:9, socket :982) | NOT this gate | runs-service.resumeRun emits itself |
| Approval decisions (routes/approvals.ts:79, socket :1160, sweeper :41) | NOT this gate | direct transition, no event |
| Research child runs (research-runtime.ts:404-456) | NOT this gate | direct transitions, no events |
