import { describe, it, expect } from 'vitest';
import { parsePlanJson, buildFallbackLinearPlan } from './swarmPlanner.js';
import type { ContextPacket } from '../runtime/types.js';

describe('swarmPlanner parse and fallback', () => {
  it('parses valid JSON plan with dependsOn and assigneeTemplate', () => {
    const content = JSON.stringify({
      tasks: [
        { id: 'task-1', dependsOn: [], assigneeTemplate: 'agent-1', goal: 'a' },
        { id: 'task-2', dependsOn: ['task-1'], assigneeTemplate: 'agent-1', goal: 'b' },
      ],
    });
    const plan = parsePlanJson(content);
    expect(plan).not.toBeNull();
    expect(plan!.tasks).toHaveLength(2);
    expect(plan!.tasks[1].dependsOn).toContain('task-1');
  });

  it('parses fenced json block', () => {
    const content = '```json\n' + JSON.stringify({ tasks: [{ id: 'task-1', dependsOn: [], assigneeTemplate: 'a' }] }) + '\n```';
    const plan = parsePlanJson(content);
    expect(plan).not.toBeNull();
    expect(plan!.tasks[0].id).toBe('task-1');
  });

  it('rejects invalid DAG (missing dependency)', () => {
    const content = JSON.stringify({ tasks: [{ id: 'task-1', dependsOn: ['missing'], assigneeTemplate: 'a' }] });
    expect(parsePlanJson(content)).toBeNull();
  });

  it('rejects cycle', () => {
    const content = JSON.stringify({
      tasks: [
        { id: 'task-1', dependsOn: ['task-2'], assigneeTemplate: 'a' },
        { id: 'task-2', dependsOn: ['task-1'], assigneeTemplate: 'a' },
      ],
    });
    expect(parsePlanJson(content)).toBeNull();
  });

  it('fallback linear plan is honest two-task chain', () => {
    const packet = {
      agentId: 'agent-1',
      userInput: 'Test goal for fallback plan',
      systemPrompt: 'sys',
    } as unknown as ContextPacket;
    const fallback = buildFallbackLinearPlan(packet, 'llm down');
    expect(fallback.fallbackUsed).toBe(true);
    expect(fallback.tasks).toHaveLength(2);
    expect(fallback.tasks[0].id).toBe('task-1');
    expect(fallback.tasks[1].dependsOn).toContain('task-1');
    expect(fallback.fallbackReason).toContain('llm down');
  });

  it('planner fallback not mocked (no banned strings)', () => {
    const packet = { agentId: 'a', userInput: 'goal', systemPrompt: 's' } as unknown as ContextPacket;
    const fallback = buildFallbackLinearPlan(packet, 'x');
    const text = JSON.stringify(fallback);
    expect(text).not.toContain('Task Output for');
    expect(text).not.toContain('runTask');
  });
});
