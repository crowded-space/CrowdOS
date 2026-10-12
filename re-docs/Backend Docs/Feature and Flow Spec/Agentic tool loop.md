# Agentic tool loop
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
Some answers need actions, not words — file reads, shell commands, searches, delegations. This flow exists so the model can request a batch of tool calls per turn, have each one authorized and executed exactly once, see the clamped results back in history, and loop until it calls `agent_complete` or runs out of iterations.

## Architectural decision
The shape is three linked choices. First, the loop owns ordering while Tools owns execution: the runtime snapshots history, calls `toolsGate.executeBatch`, and appends results in call order, never reordering for concurrency `[Observed]` — reads may run concurrently but results always land in request order (`agentic-runtime.ts:174`, `tool-executor.ts:230-236`) `[Observed]`. Second, every call checkpoints itself: after each tool result the loop touches `(watermarkSeq, completedCallIds)` in one atomic in-DB merge, so a crash resumes by skipping ids, not replaying them (`agentic-runtime.ts:252`, `runs-repository.ts:114`) `[Observed]`. Third, risky calls pause instead of failing: an `ASK` verdict walks the run to `waiting_for_approval` and waits event-plus-poll, resuming to `running` on settle so deny/expiry fails only the tool, never the run (`tool-executor.ts:468`, `tool-executor.ts:498-507`) `[Observed]`. The rejected alternative is executing tools inline in the runtime — it would bypass the skill allowlist, authority checks, and approval records, so all execution funnels through the Tools gate `[Inferred]`.

## How it works
1. The run is already `running` with a heartbeat; the agentic loop marks the agent working + thinking and snapshots history for this iteration (`agentic-runtime.ts:35`, `runtime-kernel.ts:238`).
2. Per iteration (max `policies.maxIterations`): abort-check, then `enforcePerIterationBudget` re-clamps the prompt (preview dropped after iteration 1 unless `PER_ITERATION_BUDGET=false`) (`agentic-runtime.ts:67`).
3. `callLLM` streams the turn through the coalescer; usage accumulates and thoughts persist as internal messages with a fire-and-forget reflection note (`agentic-runtime.ts:107`, `runtime-kernel.ts:75`).
4. An `agent_complete` native call breaks the loop with its `response` as the final answer — no tools run that turn (`agentic-runtime.ts:107`).
5. Otherwise executable calls fan out through `toolsGate.executeBatch`, which classifies read vs write (unknown names default `write`/serial) and runs early reads bounded-parallel then the serial tail, ordered results always (`agentic-runtime.ts:174`, `tool-executor.ts:230-236`).
6. Each call may pause: bash `ASK` (or FS policy miss) checks a reusable grant, else creates a `pending` approval, walks `running → waiting_for_approval`, emits `approval.requested`, and waits broker-event fast path + 1s→5s poll under a TTL+2.5s ceiling (`tool-executor.ts:415`, `tool-executor.ts:468`, `tool-executor.ts:316`).
7. On settle the run walks back `waiting_for_approval → running`; approved executes, denied/expired fails only that tool default-deny (`tool-executor.ts:540-545`).
8. Per call the loop emits `tool:start`/`tool:complete`, persists the clamped (8000-char) tool result as an internal message with its structured record, touches the checkpoint with the call id, and appends a `tool` history entry (`agentic-runtime.ts:140`, `agentic-runtime.ts:232`, `agentic-runtime.ts:252`).
9. Resume-skipped ids short-circuit in call order with a `[resumed]` marker instead of executing (`agentic-runtime.ts:28`, `agentic-runtime.ts:161`).
10. When the loop breaks or aborts, the final visible message persists, the agent goes idle, and the normal close walk (`completed`/`cancelled`) retires the run (`agentic-runtime.ts:278`, `runtime-executor.ts:206-229`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Runtime.md> | Owns the loop: budget re-check, `callLLM`, `agent_complete` break, result clamping/persist, per-call checkpoint touches, resume skip |
| <../Domain Spec/Tools.md> | Owns authorization, Guard classification, batched execution, timeout/abort race, and the approval-pause wait |
| <../Domain Spec/Runs.md> | Owns the run machine (`running ↔ waiting_for_approval` edges) and the atomic checkpoint merge the loop calls into |

Related: <./Runtime router and flavors.md> (how the agentic flavor is selected), <./Provider adapters and streaming.md> (how each turn's LLM call streams), <./Approval lifecycle.md> (approval pause/wait/settle internals — not duplicated here), <./Recovery and resume.md> (how the checkpoint skip resumes a crashed loop), <./Durable runs and checkpoints.md> (checkpoint/heartbeat durability).

## Current state
Real: iteration cap with per-iteration budget re-check, ordered batch execution with read/write split, 8k output clamp, per-call checkpoint touches, resume skip with `[resumed]` markers, and the full approval pause/wait/resume cycle. Flag-gated: per-iteration budget (`PER_ITERATION_BUDGET=false` disables the re-check), batch scheduler shape (`TOOL_RWP=false` restores legacy scheduling). Stub: none in this loop.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view of Runtime, Tools, Runs, Approvals standards. Authority stays in those domain specs; this section does not duplicate rules.
* Loop owns ordering, Tools owns execution via toolsGate.executeBatch. Inline execution bypassing skill allowlist, authority checks, and approval records is forbidden.
* Every call checkpoints via atomic in-DB merge of watermarkSeq plus completedCallIds. Crash resumes by skipping ids, never replaying them.
* Risky calls pause to waiting_for_approval and wait event-plus-poll with hard TTL-plus-guard ceiling. Deny or expiry fails only the tool default-deny, never the run.
* Results stay in request order regardless of read and write concurrency. Tool output fed back into history stays clamped with full blob persisted.
* maxIterations provenance plus exhaustion behavior plus waiting_for_tool visibility plus memoryCandidates production must be documented or removed.
## Open gaps
- `maxIterations` provenance (which policy sets it per agent/flavor and what happens on exhaustion — truncated reply vs failure) was not traced to a single setter.
- Whether `waiting_for_tool` is walked anywhere in this loop vs only the approval edge was not confirmed — mid-batch status visibility is unverified.
- Clamped 8k history output vs full persisted message: whether any retry path re-reads the full blob instead of the clamp is unverified.
- `memoryCandidates` on the loop result has no observed producer — whether the loop should populate it is unverified.
