import React from 'react';
import {
  AlertTriangle,
  Check,
  Database,
  Download,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useToast } from '@/components/ui/ToastProvider';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import {
  CURSOR_KEYS,
  MUTE_KEY_PREFIX,
  UI_PREF_KEYS,
  safeRemove,
} from '@/src/config/desktop-storage';
// Settings Storage tab (UX_GUIDELINE S7): per-workspace bytes measured from
// live localStorage keys only, plus Clear cache, Vacuum, Reindex, Verify, and
// Export wired to real keys and real endpoints. No mock rows: groups without
// a local key (artifacts, embeddings, search index) render as server-side
// only, and Vacuum renders honestly unavailable because no backend endpoint
// supports it. Reduced-motion static: no animation imports or classes.
type storageGroup = {
  id: string;
  label: string;
  keys: string[];
  totalBytes: number | null;
  keysPresent: number;
  workspaceBytes: number | null;
  note: string;
};
type verifyRow = {
  label: string;
  ok: boolean | null;
  detail: string;
};
const PIN_KEY = 'crowdos_pin';
const THEME_KEY = 'crowdos_theme';
const PALETTE_KEY = 'crowdos_palette_recent';
const JOBS_KEY = 'crowdos_jobs_by_run';
const MESSAGES_KEY = 'crowdos_messages';
const SEQ_KEY = 'crowdos_seq_cursors';
const DRAFTS_KEY = 'crowdos_drafts';
const OUTBOX_KEY = 'crowdos_outbox';
const SERVER_MIRROR_KEYS: readonly string[] = [
  'crowdos_workspaces',
  'crowdos_agents',
  'crowdos_model_profiles',
  'crowdos_instruction_modules',
  'crowdos_model_modules',
  'crowdos_toolkit_modules',
  'crowdos_constraints_modules',
  'crowdos_capabilities_modules',
];
// Regenerable mirrors only. Drafts and outbox are cursor mirrors in the
// taxonomy but hold user-authored restart-survival state, so Clear cache
// deliberately skips them; the PIN and ui-prefs are never evictable.
const EVICTABLE_KEYS: readonly string[] = [
  ...CURSOR_KEYS.filter((k) => k === MESSAGES_KEY || k === SEQ_KEY),
  JOBS_KEY,
];
function byteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}
function readRaw(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function scanCrowdosKeys(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf('crowdos_') === 0) out.push(key);
    }
    return out.sort();
  } catch {
    return [];
  }
}
function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return (Math.round(kb * 10) / 10) + ' KB';
  return (Math.round((kb / 1024) * 10) / 10) + ' MB';
}
// Measures the JSON envelope of the subset attributable to the active
// workspace channel set. Null when the key is missing or unparseable.
function channelSubsetBytes(
  raw: string | null,
  pick: (parsed: unknown) => unknown,
): number | null {
  if (raw === null) return null;
  const parsed = parseJson(raw);
  if (parsed === undefined) return null;
  try {
    const subset = pick(parsed);
    if (subset === undefined) return null;
    return byteLength(JSON.stringify(subset));
  } catch {
    return null;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export default function StorageTab(): React.JSX.Element {
  const { showSuccess, showError } = useToast();
  const workspaces = useCrowdOSStore((s) => s.workspaces);
  const activeWorkspaceId = useCrowdOSStore((s) => s.activeWorkspaceId);
  const isSyncing = useCrowdOSStore((s) => s.isSyncing);
  const fetchDbSync = useCrowdOSStore((s) => s.fetchDbSync);
  const rebuildRag = useCrowdOSStore((s) => s.rebuildRag);
  const [tick, setTick] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);
  const [verifyRows, setVerifyRows] = React.useState<verifyRow[] | null>(null);
  const [exported, setExported] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{
    title: string;
    description: string;
    confirmLabel: string;
    action: 'clear' | 'reindex';
  } | null>(null);
  const activeWS = React.useMemo(
    () => workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );
  const channelIds = React.useMemo(() => {
    const set = new Set<string>();
    if (!activeWS) return set;
    for (const ch of activeWS.channels ?? []) set.add(ch.id);
    for (const cat of activeWS.categories ?? []) {
      for (const ch of cat.channels ?? []) set.add(ch.id);
    }
    return set;
  }, [activeWS]);
  const measured = React.useMemo(() => {
    const keys = scanCrowdosKeys();
    const bytes = new Map<string, number>();
    const corrupt = new Set<string>();
    for (const key of keys) {
      const raw = readRaw(key);
      if (raw === null) continue;
      bytes.set(key, byteLength(key) + byteLength(raw));
      if (parseJson(raw) === undefined) corrupt.add(key);
    }
    return { keys, bytes, corrupt };
  }, [tick]);
  const totalBytes = React.useMemo(() => {
    let sum = 0;
    for (const b of measured.bytes.values()) sum += b;
    return sum;
  }, [measured]);
  const groups: storageGroup[] = React.useMemo(() => {
    const totalOf = (keys: readonly string[]): { total: number; present: number } => {
      let total = 0;
      let present = 0;
      for (const k of keys) {
        const b = measured.bytes.get(k);
        if (b !== undefined) { total += b; present += 1; }
      }
      return { total, present };
    };
    const sumWs = (...vals: Array<number | null>): number | null => {
      let any = false;
      let sum = 0;
      for (const v of vals) { if (v !== null) { any = true; sum += v; } }
      return any ? sum : null;
    };
    const pickChannelMap = (parsed: unknown): unknown => {
      if (!isRecord(parsed)) return undefined;
      const out: Record<string, unknown> = {};
      for (const entry of Object.entries(parsed)) {
        if (channelIds.has(entry[0])) out[entry[0]] = entry[1];
      }
      return out;
    };
    const historyKeys = [MESSAGES_KEY, SEQ_KEY];
    const history = totalOf(historyKeys);
    const msgWs = channelSubsetBytes(readRaw(MESSAGES_KEY), (parsed) => {
      if (!Array.isArray(parsed)) return undefined;
      return (parsed as Array<{ channelId?: unknown }>).filter(
        (m) => typeof m.channelId === 'string' && channelIds.has(m.channelId),
      );
    });
    const seqWs = channelSubsetBytes(readRaw(SEQ_KEY), pickChannelMap);
    const composerKeys = [DRAFTS_KEY, OUTBOX_KEY];
    const composer = totalOf(composerKeys);
    const draftsWs = channelSubsetBytes(readRaw(DRAFTS_KEY), pickChannelMap);
    const outboxWs = channelSubsetBytes(readRaw(OUTBOX_KEY), (parsed) => {
      if (!Array.isArray(parsed)) return undefined;
      return (parsed as Array<{ channelId?: unknown }>).filter(
        (e) => typeof e.channelId === 'string' && channelIds.has(e.channelId),
      );
    });
    const runsKeys = [JOBS_KEY];
    const runs = totalOf(runsKeys);
    const jobsWs = channelSubsetBytes(readRaw(JOBS_KEY), (parsed) => {
      if (!isRecord(parsed)) return undefined;
      const out: Record<string, unknown> = {};
      for (const entry of Object.entries(parsed)) {
        const row = entry[1];
        if (isRecord(row) && typeof row.channelId === 'string' && channelIds.has(row.channelId)) {
          out[entry[0]] = row;
        }
      }
      return out;
    });
    const mirrors = totalOf(SERVER_MIRROR_KEYS);
    const prefKeys = [
      ...UI_PREF_KEYS,
      THEME_KEY,
      PALETTE_KEY,
      ...measured.keys.filter((k) => k.indexOf(MUTE_KEY_PREFIX) === 0),
    ];
    const prefs = totalOf(prefKeys);
    return [
      {
        id: 'history',
        label: 'Message history',
        keys: historyKeys,
        totalBytes: history.total,
        keysPresent: history.present,
        workspaceBytes: sumWs(msgWs, seqWs),
        note: 'Capped per-channel mirror plus seq cursors. Regenerable from fetch; safe to clear. Largest mirror is also the quota-eviction pick.',
      },
      {
        id: 'composer',
        label: 'Drafts and outbox',
        keys: composerKeys,
        totalBytes: composer.total,
        keysPresent: composer.present,
        workspaceBytes: sumWs(draftsWs, outboxWs),
        note: 'User-authored restart-survival state. Clear cache never touches these rows; discard drafts in the composer and outbox entries in the send queue.',
      },
      {
        id: 'runs',
        label: 'Jobs and runs',
        keys: runsKeys,
        totalBytes: runs.total,
        keysPresent: runs.present,
        workspaceBytes: jobsWs,
        note: 'Resumable run rows (cap 200), rebuilt from run.status_changed events. Safe to clear.',
      },
      {
        id: 'mirrors',
        label: 'Workspace and roster mirrors',
        keys: [...SERVER_MIRROR_KEYS],
        totalBytes: mirrors.total,
        keysPresent: mirrors.present,
        workspaceBytes: null,
        note: 'Server-mirror caches refetchable via fetchWorkspaces. Shared across workspaces, so no per-workspace split is reported.',
      },
      {
        id: 'prefs',
        label: 'UI prefs',
        keys: prefKeys,
        totalBytes: prefs.total,
        keysPresent: prefs.present,
        workspaceBytes: null,
        note: 'Tiny prefs (active ids, modes, mutes, theme, palette recents). Never auto-evicted and never cleared by Clear cache.',
      },
      {
        id: 'server',
        label: 'Artifacts, embeddings, and search index',
        keys: [],
        totalBytes: null,
        keysPresent: 0,
        workspaceBytes: null,
        note: 'Server-side only (Postgres plus workspace files). No localStorage key exists, so no local bytes are reported; use Reindex and Verify against the connected database.',
      },
    ];
  }, [measured, channelIds]);
  const dbBox = activeWS && activeWS.database ? activeWS.database.configured : false;
  const dbConfigured: boolean = dbBox === true;
  const runClear = React.useCallback(() => {
    setBusy('clear');
    try {
      let freed = 0;
      let count = 0;
      for (const key of EVICTABLE_KEYS) {
        const before = measured.bytes.get(key);
        if (readRaw(key) === null && before === undefined) continue;
        safeRemove(key);
        if (readRaw(key) === null) {
          count += 1;
          if (before !== undefined) freed += before;
        }
      }
      setTick((t) => t + 1);
      const msg = count === 0
        ? 'No evictable mirrors are set. Nothing cleared.'
        : 'Cache cleared: ' + formatBytes(freed) + ' freed across ' + count + ' mirror(s). In-memory session state is untouched; mirrors rebuild on the next write or fetch.';
      setResult(msg);
      setVerifyRows(null);
      showSuccess('Cache cleared', msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult('Clear failed: ' + msg);
      showError('Clear failed', msg);
    } finally {
      setBusy(null);
    }
  }, [measured, showSuccess, showError]);
  const runVerify = React.useCallback(() => {
    setBusy('verify');
    try {
      const rows: verifyRow[] = groups.map((g) => {
        if (g.keys.length === 0) {
          return { label: g.label, ok: null, detail: 'Server-side only; no local key to verify.' };
        }
        const corrupt = g.keys.filter((k) => measured.corrupt.has(k));
        if (corrupt.length > 0) {
          return { label: g.label, ok: false, detail: 'Corrupt JSON in ' + corrupt.join(', ') + '.' };
        }
        const missing = g.keys.filter((k) => readRaw(k) === null);
        if (missing.length > 0) {
          return { label: g.label, ok: true, detail: 'Readable; missing ' + missing.join(', ') + ' (treated as empty).' };
        }
        return { label: g.label, ok: true, detail: g.keysPresent + ' of ' + g.keys.length + ' key(s) readable.' };
      });
      setVerifyRows(rows);
      const bad = rows.filter((r) => r.ok === false).length;
      const msg = bad === 0
        ? 'Verify complete: all present local mirrors parse as JSON.'
        : 'Verify complete: ' + bad + ' group(s) hold corrupt JSON (see rows).';
      setResult(msg);
      if (dbConfigured && activeWorkspaceId) {
        fetchDbSync(activeWorkspaceId).catch(() => {});
      }
      setTick((t) => t + 1);
      showSuccess('Verify complete', msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult('Verify failed: ' + msg);
      showError('Verify failed', msg);
    } finally {
      setBusy(null);
    }
  }, [groups, measured, dbConfigured, activeWorkspaceId, fetchDbSync, showSuccess, showError]);

  const runReindex = React.useCallback(async () => {
    if (!activeWorkspaceId) {
      setResult('No active workspace to reindex.');
      return;
    }
    if (!dbConfigured) {
      setResult('Reindex needs a connected database. Connect it first, then retry.');
      return;
    }
    setBusy('reindex');
    try {
      await rebuildRag(activeWorkspaceId);
      setTick((t) => t + 1);
      const msg = 'Reindex requested for this workspace.';
      setResult(msg);
      showSuccess('Reindex requested', msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult('Reindex failed: ' + msg);
      showError('Reindex failed', msg);
    } finally {
      setBusy(null);
    }
  }, [activeWorkspaceId, dbConfigured, rebuildRag, showSuccess, showError]);

  const runExport = React.useCallback(() => {
    try {
      const payload = {
        exportedAt: new Date().toISOString(),
        workspaceId: activeWorkspaceId,
        totalBytes,
        groups: groups.map((g) => ({
          id: g.id,
          label: g.label,
          keys: g.keys,
          totalBytes: g.totalBytes,
          keysPresent: g.keysPresent,
          workspaceBytes: g.workspaceBytes,
          note: g.note,
        })),
        corruptKeys: [...measured.corrupt],
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'storage-export-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExported(true);
      showSuccess('Storage exported', 'Key inventory plus byte sizes downloaded (no secret values).');
      window.setTimeout(() => setExported(false), 2500);
    } catch (err) {
      showError('Export failed', err instanceof Error ? err.message : 'Could not build the export file.');
    }
  }, [activeWorkspaceId, totalBytes, groups, measured, showSuccess, showError]);

  const rescan = React.useCallback(() => {
    setTick((t) => t + 1);
    setResult('Rescanned local keys.');
    setVerifyRows(null);
  }, []);

  const requestClear = React.useCallback(() => {
    setConfirm({
      title: 'Clear cache?',
      description: 'Removes regenerable mirrors (message history, seq cursors, jobs). Drafts, outbox, PIN, and prefs are never touched. Mirrors rebuild on the next fetch.',
      confirmLabel: 'Clear cache',
      action: 'clear',
    });
  }, []);

  const requestReindex = React.useCallback(() => {
    setConfirm({
      title: 'Reindex search?',
      description: 'Asks the connected database to rebuild this workspace search index. Local drafts and history are untouched.',
      confirmLabel: 'Reindex',
      action: 'reindex',
    });
  }, []);

  const handleConfirm = React.useCallback(() => {
    const action = confirm?.action;
    setConfirm(null);
    if (action === 'clear') runClear();
    else if (action === 'reindex') void runReindex();
  }, [confirm, runClear, runReindex]);

  const busyLabel = busy === null ? null : busy === 'clear' ? 'Clearing cache...' : busy === 'verify' ? 'Verifying...' : 'Reindexing...';

  return (
    <div className="space-y-4 text-xs font-sans leading-relaxed">
      <div className="space-y-1 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <h4 className="font-semibold text-zinc-300 text-xs flex items-center gap-1.5">
          <HardDrive size={13} className="text-indigo-400" aria-hidden="true" />
          <span>Storage</span>
          <span className="tnum ml-auto font-mono text-[11px] text-zinc-400">{formatBytes(totalBytes)} local</span>
        </h4>
        <p className="text-zinc-500 leading-normal">
          Per-workspace bytes measured from live localStorage keys only. Groups without a local key are server-side
          only and report no local bytes instead of invented numbers.
        </p>
        <p className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
          <Database size={12} aria-hidden="true" />
          <span>{dbConfigured ? 'Database connected for Reindex and Verify.' : 'Database not connected: Reindex is unavailable.'}</span>
        </p>
      </div>
      <div className="space-y-2 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={requestClear} disabled={busy !== null} className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg bg-zinc-900 border border-zinc-700 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50">
            <Trash2 size={13} aria-hidden="true" />
            <span>Clear cache</span>
          </button>
          <button type="button" onClick={requestReindex} disabled={busy !== null || isSyncing || !dbConfigured || !activeWorkspaceId} title={!dbConfigured ? 'Reindex needs a connected database' : 'Rebuild the workspace search index'} className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg bg-zinc-900 border border-zinc-700 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50">
            <RefreshCw size={13} aria-hidden="true" />
            <span>Reindex</span>
          </button>
          <button type="button" onClick={() => void runVerify()} disabled={busy !== null} className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg bg-zinc-900 border border-zinc-700 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50">
            <ShieldCheck size={13} aria-hidden="true" />
            <span>Verify</span>
          </button>
          <button type="button" onClick={runExport} className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-[12px] font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-200">
            <Download size={13} aria-hidden="true" />
            <span>Export</span>
          </button>
          <button type="button" onClick={rescan} disabled={busy !== null} className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg bg-zinc-900 border border-zinc-700 text-[12px] font-semibold text-zinc-200 hover:bg-zinc-800 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50">
            <RefreshCw size={13} aria-hidden="true" />
            <span>Rescan</span>
          </button>
          <span title="No backend vacuum endpoint exists" aria-label="Vacuum unavailable: no backend endpoint" className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg border border-zinc-800 text-[12px] font-semibold text-zinc-500 cursor-not-allowed">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>Vacuum unavailable</span>
          </span>
        </div>
        <div role="status" aria-live="polite">
          {busyLabel ? <p className="text-zinc-400 text-[12px]">{busyLabel}</p> : null}
          {result ? <p className="text-zinc-300 text-[12px]">{result}</p> : null}
          {exported ? (
            <p className="inline-flex items-center gap-1 text-zinc-300 text-[12px]">
              <Check size={12} aria-hidden="true" />
              <span>Export downloaded.</span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.id} className="rounded-lg border border-zinc-900 bg-zinc-950 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-semibold text-zinc-200 text-[12px]">{g.label}</p>
              <p className="tnum font-mono text-[11px] text-zinc-400">
                {formatBytes(g.totalBytes)}
                {g.workspaceBytes !== null ? ' - ' + formatBytes(g.workspaceBytes) + ' this workspace' : ''}
              </p>
            </div>
            <p className="text-zinc-500 text-[11px] leading-normal mt-0.5">{g.note}</p>
            <p className="text-zinc-600 font-mono text-[11px] mt-1">
              {g.keys.length > 0 ? g.keys.join(', ') + ' - ' + g.keysPresent + ' present' : 'No localStorage key'}
            </p>
          </div>
        ))}
      </div>
      {verifyRows ? (
        <div className="space-y-2 bg-zinc-950 p-4 border border-zinc-900 rounded-lg">
          <h4 className="font-semibold text-zinc-300 text-xs">Verify results</h4>
          <ul className="space-y-1.5">
            {verifyRows.map((r) => (
              <li key={r.label} className="flex items-start gap-1.5 text-[12px]">
                {r.ok === true ? (
                  <Check size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-400" />
                ) : r.ok === false ? (
                  <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-rose-400" />
                ) : (
                  <Database size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-zinc-500" />
                )}
                <span>
                  <span className="font-semibold text-zinc-200">{r.label}. </span>
                  <span className="text-zinc-500">{r.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {measured.corrupt.size > 0 ? (
        <p role="note" className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
          <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{measured.corrupt.size} local key(s) hold corrupt JSON and were excluded from per-workspace bytes.</span>
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.confirmLabel ?? 'Confirm'}
        cancelLabel="Cancel"
        isDanger={confirm?.action === 'clear'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
