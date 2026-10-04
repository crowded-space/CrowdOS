/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Desktop deep-link handling (P3a, additive only).
// The hash router in App.tsx stays the source of truth for web;
// this module only parses `crowdos://` / hash URLs forwarded by the
// Electron preload bridge (`crowdos:deep-link` with `{ url }` payload)
// and applies them through the same visibility checks as handlePopState.

/** Right-panel target a deep-link can request. `inbox` renders in the
 * jobs branch (OperationsInbox above JobsView), so apply maps it to
 * `jobs`; the parsed value keeps `inbox` so callers stay honest. */
export type deepLinkView = 'jobs' | 'inbox' | 'telemetry';

export interface DeepLinkParsed {
  workspaceId?: string;
  channelId?: string;
  runId?: string;
  inboxId?: string;
  view?: deepLinkView;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

function decodeId(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseHashBody(hash: string): DeepLinkParsed | null {
  // hash includes leading '#', e.g. "#/ws/ch", "#ws/ch", "#ch", "#/ch"
  let body = hash.startsWith('#') ? hash.slice(1) : hash;
  body = body.trim();
  if (body.startsWith('/')) body = body.slice(1);
  // drop query/fragment suffixes
  const qIdx = body.indexOf('?');
  if (qIdx !== -1) body = body.slice(0, qIdx);
  body = body.trim().replace(/^\/+|\/+$/g, '');
  if (!body) return null;
  // support #channel=ch-xxx form (mirrors store getHashChannelId)
  if (body.includes('channel=')) {
    const m = body.match(/channel=([^&/]+)/);
    if (m && m[1]) return { channelId: decodeId(m[1]) };
    return null;
  }
  // Phase D: run/inbox/view targets (additive; channel shapes above unchanged).
  // #run=<id> -> { runId }; #inbox=<id> -> { inboxId, view: 'inbox' };
  // #view=jobs|inbox|telemetry -> { view }.
  if (body.includes('run=')) {
    const m = body.match(/run=([^&/]+)/);
    if (m && m[1]) return { runId: decodeId(m[1]) };
    return null;
  }
  if (body.includes('inbox=')) {
    const m = body.match(/inbox=([^&/]+)/);
    if (m && m[1]) return { inboxId: decodeId(m[1]), view: 'inbox' };
    return null;
  }
  if (body.includes('view=')) {
    const m = body.match(/view=([^&/]+)/);
    if (m && m[1]) {
      const v = decodeId(m[1]).toLowerCase();
      if (v === 'jobs' || v === 'inbox' || v === 'telemetry') return { view: v };
    }
    return null;
  }
  const parts = body.split('/').map((p) => decodeId(p.trim())).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { channelId: parts[0] };
  return { workspaceId: parts[0], channelId: parts[parts.length - 1] };
}

function parseCrowdosScheme(url: string): DeepLinkParsed | null {
  // url is trimmed/unquoted and starts with crowdos:// (case-insensitive)
  const schemeLen = 'crowdos://'.length;
  let rest = url.slice(schemeLen);
  // drop query/fragment suffixes
  const cut = rest.search(/[?#]/);
  if (cut !== -1) rest = rest.slice(0, cut);
  rest = rest.trim().replace(/^\/+|\/+$/g, '');
  if (!rest) return null;
  const parts = rest.split('/').map((p) => decodeId(p.trim())).filter(Boolean);
  if (parts.length === 0) return null;
  const head = (parts[0] as string).toLowerCase();
  if (head === 'w' || head === 'workspace' || head === 'workspaces') {
    const workspaceId = parts[1];
    const channelId = parts[2];
    if (!workspaceId) return null;
    if (channelId) return { workspaceId, channelId };
    return { workspaceId };
  }
  if (head === 'c' || head === 'channel' || head === 'channels') {
    const channelId = parts[1];
    if (!channelId) return null;
    return { channelId };
  }
  // Phase D: run/inbox/view targets (additive; w/c shapes above unchanged).
  // run|r -> { runId }; inbox -> { inboxId (+view) } or bare { view: 'inbox' };
  // jobs|telemetry -> { view }. No new endpoints; apply maps inbox->jobs.
  if (head === 'run' || head === 'r') {
    const runId = parts[1];
    if (!runId) return null;
    return { runId };
  }
  if (head === 'inbox') {
    const inboxId = parts[1];
    if (inboxId) return { inboxId, view: 'inbox' };
    return { view: 'inbox' };
  }
  if (head === 'jobs') {
    return { view: 'jobs' };
  }
  if (head === 'telemetry') {
    return { view: 'telemetry' };
  }
  // Fallback: bare crowdos://<channel> or crowdos://<workspace>/<channel>
  if (parts.length === 1) return { channelId: parts[0] };
  return { workspaceId: parts[0], channelId: parts[parts.length - 1] };
}

/**
 * Parse a desktop deep-link URL.
 * Supports:
 * - crowdos://w/<workspaceId>/<channelId?>
 * - crowdos://c/<channelId>
 * - #/<workspace>/<channel> / #<channel> (hash forms)
 * Phase D (additive):
 * - crowdos://run/<runId> (alias r), crowdos://inbox/<inboxId?>,
 *   crowdos://jobs, crowdos://telemetry
 * - #run=<id>, #inbox=<id>, #view=jobs|inbox|telemetry
 */
export function parseDeepLink(url: string): DeepLinkParsed | null {
  if (typeof url !== 'string') return null;
  const cleaned = stripQuotes(url.trim());
  if (!cleaned) return null;
  if (/^crowdos:\/\//i.test(cleaned)) {
    return parseCrowdosScheme(cleaned);
  }
  const hashIdx = cleaned.indexOf('#');
  if (hashIdx !== -1) {
    return parseHashBody(cleaned.slice(hashIdx));
  }
  if (cleaned.startsWith('#')) {
    return parseHashBody(cleaned);
  }
  return null;
}

/**
 * Apply a parsed deep-link through the store, mirroring the visibility
 * checks in App.tsx handlePopState: verify the workspace exists before
 * entering it, and verify the channel is visible before activating it.
 */
export async function applyDeepLink(parsed: DeepLinkParsed | null | undefined): Promise<void> {
  if (!parsed) return;
  const workspaceId = parsed.workspaceId;
  const channelId = parsed.channelId;
  const runId = parsed.runId;
  const view = parsed.view;
  if (!workspaceId && !channelId && !runId && !view && !parsed.inboxId) return;
  try {
    // Dynamic import avoids a static cycle with the store.
    const { useCrowdOSStore } = await import('../../stores/crowdOsStore');
    const state = useCrowdOSStore.getState();
    if (workspaceId && workspaceId !== state.activeWorkspaceId) {
      const exists = state.workspaces.some((w) => w.id === workspaceId);
      if (exists) {
        await state.enterWorkspace(workspaceId);
        // Phase D: fall through so channel/view/run still apply post-enter.
      }
    }
    if (channelId && channelId !== useCrowdOSStore.getState().activeChannelId) {
      const cur = useCrowdOSStore.getState();
      const activeWs = cur.workspaces.find((w) => w.id === cur.activeWorkspaceId);
      const visibleIds = new Set<string>([
        ...(activeWs?.channels?.map((c) => c.id) || []),
        ...(activeWs?.categories.flatMap((cat) => cat.channels.map((c) => c.id)) || []),
      ]);
      if (visibleIds.has(channelId)) {
        await cur.setActiveChannel(channelId);
      }
    }
    // Phase D: view targets (inbox renders in the jobs branch; run diffs
    // load via the existing fetchArtifacts transport, best-effort).
    if (view) {
      const target = view === 'inbox' ? 'jobs' : view;
      try { useCrowdOSStore.getState().setRightPanelView(target as 'jobs' | 'telemetry'); } catch {}
    }
    if (runId) {
      try { await useCrowdOSStore.getState().fetchArtifacts(runId); } catch {}
    }
  } catch {
    // Best-effort: deep-links must never break the shell.
  }
}

/**
 * Subscribe to Electron `crowdos:deep-link` events forwarded via the
 * preload bridge (`window.crowdos.on`). No-op when absent (web / file://
 * without preload). Returns an unsubscribe function.
 */
export function subscribeDesktopDeepLinks(): () => void {
  try {
    if (typeof window === 'undefined') return () => {};
    const bridge = (window as unknown as Record<string, unknown>).crowdos as
      | { on?: (channel: string, listener: (payload: unknown) => void) => unknown }
      | undefined;
    if (!bridge || typeof bridge.on !== 'function') return () => {};
    const handler = (payload: unknown): void => {
      try {
        const url =
          typeof payload === 'string'
            ? payload
            : (payload as { url?: unknown } | null | undefined)?.url;
        if (!url || typeof url !== 'string') return;
        const parsed = parseDeepLink(url);
        if (!parsed) return;
        void applyDeepLink(parsed);
      } catch {
        // ignore malformed payloads
      }
    };
    const maybeUnsub = (bridge.on as (c: string, l: (p: unknown) => void) => unknown)(
      'crowdos:deep-link',
      handler,
    );
    if (typeof maybeUnsub === 'function') {
      return maybeUnsub as () => void;
    }
    return () => {};
  } catch {
    return () => {};
  }
}
