import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

// JobsView reads the store through useCrowdOSStore(useShallow(...)). Under
// SSR (renderToString) zustand v5 serves getInitialState() as the server
// snapshot, so a setState-seeded real store would render empty; the test
// therefore binds the component to a plain seeded store module — the
// component under test and its wiring are unchanged.
const seed = vi.hoisted(() => ({
  jobsByRun: {
    'run-1': {
      runId: 'run-1',
      channelId: 'ch-1',
      agentIds: ['agent-1'],
      runtime: 'agentic',
      step: '2/5',
      elapsedMs: 65000,
      tokens: 1234,
      cost: 0.002,
      status: 'resumable',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:05.000Z',
    },
  } as Record<string, any>,
  agents: [{ id: 'agent-1', name: 'Ridder' }],
  workspaces: [{
    id: 'ws-1',
    name: 'WS',
    icon: '💼',
    categories: [],
    channels: [{ id: 'ch-1', name: 'general' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  }],
  activeChannelId: 'ch-1',
  cancellingByAgent: {} as Record<string, unknown>,
  stopRun: vi.fn(),
  retryRun: vi.fn(() => Promise.resolve()),
  fetchArtifacts: vi.fn(),
  setActiveChannel: vi.fn(),
}));

vi.mock('../../stores/crowdOsStore', () => ({
  useCrowdOSStore: (selector: (s: typeof seed) => unknown) => selector(seed),
}));

import JobsView from './JobsView';

// UI audit §2.11 (major #10): the jobs panel was a 9-column table with
// min-w-[560px] inside a 260px panel — unreadable by default with raw
// UUID fallbacks — plus a literal "resumable · resumable" status badge
// duplication and a "No Pause: the server exposes no pause endpoint…"
// dev-speak footer. The fix renders stacked job cards (same fields, same
// actions) at panel width, shows the status once, and rewords the footer
// in user language.

beforeEach(() => {
  seed.stopRun.mockClear();
  seed.retryRun.mockClear();
  seed.fetchArtifacts.mockClear();
  seed.setActiveChannel.mockClear();
});

function renderJobs(): string {
  // React SSR separates adjacent text interpolations with <!-- --> comment
  // markers (e.g. "Step <!-- -->2/5"); strip them so substring assertions
  // see the rendered text the user reads.
  return renderToString(<JobsView />).replace(/<!-- -->/g, '');
}

describe('JobsView readability (UI audit §2.11)', () => {
  it('renders stacked job cards instead of a min-width table', () => {
    const html = renderJobs();
    expect(html).toContain('<li');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('min-w-[560px]');
  });

  it('shows the resumable status exactly once (no duplicated suffix)', () => {
    const html = renderJobs();
    expect(html).not.toContain('resumable · resumable');
    expect(html).toMatch(/>resumable<\/span>/);
  });

  it('rewords the run-action footer in user language (no dev-speak)', () => {
    const html = renderJobs();
    expect(html).not.toContain('No Pause');
    expect(html).toContain('Stop and Retry are the only run actions');
    expect(html).toContain('pause is not supported');
  });

  it('keeps every field and action the table used to carry', () => {
    const html = renderJobs();
    expect(html).toContain('#general');
    expect(html).toContain('Ridder');
    expect(html).toContain('agentic');
    expect(html).toContain('Step 2/5');
    expect(html).toContain('1m 5s');
    expect(html).toContain('1,234 tok');
    expect(html).toContain('$0.0020');
    for (const label of ['Stop run run-1', 'Retry run run-1', 'Jump to channel for run run-1', 'Open diffs for run run-1', 'Open logs for run run-1']) {
      expect(html).toContain(label);
    }
  });
});
