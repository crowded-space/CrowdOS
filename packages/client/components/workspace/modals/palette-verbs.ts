import { useCrowdOSStore } from '@/stores/crowdOsStore';
import type { ApprovalRequest } from '@/stores/crowdOsStore';
import { useScreenLockStore } from '@/stores/screenLockStore';
import type { jobRow } from '@/stores/crowdOsStore';
import type { ComposerMode } from '@/types/crowdOs';

export type paletteScope = 'channel' | 'workspace' | 'run' | 'global';
export type paletteRisk = 'safe' | 'confirm' | 'destructive';

export interface paletteVerb {
  id: string;
  title: string;
  shortcut?: string;
  scope: paletteScope;
  risk: paletteRisk;
  run: () => void | Promise<void>;
}

/** Subsequence fuzzy scorer: query chars in order inside target. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  let qi = 0;
  let score = 0;
  let last = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += last === i - 1 ? 2 : 1;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

const RECENT_KEY = 'crowdos_palette_recent';
const RECENT_CAP = 10;

export function loadRecentVerbs(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string').slice(0, RECENT_CAP) : [];
  } catch { return []; }
}

export function recordVerbUse(id: string): void {
  try {
    const next = [id, ...loadRecentVerbs().filter(v => v !== id)].slice(0, RECENT_CAP);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* best-effort */ }
}

export function filterVerbs(query: string, verbs: paletteVerb[]): paletteVerb[] {
  const recent = loadRecentVerbs();
  const scored = verbs
    .map(v => ({ v, s: fuzzyScore(query, v.id + ' ' + v.title) }))
    .filter(e => e.s >= 0)
    .sort((a, b) => {
      const ra = recent.indexOf(a.v.id);
      const rb = recent.indexOf(b.v.id);
      if ((ra === -1) !== (rb === -1)) return ra === -1 ? 1 : -1;
      if (ra !== -1 && rb !== -1 && ra !== rb) return ra - rb;
      return b.s - a.s;
    });
  return scored.map(e => e.v);
}

/**
 * The 16 palette verbs (14 switch/admin + 2 Phase G capture). Every run() calls a REAL store action verified
 * against the codebase; nothing is stubbed. Capture verbs summon QuickAsk
 * via the crowdos:quick-ask-open window event App.tsx listens for (the
 * registry owns no React state); ask-l0-in-place falls back to the roster
 * panel when no L0 agent exists. Mute toggles the
 * crowdos_muted_channels localStorage map (the same source
 * isChannelMuted reads); lock calls the screenLock store.
 */
export function buildVerbs(): paletteVerb[] {
  const s = () => useCrowdOSStore.getState();
  return [
    { id: 'switch-channel', title: 'Switch channel', scope: 'channel', risk: 'safe', run: () => { const st = s(); const ws = st.workspaces.find(w => w.id === st.activeWorkspaceId); const all = [...(ws?.channels || []), ...(ws?.categories.flatMap(c => c.channels) || [])]; const next = all.find(c => c.id !== st.activeChannelId) || all[0]; if (next) void st.setActiveChannel(next.id); } },
    { id: 'switch-workspace', title: 'Switch workspace', scope: 'workspace', risk: 'safe', run: () => { const st = s(); const next = st.workspaces.find(w => w.id !== st.activeWorkspaceId) || st.workspaces[0]; if (next) void st.enterWorkspace(next.id); } },
    { id: 'set-runtime', title: 'Set runtime (cycle mode)', scope: 'channel', risk: 'safe', run: () => { const st = s(); const order: ComposerMode[] = ['auto', 'chat', 'agentic', 'coding', 'research', 'swarm']; const next = order[(order.indexOf(st.selectedMode) + 1) % order.length]; st.setMode(next, st.activeChannelId || undefined); } },
    { id: 'pin-runtime', title: 'Pin / unpin runtime', scope: 'channel', risk: 'safe', run: () => { s().togglePin(); } },
    { id: 'mute-channel', title: 'Mute / unmute channel', scope: 'channel', risk: 'safe', run: () => { const st = s(); const id = st.activeChannelId; if (!id) return; try { const raw = localStorage.getItem('crowdos_muted_channels'); const map = raw ? JSON.parse(raw) as Record<string, boolean> : {}; if (map[id]) delete map[id]; else map[id] = true; localStorage.setItem('crowdos_muted_channels', JSON.stringify(map)); } catch { /* best-effort */ } } },
    { id: 'clear-history', title: 'Clear channel history', scope: 'channel', risk: 'destructive', run: () => { const st = s(); if (st.activeChannelId) st.clearChannelMessages(st.activeChannelId); } },
    { id: 'mount-folder', title: 'Mount folder (open repo panel)', scope: 'channel', risk: 'safe', run: () => { s().setRightPanelView('repo'); } },
    { id: 'open-diff', title: 'Open diff (repo panel)', scope: 'channel', risk: 'safe', run: () => { s().setRightPanelView('repo'); } },
    { id: 'approve-first', title: 'Approve first pending', scope: 'channel', risk: 'confirm', run: async () => { const st = s(); const req = st.approvalRequests.find(r => r.status === 'pending' && (!r.channelId || r.channelId === st.activeChannelId)); if (req) await st.decideApproval(req.id, 'approved'); } },
    { id: 'deny-first', title: 'Deny first pending', scope: 'channel', risk: 'confirm', run: async () => { const st = s(); const req = st.approvalRequests.find(r => r.status === 'pending' && (!r.channelId || r.channelId === st.activeChannelId)); if (req) await st.decideApproval(req.id, 'denied'); } },
    { id: 'retry-run', title: 'Retry latest run', scope: 'channel', risk: 'confirm', run: async () => { const st = s(); const ids = Object.keys(st.jobsByRun); const latest = ids.sort((a, b) => (st.jobsByRun[a].updatedAt < st.jobsByRun[b].updatedAt ? 1 : -1))[0]; if (latest) await st.retryRun(latest); } },
    { id: 'cancel-run', title: 'Cancel active run', scope: 'run', risk: 'confirm', run: () => { const st = s(); if (st.activeChannelId) st.cancelRun(st.activeChannelId); } },
    { id: 'open-inbox', title: 'Open inbox (jobs view)', scope: 'global', risk: 'safe', run: () => { s().setRightPanelView('jobs'); } },
    { id: 'lock-screen', title: 'Lock screen now', scope: 'global', risk: 'safe', run: () => { useScreenLockStore.getState().lock(); } },
    { id: 'open-quick-ask', title: 'Open quick ask', shortcut: 'Ctrl/⌘+Shift+K', scope: 'global', risk: 'safe', run: () => { window.dispatchEvent(new CustomEvent('crowdos:quick-ask-open')); } },
    { id: 'ask-l0-in-place', title: 'Ask L0 in place', scope: 'channel', risk: 'safe', run: () => { const st = s(); const l0 = st.agents.find((a) => a.level === 0); if (!st.activeChannelId) return; if (l0) { window.dispatchEvent(new CustomEvent('crowdos:quick-ask-open')); } else { st.setRightPanelView('roster'); } } },
  ];
}
