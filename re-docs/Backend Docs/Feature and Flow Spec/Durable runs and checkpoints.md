# Durable runs and checkpoints
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
Agent work must survive crashes without losing progress or silently redoing finished tool calls. Runs owns the durable row, the legal status transitions, the progress checkpoint, and the file-compensation journal — execution, delivery, and approval policy live elsewhere.

## Architectural decision
Every status write funnels through one choke point (`applyTransition`): re-read current status, validate against the pure state-machine map, then update with a `WHERE status = from` concurrency guard — illegal moves return `null`, same-state moves return idempotent `{ changed: false }`, terminals (`completed`/`failed`/`cancelled`) accept no outgoing edge [Observed]. Checkpoints merge atomically in-DB (monotonic watermark via `greatest()`, `completedCallIds` union-deduped in SQL) so parallel batch writers can't clobber each other and callers never read-modify-write [Observed]. Checkpoint failures warn-and-swallow: progress tracking is best-effort and must never fail the run [Observed]. Orphan handling is a two-hop `→ orphaned → resumable` walk that preserves the checkpoint for an explicit resume decision — never auto-retry, never silent drop [Inferred].

## How it works
`runsGate.create` inserts a `created` row (`RUNS_ENABLED=false` short-circuits to `null`). Runtime walks it `created → starting → running` one `stateGate.applyRunTransition` hop per call (sole mutator: validate → persist → emit, see <../Domain Spec/State.md>), touches a 15s heartbeat during execution, and after each tool call merges `{ watermarkSeq, completedCallIds }` via `touchCheckpoint` (numeric overload merges watermark only). Before risky file writes, callers append an inverse op (`delete` for new files, `restore` with sha256 + 20k-truncated prior for existing) to the `runs_compensation` journal with monotonic `seq`; admin undo applies the inverse under path-guard validation and deletes the journal row only on success. Close walks `completing → verifying → completed`, `cancelling → cancelled` (two-hop), or direct `→ failed`. Crash detection, the sweep-to-`resumable` walk, and the resume handoff (`resumable → queued` + checkpoint as data, delivery owned by Queue, re-execution owned by Runtime) are a recovery timeline — see <Recovery and resume.md>, not duplicated here.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Runs.md> | Owns run rows, the transition state machine, atomic checkpoint merges, the compensation journal + undo, and the orphan sweep |
| <../Domain Spec/Runtime.md> | Walks the lifecycle (open/heartbeat/checkpoint-touches/close) and skips `completedCallIds` on resume |
| <../Domain Spec/Queue.md> | Owns delivery of resumed runs after the `resumable → queued` handoff |
| <Recovery and resume.md> | Owns the crash → sweep → resume → skip run timeline built on this capability |

## Current state
Real: run CRUD, guarded transitions with concurrency guard and terminal immutability, atomic checkpoint merge + heartbeat, compensation journal with guarded undo, orphan sweep with self-heal, `resumable → queued` resume handoff. Flag-gated: whole domain (`RUNS_ENABLED=false` disables reads/writes). Stub: none.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Single choke point applyTransition with WHERE status equals from stays. Terminal immutability stays.
* Checkpoints stay atomic single-statement merges with monotonic watermark plus set-union dedupe. Callers never read-modify-write.
* Orphan path stays two-hop to orphaned to resumable. waiting_for_approval stays excluded from sweep candidacy. resumeRun stays resumable to queued single-use returning checkpoint. Authority: Runs standard.
## Open gaps
- `CreateRunInput.parentRunId` is accepted but the research child-run path bypasses the gate via direct repository import — whether parent linkage is frozen, legacy, or intended is unverified.
- `listRunsByStatus` and `deleteCompensation` exist in the repository but are not gate ports — filtered run-list queries have no public path.
- `RunStatus` (DB enum) vs `RunState` (machine type) are duplicate value sets with no compile-time equality check — drift would surface only at runtime.
- `checkpointSeq` mirror column's consumer (ordering vs display vs resume cutoff) was not found — possible legacy duplicate.
- `historyRef` (large-history offload for deep resume) is threaded through types but no loader was observed.
