# Compensation undo flow
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
File mutations (`write_file`, `delete_file`, and the runtime's `edit_file`) are destructive — a run that overwrites or deletes the wrong path must leave behind enough to put it back. This flow exists so every risky file op journals its inverse before mutating, and an admin can later undo one journal row: Guard-checked, filesystem-applied, row-deleted.

## Architectural decision
The shape is two linked choices. First, the inverse is built and appended *before* the mutation, and journaling is best-effort (failures swallowed) so undo support never blocks the write itself `[Observed]` (`tool-registry.ts:234-241`). Second, undo executes the stored filesystem inverse under `Guard.validatePath` and deletes the journal row only on success — undo is itself destructive, so path-escape checks precede mutation and a failed undo keeps its row for retry `[Observed]` (`runs-service.ts:42-51`). The journal is ordered (`UNIQUE(run_id, seq)` with one retry on `23505`) and bounded (`restore` truncates prior content to 20k with a sha256), so it stays an ordered undo log without unbounded payload growth `[Observed]`.

## How it works
1. Before mutating, the caller snapshots the target: `write_file` records whether the file existed plus its prior content (`tool-registry.ts:234-240`); `delete_file` records the same before removal (`tool-registry.ts:315-323`); the coding runtime journals `write_file`/`edit_file` the same way (`coding-runtime.ts:221-222`, `coding-runtime.ts:323-324`).
2. The snapshot becomes an inverse via `buildCompensationInverse` — `delete` for new files, `restore` (sha256 + 20k-truncated prior) for existing ones (`runs-repository.ts:178-188`) — and is appended with `seq = max+1` via `addCompensation` (`runs-repository.ts:188-191`).
3. The mutation proceeds (and emits `sandbox:updated` on write/delete, `tool-registry.ts:247`, `tool-registry.ts:329`); the journal row now outlives the run that made it.
4. An admin undoes one row via `POST /api/runs/:id/compensations/:compId/undo` or `run:compensation:undo`, both reaching `undoCompensation` (`routes/runs.ts:79-80`, `register-socket-server.ts:963`, `runs-service.ts:42-51`).
5. `undoCompensation` resolves the workspace root (falling back to `process.cwd()/sandbox/default` when the workspace row is missing), then re-validates the stored path with `Guard.validatePath` (`runs-service.ts:67-84`).
6. The inverse is applied to the filesystem: `delete` unlinks (tolerating `ENOENT`), `restore` recreates parent dirs and writes back the prior content (`runs-service.ts:88-95`).
7. Only on success the journal row is deleted via `deleteCompensation` and a `run.compensations` emit follows (`runs-service.ts:96-100`); on missing row, Guard rejection, or fs error it returns `{ ok: false, error }` and the row stays (`runs-service.ts:42-51`).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Tools.md> | Owns the journaling call sites: builds the inverse and appends before every `write_file`/`delete_file` mutation |
| <../Domain Spec/Runs.md> | Owns the journal (`runs_compensation` rows, inverse builder, Guard-checked undo, row delete, emits) and the run rows the journal hangs off |
| <./Durable runs and checkpoints.md> | Owns the checkpoint side of run durability — see that doc, not duplicated here |

## Current state
Real: pre-mutation inverse journaling on the `write_file`/`delete_file` tool paths and the coding-runtime `write_file`/`edit_file` paths, ordered appends with unique-violation retry, Guard-checked undo with row-delete-on-success, `ENOENT`-tolerant delete inverse, parent-dir-recreating restore inverse. Admin-only undo surface on both REST and sockets. No flag gates this flow.

## Alignment notes
`none found` — sampled claims verified: write-path journaling (`tool-registry.ts:240-241`), delete-path journaling (`tool-registry.ts:322-323`), runtime journaling (`coding-runtime.ts:221-222`, `coding-runtime.ts:323-324`), inverse builder + ordered append (`runs-repository.ts:178-191`), Guard checks + fs inverses + row delete (`runs-service.ts:42-51`), route/socket undo entries (`routes/runs.ts:79-80`, `register-socket-server.ts:963`). No contradiction between the Runs/Tools domain docs and cited code on the sampled paths.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Write-path plus delete-path plus runtime journaling stays with inverse builder and ordered append.
* Guard checks precede fs inverses and row deletes only on success.
* Undo of large files has an explicit lossy-or-full contract with warning. Silent 20k truncation is forbidden.
* Journal scope plus ordering plus retention has one documented rule.
* Authority: Runs, Tools standards.
## Open gaps
- The coding runtime journals an `edit_file` toolName, but no `edit_file` definition is ever registered — whether those rows are reachable by any live tool call is unverified.
- `restore` inverses carry only the first 20k chars of prior content; undo of larger files is lossy and no warning or full-content path was observed.
- Undo workspace-root fallback (`process.cwd()/sandbox/default`) and multi-workspace correctness are unverified.
- Journal listing scope (per-run ordering vs cross-run history, retention/purge policy for never-undone rows) was not traced.
- Whether any consumer subscribes to `run.compensations` beyond socket fan-out was not traced.
