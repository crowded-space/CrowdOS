import { describe, it, expect } from 'vitest';
import { splitStreamBlocks } from './streaming-blocks';

describe('splitStreamBlocks', () => {
  it('returns empty pending for blank input', () => {
    expect(splitStreamBlocks('')).toEqual({ completed: [], pending: '', pendingIsCode: false });
    expect(splitStreamBlocks('   \n  ')).toEqual({ completed: [], pending: '', pendingIsCode: false });
  });

  it('splits prose on blank lines with the last block pending', () => {
    const out = splitStreamBlocks('First paragraph.\n\nSecond paragraph.');
    expect(out.completed).toEqual(['First paragraph.']);
    expect(out.pending).toBe('Second paragraph.');
    expect(out.pendingIsCode).toBe(false);
  });

  it('keeps completed blocks stable (prefix) as the stream grows', () => {
    const early = splitStreamBlocks('Para one.\n\nPara two st');
    const late = splitStreamBlocks('Para one.\n\nPara two still going.\n\nPara three.');
    // The no-remount contract: earlier completed blocks are a prefix of later ones.
    expect(late.completed.slice(0, early.completed.length)).toEqual(early.completed);
    expect(early.completed).toEqual(['Para one.']);
    expect(late.completed).toEqual(['Para one.', 'Para two still going.']);
    expect(late.pending).toBe('Para three.');
  });

  it('holds an unclosed fence in pending as plain code', () => {
    const out = splitStreamBlocks('Done intro.\n\n```ts\nconst x = 1;\nconst y = 2;');
    expect(out.completed).toEqual(['Done intro.']);
    expect(out.pendingIsCode).toBe(true);
    expect(out.pending.startsWith('```ts')).toBe(true);
  });

  it('completes a closed fence without splitting blank lines inside it', () => {
    const md = '```js\nconst a = 1;\n\nconst b = 2;\n```\n\nTrailing prose.';
    const out = splitStreamBlocks(md);
    expect(out.pendingIsCode).toBe(false);
    expect(out.pending).toBe('Trailing prose.');
    expect(out.completed).toHaveLength(1);
    expect(out.completed[0]).toContain('const a = 1;');
    expect(out.completed[0]).toContain('const b = 2;');
  });
});
