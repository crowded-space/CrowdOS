# Coding loop
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
A coding request ends with changed files, not just changed words. This flow exists so one run opens a pi-core session over the workspace, edits files through compensated tool calls, records each change as a diff artifact, and closes with the work persisted and attributable — while clients watch file updates live.

## Architectural decision
The shape is two linked choices. First, the session owns the loop while the provider adapter owns the tokens: `CodingRuntime` builds a `PiModelAdapter` over the registered provider adapter and hands control to an `@crowdos/pi-core` `AgentSession`, so model swaps never touch session logic (`coding-runtime.ts:88`, `coding-runtime.ts:370`) `[Observed]`. Second, every mutation is journaled before it happens and snapshotted after: the handler builds a compensation inverse and appends it via `runsGate`, then writes the file and stores a `diff`/`file` artifact with `beforeHash/afterHash/patch` (`coding-runtime.ts:221`, `coding-runtime.ts:227`) `[Observed]` — undo support never blocks the write itself because journaling is best-effort `[Observed]`. File writes additionally emit `sandbox:updated` on the global broker so clients sync without polling (`coding-runtime.ts:243`) `[Observed]`.

## How it works
1. The executor adopts/opens the run, assembles context with `allowToolCalls`, and starts the 15s heartbeat; the coding runtime marks the agent working + thinking (`runtime-executor.ts:141`, `runtime-executor.ts:131-144`, `coding-runtime.ts:73`).
2. The runtime builds the `PiModelAdapter` closure that invokes the registered provider adapter (chunk callback + abort signal threaded through) and constructs the `AgentSession` with workspace tools and event bridges (`coding-runtime.ts:88`, `coding-runtime.ts:370`).
3. The session drives its own edit loop: each model-requested file operation routes through the pi-tool bridge into the same authorized tool surface (Guard path checks, approval pauses where policy requires).
4. Before every write/edit, the handler snapshots prior content, builds the inverse via `runsGate.buildCompensationInverse`, and appends it with `runsGate.addCompensation` (`coding-runtime.ts:221`, `coding-runtime.ts:323`).
5. The handler computes the patch (`diff.createTwoFilesPatch` when available, pi-core fallback, naive generator last) and applies the mutation (`coding-runtime.ts:37`, `coding-runtime.ts:217`, `coding-runtime.ts:319`).
6. After the mutation it creates the artifact — `type: diff` for edits, `diff` or `file` for writes — carrying `beforeHash/afterHash/patch/contentRef` (`coding-runtime.ts:227`, `coding-runtime.ts:360`).
7. Each write emits `sandbox:updated` with workspace + change type so mounted clients refresh (`coding-runtime.ts:243`).
8. The session ends; the runtime persists the final message, marks the agent idle, and returns `completed` (cancel maps to `cancelled`, session/bridge errors to a failed result that still closes the run) (`coding-runtime.ts:399`, `coding-runtime.ts:436`, `coding-runtime.ts:450`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Runtime.md> | Owns the coding flavor: session setup, provider-adapter bridge, status flips, final persist, and completed/failed/cancelled return |
| <../Domain Spec/Tools.md> | Owns the Guard/approval/timeout enforcement the bridged file and shell calls execute under |
| <../Domain Spec/Artifacts.md> | Owns `diff`/`file` artifact storage; the runtime only computes hashes/patches and calls `create` |
| <../Domain Spec/Runs.md> | Owns the compensation journal (`buildCompensationInverse`/`addCompensation`) the handler writes before each mutation |

Related: <./Runtime router and flavors.md> (how `coding|dev` tags route here), <./Provider adapters and streaming.md> (how the session's token stream is produced), <./Recovery and resume.md> (crash/resume interplay with an open session).

## Current state
Real: pi-core session over the live provider adapter, pre-write compensation journaling, three-tier patch builder, `diff`/`file` artifact creates, `sandbox:updated` emits, idle reset on all exits. Best-effort by design: compensation appends, artifact creates, and session events never fail the write itself — they warn and continue. No flag gates this loop beyond the provider keys it rides on.

## Alignment notes
`none found`

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Edit to artifact path stays with patch and diff plus sandbox emits.
* Run and test verification after edits has an explicit owner, tool path, and verified definition.
* Abort, lease, heartbeat, and orphan-sweep interplay has one documented contract.
* Resume semantics are explicit: replay, checkpoint-skip, or replan. Manual-only compensation without a contract is forbidden.
* Authority: Runtime, Tools, Artifacts, Runs standards.
## Open gaps
- Run/test verification after edits (whether the session executes tests, through which tool, and what counts as "verified") was not traced — the edit→artifact path is verified, the verify step is not.
- `AgentSession` abort/lease interplay (pi-core loop vs 15s heartbeat vs orphan sweep for long sessions) was not traced end to end.
- `sandbox:updated` ownership between coding emits and Tools file-tool emits was not exhaustively reconciled — double-emit vs single-feed is unverified.
- Resume semantics for an interrupted session (replay edits vs skip via checkpoint vs replan) are unverified; compensation undo is manual only.
