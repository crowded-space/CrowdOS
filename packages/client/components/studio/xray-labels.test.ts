import { describe, expect, it } from 'vitest';

import { xrayModelLabel } from './xray-labels';

// UI audit §2.10 (minor #12): the X-Ray "Provider" card rendered the raw
// provider type ("custom") while the model card showed the module name
// ("Minimax M3.1") — same profile, two labels. The card now resolves the
// same display name the model card shows.

const CATALOG = [
  { id: 'mod-1', name: 'Minimax M3.1' },
  { id: 'mod-2', name: 'Gemini Flash' },
];

describe('xrayModelLabel (UI audit §2.10 minor #12)', () => {
  it('shows the model module name instead of the raw provider type', () => {
    expect(xrayModelLabel('mod-1', CATALOG, { provider: 'custom', modelName: 'MiniMax-M3' })).toBe('Minimax M3.1');
  });

  it('falls back to the compiled model name when the catalog misses', () => {
    expect(xrayModelLabel('mod-x', CATALOG, { provider: 'custom', modelName: 'MiniMax-M3' })).toBe('MiniMax-M3');
  });

  it('falls back to the provider type and never renders empty', () => {
    expect(xrayModelLabel(null, CATALOG, { provider: 'custom' })).toBe('custom');
    expect(xrayModelLabel(null, undefined, undefined)).toBe('unknown');
    expect(xrayModelLabel('mod-1', [{ id: 'mod-1', name: '   ' }], { provider: 'custom' })).toBe('custom');
  });
});
