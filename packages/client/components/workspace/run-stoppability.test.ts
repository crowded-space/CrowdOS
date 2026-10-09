import { describe, expect, it } from 'vitest';
import { STOPPABLE_RUN_STATUSES, isStoppableRunStatus } from './run-stoppability';

// RUN-STOP-001: Stop's transport (socket user:cancel -> server register-socket-server.ts
// activeRuns) aborts only live in-process runs. The pinned RunHeader, the Jobs table,
// and the roster Stop buttons must gate on the run states that can legally transition
// to "cancelling" (run-state-machine.ts); a parked (resumable/orphaned) run has no
// controller, so a Stop there is a dead control (use Retry / POST /api/runs/:id/resume).

const LIVE_STOPPABLE_STATUSES = [
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
] as const;

const NOT_STOPPABLE_STATUSES = [
  'resumable',
  'orphaned',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
] as const;

describe('isStoppableRunStatus', () => {
  it('accepts every live run state that has a legal edge to cancelling', () => {
    for (const status of LIVE_STOPPABLE_STATUSES) {
      expect(isStoppableRunStatus(status)).toBe(true);
    }
    for (const status of STOPPABLE_RUN_STATUSES) {
      expect(isStoppableRunStatus(status)).toBe(true);
    }
  });

  it('rejects parked, terminal, and already-stopping states', () => {
    for (const status of NOT_STOPPABLE_STATUSES) {
      expect(isStoppableRunStatus(status)).toBe(false);
    }
  });

  it('matches case-insensitively: RESUMABLE is still parked, Running is still live', () => {
    expect(isStoppableRunStatus('RESUMABLE')).toBe(false);
    expect(isStoppableRunStatus('Running')).toBe(true);
    expect(isStoppableRunStatus('RUNNING')).toBe(true);
    expect(isStoppableRunStatus('Completed')).toBe(false);
  });

  it('rejects null, undefined, empty, and unknown statuses', () => {
    expect(isStoppableRunStatus(null)).toBe(false);
    expect(isStoppableRunStatus(undefined)).toBe(false);
    expect(isStoppableRunStatus('')).toBe(false);
    expect(isStoppableRunStatus('bogus')).toBe(false);
  });
});
