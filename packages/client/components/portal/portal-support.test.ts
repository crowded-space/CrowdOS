import { describe, expect, it } from 'vitest';

import {
  filterWorkspaces,
  maskDatabaseUrl,
  relativeTime,
  sortWorkspacesByRecency,
  truncateMiddle,
  validateWorkspaceName,
} from './portal-support';

describe('validateWorkspaceName', () => {
  it('rejects empty names', () => {
    expect(validateWorkspaceName('   ', [])).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects duplicates case-insensitively', () => {
    expect(validateWorkspaceName('Research', ['research'])).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('rejects folder-illegal characters', () => {
    expect(validateWorkspaceName('bad/name', []).ok).toBe(false);
  });

  it('accepts a clean name', () => {
    expect(validateWorkspaceName('Swarm Research Core', ['Other'])).toEqual({ ok: true });
  });
});

describe('maskDatabaseUrl', () => {
  it('redacts credentials', () => {
    expect(maskDatabaseUrl('postgresql://user:secret@host:5432/db')).not.toContain('secret');
  });
});

describe('filterWorkspaces', () => {
  it('filters by name substring', () => {
    const list = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ];
    expect(filterWorkspaces(list, 'alp')).toHaveLength(1);
    expect(filterWorkspaces(list, '')).toHaveLength(2);
  });
});

describe('sortWorkspacesByRecency', () => {
  it('puts recently opened first', () => {
    const list = [
      { id: 'a' },
      { id: 'b' },
    ];
    expect(sortWorkspacesByRecency(list, { a: 10, b: 20 })[0].id).toBe('b');
  });
});

describe('relativeTime', () => {
  it('labels missing as never opened', () => {
    expect(relativeTime(null)).toBe('Never opened');
  });
});

describe('truncateMiddle', () => {
  it('keeps short values whole', () => {
    expect(truncateMiddle('short', 48)).toBe('short');
  });

  it('truncates long values in the middle', () => {
    const long = 'a'.repeat(60);
    const out = truncateMiddle(long, 48);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('\u2026');
  });
});
