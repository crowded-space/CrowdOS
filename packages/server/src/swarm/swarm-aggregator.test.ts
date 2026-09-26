import { describe, it, expect } from 'vitest';
import { aggregateSwarmOutputs } from './swarm-aggregator.js';
import type { SwarmTaskRow, SwarmWorkerResult } from './swarm-types.js';

function row(id: string, status: SwarmTaskRow['status'] = 'pending'): SwarmTaskRow {
  return {
    id,
    runId: 'run-1',
    dependsOn: [],
    assigneeTemplate: 'agent-1',
    status,
    outputRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('swarmAggregator honest partial', () => {
  it('merges completed outputs and dedupes', () => {
    const tasks = [row('task-1', 'completed'), row('task-2', 'completed')];
    const results = new Map<string, SwarmWorkerResult>([
      ['task-1', { taskId: 'task-1', status: 'completed', output: 'line A\nline B' }],
      ['task-2', { taskId: 'task-2', status: 'completed', output: 'line B\nline C' }],
    ]);
    const agg = aggregateSwarmOutputs(tasks, results);
    expect(agg.completedCount).toBe(2);
    expect(agg.totalCount).toBe(2);
    expect(agg.honestSummary).toMatch(/Completed 2\/2/);
    expect(agg.dedupeNotes.join(' ')).toMatch(/Deduped/);
    expect(agg.mergedContent).toContain('line A');
    expect(agg.mergedContent).toContain('line C');
  });

  it('reports partial honestly when one fails', () => {
    const tasks = [row('task-1', 'completed'), row('task-2', 'failed')];
    const results = new Map<string, SwarmWorkerResult>([
      ['task-1', { taskId: 'task-1', status: 'completed', output: 'ok' }],
      ['task-2', { taskId: 'task-2', status: 'failed', error: 'killed' }],
    ]);
    const agg = aggregateSwarmOutputs(tasks, results);
    expect(agg.completedCount).toBe(1);
    expect(agg.totalCount).toBe(2);
    expect(agg.honestSummary).toMatch(/Completed 1\/2/);
    expect(agg.failedTasks).toHaveLength(1);
    expect(agg.failedTasks[0].id).toBe('task-2');
    expect(agg.mergedContent).toContain('Completed 1/2');
    expect(agg.mergedContent).toContain('task-2 — failed');
    // no fabricated success
    expect(agg.mergedContent).not.toMatch(/task-2 — completed/);
  });

  it('handles all failed honestly', () => {
    const tasks = [row('task-1', 'failed'), row('task-2', 'failed')];
    const results = new Map<string, SwarmWorkerResult>([
      ['task-1', { taskId: 'task-1', status: 'failed', error: 'e1' }],
      ['task-2', { taskId: 'task-2', status: 'failed', error: 'e2' }],
    ]);
    const agg = aggregateSwarmOutputs(tasks, results);
    expect(agg.completedCount).toBe(0);
    expect(agg.honestSummary).toMatch(/Completed 0\/2/);
    expect(agg.mergedContent).toContain('Completed 0/2');
  });

  it('blocked rows land only in blockedTasks, never double-counted as failed', () => {
    const tasks = [row('task-1', 'completed'), row('task-2', 'blocked')];
    const results = new Map<string, SwarmWorkerResult>([
      ['task-1', { taskId: 'task-1', status: 'completed', output: 'ok' }],
      ['task-2', { taskId: 'task-2', status: 'failed', error: 'blocked: dependency failed (task-1)' }],
    ]);
    const agg = aggregateSwarmOutputs(tasks, results);
    expect(agg.blockedTasks).toHaveLength(1);
    expect(agg.blockedTasks[0].id).toBe('task-2');
    expect(agg.failedTasks).toHaveLength(0);
    expect(agg.completedCount).toBe(1);
  });
});
