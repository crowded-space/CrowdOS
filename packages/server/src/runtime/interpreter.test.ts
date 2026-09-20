import { describe, it, expect } from 'vitest';
import { interpret } from './interpreter.js';

describe('Interpreter (§24: stabilize, never plan)', () => {
  it('extracts raw @-targets in send order, deduped', () => {
    const out = interpret({ content: '@Raven @Owl please review, @Raven again' });
    expect(out.targets).toEqual(['Raven', 'Owl']);
    expect(out.executionHints).toContain('multi-target');
    expect(out.ambiguous).toBe(false);
  });

  it('stabilizes explicit runtime instead of deciding', () => {
    const out = interpret({ content: 'hello', explicitRuntime: 'coding' });
    expect(out.mode).toBe('coding');
    expect(out.targets).toEqual([]);
  });

  it('normalizes conversational to chat (§6 UI mode)', () => {
    expect(interpret({ content: 'hi', explicitRuntime: 'conversational' }).mode).toBe('chat');
  });

  it('falls back to lexical hints when Auto', () => {
    expect(interpret({ content: 'please debug this stack trace' }).mode).toBe('coding');
    expect(interpret({ content: 'survey the literature and cite sources' }).mode).toBe('research');
  });

  it('flags lock_in requests as execution hints', () => {
    const out = interpret({ content: '@Raven lock_in and focus' });
    expect(out.executionHints).toContain('lock_in-requested');
  });

  it('marks bare input ambiguous and lists the refused assumption', () => {
    const out = interpret({ content: 'hello there' });
    expect(out.mode).toBe('auto');
    expect(out.ambiguous).toBe(true);
    expect(out.assumptions).toHaveLength(1);
  });

  it('never throws on empty input and never plans', () => {
    const out = interpret({ content: '' });
    expect(out.targets).toEqual([]);
    expect(out.executionHints).toEqual([]);
    expect(out.ambiguous).toBe(true);
    expect(out).not.toHaveProperty('plan');
    expect(out).not.toHaveProperty('tools');
  });
});
