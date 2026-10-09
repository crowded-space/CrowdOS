/**
 * Run states where Stop is a live control.
 *
 * Stop's transport (socket `user:cancel` -> server register-socket-server.ts
 * `activeRuns`) aborts only live in-process runs, so this set is exactly the
 * run states with a legal edge to `cancelling` in
 * packages/server/src/runs/run-state-machine.ts. Parked states
 * (`resumable`, `orphaned`) have no controller and no `cancelling` edge:
 * Stop there is a dead control (use Retry / POST /api/runs/:id/resume
 * instead). Terminal states are immutable, and `cancelling` is already
 * stopping.
 */
export const STOPPABLE_RUN_STATUSES: readonly string[] = [
  'created',
  'queued',
  'starting',
  'running',
  'waiting_for_tool',
  'waiting_for_approval',
  'retrying',
  'compacting',
  'completing',
  'verifying',
];

export function isStoppableRunStatus(status: string | null | undefined): boolean {
  if (typeof status !== 'string') return false;
  return STOPPABLE_RUN_STATUSES.includes(status.toLowerCase());
}
