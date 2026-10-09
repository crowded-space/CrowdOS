import { useEffect, useState, useMemo, useRef } from 'react';
import { FileCode2, Check, Undo2, LayoutPanelLeft, Rows3, Copy, Download } from 'lucide-react';
import { useCrowdOSStore, type ArtifactRow } from '@/stores/crowdOsStore';
import { apiClient } from '@/src/api/client';

function parsePatchLines(patch: string): Array<{ type: 'added' | 'removed' | 'context' | 'hunk' | 'header'; text: string }> {
  const lines = patch.split('\n');
  return lines.map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return { type: 'header' as const, text: line };
    if (line.startsWith('@@')) return { type: 'hunk' as const, text: line };
    if (line.startsWith('+')) return { type: 'added' as const, text: line };
    if (line.startsWith('-')) return { type: 'removed' as const, text: line };
    return { type: 'context' as const, text: line };
  });
}

function SideBySideView({ patch }: { patch: string }) {
  const parsed = useMemo(() => parsePatchLines(patch), [patch]);
  const left: typeof parsed = [];
  const right: typeof parsed = [];
  for (const l of parsed) {
    if (l.type === 'added') right.push(l);
    else if (l.type === 'removed') left.push(l);
    else if (l.type === 'header' || l.type === 'hunk') {
      left.push(l);
      right.push(l);
    } else {
      left.push(l);
      right.push(l);
    }
  }
  const max = Math.max(left.length, right.length);
  return (
    <div className="grid grid-cols-2 gap-0 border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
      <div className="border-r border-zinc-800">
        <div className="text-[10px] font-semibold text-zinc-500 px-2 py-1 bg-zinc-900 border-b border-zinc-800">Before</div>
        <pre className="p-2 text-[11px] font-mono leading-5 overflow-x-auto">
          {left.map((l, i) => (
            <div
              key={`l-${i}`}
              className={
                l.type === 'removed' ? 'bg-rose-500/20 text-rose-300' :
                l.type === 'hunk' ? 'bg-zinc-800 text-zinc-400' :
                l.type === 'header' ? 'text-zinc-500' : 'text-zinc-300'
              }
            >
              {l.text || ' '}
            </div>
          ))}
          {left.length < max && Array.from({ length: max - left.length }).map((_, k) => <div key={`pad-l-${k}`}>&nbsp;</div>)}
        </pre>
      </div>
      <div>
        <div className="text-[10px] font-semibold text-zinc-500 px-2 py-1 bg-zinc-900 border-b border-zinc-800">After</div>
        <pre className="p-2 text-[11px] font-mono leading-5 overflow-x-auto">
          {right.map((l, i) => (
            <div
              key={`r-${i}`}
              className={
                l.type === 'added' ? 'bg-emerald-500/20 text-emerald-300' :
                l.type === 'hunk' ? 'bg-zinc-800 text-zinc-400' :
                l.type === 'header' ? 'text-zinc-500' : 'text-zinc-300'
              }
            >
              {l.text || ' '}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function UnifiedView({ patch }: { patch: string }) {
  const parsed = useMemo(() => parsePatchLines(patch), [patch]);
  return (
    <pre className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 overflow-x-auto text-[11px] font-mono leading-5">
      {parsed.map((l, i) => (
        <div
          key={i}
          className={
            l.type === 'added' ? 'bg-emerald-500/15 text-emerald-300' :
            l.type === 'removed' ? 'bg-rose-500/15 text-rose-300' :
            l.type === 'hunk' ? 'text-cyan-400 bg-zinc-900' :
            l.type === 'header' ? 'text-zinc-500' : 'text-zinc-400'
          }
        >
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

type lastMutation =
  | { kind: 'apply'; artifactId: string }
  | { kind: 'revert'; artifactId: string }
  | { kind: 'applyAll'; runId: string };

/** Split a unified patch into hunks keyed by their @@ header. */
function splitHunks(patch: string): Array<{ header: string; lines: string[] }> {
  const out: Array<{ header: string; lines: string[] }> = [];
  let cur: { header: string; lines: string[] } | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      cur = { header: line, lines: [] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out;
}

/**
 * Per-hunk explanation from the REAL artifact payload only. Extras ride in
 * `metadata` (Record<string, unknown>); when the run recorded per-hunk notes
 * they arrive as `hunkExplanations` (index-aligned array or header-keyed map).
 * Absent or malformed -> null, and the caller renders honest empty. Never
 * fabricated here.
 */
function hunkExplanation(art: ArtifactRow, hunkIndex: number, header: string): string | null {
  const meta = art.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  const cand = record.hunkExplanations ?? record.explanations;
  if (Array.isArray(cand)) {
    const v = cand[hunkIndex];
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  }
  if (cand && typeof cand === 'object') {
    const v = (cand as Record<string, unknown>)[header];
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  }
  return null;
}

/** Reconstruct the pre-image of a unified patch (same rule as store revertDiff). */
function beforeImageOf(patch: string | null): string | null {
  if (!patch) return null;
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-') || line.startsWith(' ')) out.push(line.slice(1));
  }
  return out.join('\n');
}

function baseNameOf(path: string | null, fallback: string): string {
  if (!path) return fallback;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || fallback;
}

/** Per-hunk note slot: real payload text when present, honest empty otherwise. */
function HunkNotes({ art }: { art: ArtifactRow }) {
  const hunks = useMemo(() => splitHunks(art.patch ?? ''), [art.patch]);
  if (hunks.length === 0 || !art.patch) return null;
  const notes = hunks.map((h, i) => hunkExplanation(art, i, h.header));
  if (notes.every(n => n === null)) {
    return (
      <div className="border-t border-zinc-800 px-3 py-2 bg-zinc-950/60">
        <h4 className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-wide">Hunk notes</h4>
        <p className="mt-1 text-[11px] font-mono text-zinc-600">No explanations recorded for this diff.</p>
      </div>
    );
  }
  return (
    <div className="border-t border-zinc-800 px-3 py-2 space-y-1.5 bg-zinc-950/60">
      <h4 className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-wide">Hunk notes</h4>
      {hunks.map((h, i) => (
        <div key={`${h.header}-${i}`} className="text-[11px] font-mono">
          <div className="text-cyan-400/80 truncate" title={h.header}>{h.header || `Hunk ${i + 1}`}</div>
          {notes[i] ? (
            <div className="text-zinc-300 break-words">{notes[i]}</div>
          ) : (
            <div className="text-zinc-600">No explanation recorded for this hunk.</div>
          )}
        </div>
      ))}
    </div>
  );
}

export function DiffViewer({ runId, artifactId }: { runId?: string; artifactId?: string }) {
  const fetchArtifacts = useCrowdOSStore(s => s.fetchArtifacts);
  const artifactsByRun = useCrowdOSStore(s => s.artifactsByRun);
  const applyDiff = useCrowdOSStore(s => s.applyDiff);
  const revertDiff = useCrowdOSStore(s => s.revertDiff);
  const applyAllDiffs = useCrowdOSStore(s => s.applyAllDiffs);
  // Phase C: one busy token + one error slot shared with CheckpointRow and the
  // drawer. Non-null diffBusy disables every mutator; no local busy copy.
  const diffBusy = useCrowdOSStore(s => s.diffBusy);
  const diffError = useCrowdOSStore(s => s.diffError);
  const clearDiffError = useCrowdOSStore(s => s.clearDiffError);
  const activeWorkspaceId = useCrowdOSStore(s => s.activeWorkspaceId);
  // FIX-B: honest fetch state for diff fetch only (store signals, no API change).
  const artifactsFetching = useCrowdOSStore(s => s.artifactsFetching);
  const artifactsFetchError = useCrowdOSStore(s => s.artifactsFetchError);
  const [viewMode, setViewMode] = useState<'unified' | 'side'>('unified');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [conflictById, setConflictById] = useState<Record<string, string>>({});
  const [lastMutation, setLastMutation] = useState<lastMutation | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (runId) void fetchArtifacts(runId);
  }, [runId, fetchArtifacts]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const busy = diffBusy !== null;

  const runMutation = async (next: lastMutation) => {
    setLastMutation(next);
    try {
      if (next.kind === 'apply') await applyDiff(next.artifactId);
      else if (next.kind === 'revert') await revertDiff(next.artifactId);
      else await applyAllDiffs(next.runId);
    } catch {
      // Cause is already in diffError via the store; never an unhandled rejection.
    }
  };

  const retryLast = () => {
    if (!lastMutation) {
      if (runId) void fetchArtifacts(runId);
      return;
    }
    clearDiffError();
    void runMutation(lastMutation);
  };
  // FIX-B: failed diff fetch renders error-with-retry (existing store path),
  // never a stuck Loading state. Mutation errors keep the existing block.
  const fetchErrorForRun = runId ? (artifactsFetchError?.[runId] ?? null) : null;
  const fetchingForRun = runId ? (artifactsFetching?.[runId] ?? false) : false;
  const retryFetch = () => {
    if (runId) void fetchArtifacts(runId);
  };

  const dismissConflict = (id: string) => {
    setConflictById(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // Optimistic-concurrency guard: read the live file before applying. When it
  // matches neither the before- nor the after-image, someone else touched the
  // file, so surface a conflict notice instead of silently overwriting.
  const checkConflict = async (art: ArtifactRow): Promise<string | null> => {
    if (!art.path) return 'No path on this artifact, so there is no live file to compare against.';
    const workspaceId = activeWorkspaceId || art.workspaceId || 'default';
    let live: string;
    try {
      live = await apiClient.getWorkspaceFileContent(art.path, workspaceId);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : 'unknown error';
      return 'Could not read the live file (' + cause + '). It may have moved, or the workspace may be offline.';
    }
    const after = art.contentRef ?? '';
    if (after !== '' && live === after) return 'Already applied: the live file already matches this diff.';
    const before = beforeImageOf(art.patch);
    if (before !== null && before !== '' && live !== before) {
      const expected = art.beforeHash ? art.beforeHash.slice(0, 7) : 'the snapshot';
      return 'File changed since ' + expected + ': the live file matches neither the before- nor the after-image. Review before applying.';
    }
    return null;
  };

  const handleApply = async (art: ArtifactRow) => {
    const conflict = await checkConflict(art);
    if (conflict) {
      setConflictById(prev => ({ ...prev, [art.id]: conflict }));
      return;
    }
    dismissConflict(art.id);
    await runMutation({ kind: 'apply', artifactId: art.id });
  };

  const handleApplyAnyway = async (art: ArtifactRow) => {
    dismissConflict(art.id);
    await runMutation({ kind: 'apply', artifactId: art.id });
  };

  const handleCopy = async (art: ArtifactRow) => {
    const text = art.patch ?? art.contentRef ?? '';
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopiedId(art.id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
  };

  const handleDownload = (art: ArtifactRow) => {
    const text = art.patch ?? art.contentRef ?? '';
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = baseNameOf(art.path, art.id) + (art.patch ? '.patch' : '.txt');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const artifacts: ArtifactRow[] = useMemo(() => {
    if (artifactId) {
      const all = Object.values(artifactsByRun).flat() as ArtifactRow[];
      const found = all.find(a => a.id === artifactId);
      return found ? [found] : [];
    }
    if (runId) return (artifactsByRun[runId] as ArtifactRow[] | undefined) || [];
    const all = Object.values(artifactsByRun).flat() as ArtifactRow[];
    return all.filter(a => a.artifactType === 'diff' || a.artifactType === 'file');
  }, [artifactsByRun, runId, artifactId]);

  const diffs = artifacts.filter(a => a.artifactType === 'diff' || a.patch);

  if (!runId && !artifactId && artifacts.length === 0) {
    return (
      <div className="border border-zinc-800 bg-zinc-950/40 rounded-xl p-4 text-xs text-zinc-500 font-mono">
        No diff artifacts for this run.
      </div>
    );
  }

  // FIX-B: failed fetch -> error-with-retry; in-flight/unknown -> Loading.
  if (fetchErrorForRun && diffs.length === 0) {
    return (
      <div role="alert" className="border border-rose-500/30 bg-rose-500/10 rounded-xl px-3 py-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-mono font-semibold text-rose-300">Failed to load diffs</div>
          <div className="text-[11px] font-mono text-rose-200/80 break-words">{fetchErrorForRun}</div>
        </div>
        <button
          onClick={retryFetch}
          disabled={fetchingForRun}
          aria-label="Retry loading diffs"
          className="shrink-0 px-3 py-1.5 min-h-[30px] rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px] font-mono font-semibold border border-zinc-700 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
        >
          Retry
        </button>
      </div>
    );
  }

  if (diffs.length === 0) {
    return (
      <div className="border border-zinc-800 bg-zinc-950/40 rounded-xl p-4 text-xs text-zinc-500 font-mono flex items-center gap-2">
        <FileCode2 size={14} />
        <span>Loading diffs…</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div role="group" aria-label="Diff view mode" className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-xl p-1">
          <button
            onClick={() => setViewMode('unified')}
            aria-pressed={viewMode === 'unified'}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition ${viewMode === 'unified' ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            <Rows3 size={12} /> Unified
          </button>
          <button
            onClick={() => setViewMode('side')}
            aria-pressed={viewMode === 'side'}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition ${viewMode === 'side' ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            <LayoutPanelLeft size={12} /> Side-by-side
          </button>
        </div>
        <span className="text-[10px] font-mono text-zinc-500">{diffs.length} file(s)</span>
      </div>

      {runId && diffs.length > 1 && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => { void runMutation({ kind: 'applyAll', runId }); }}
            disabled={busy}
            aria-label={`Apply all ${diffs.length} diffs for this run`}
            className="px-3 py-1.5 min-h-[30px] rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-[11px] font-mono font-semibold flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
          >
            <Check size={12} /> Apply all ({diffs.length})
          </button>
          {busy && diffBusy && <span className="text-[10px] font-mono text-zinc-500">Working: {diffBusy}</span>}
        </div>
      )}

      {diffError && (
        <div role="alert" className="border border-rose-500/30 bg-rose-500/10 rounded-xl px-3 py-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-mono font-semibold text-rose-300">Diff action failed</div>
            <div className="text-[11px] font-mono text-rose-200/80 break-words">{diffError}</div>
          </div>
          <button
            onClick={retryLast}
            disabled={busy}
            aria-label="Retry the last diff action"
            className="shrink-0 px-3 py-1.5 min-h-[30px] rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px] font-mono font-semibold border border-zinc-700 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
          >
            Retry
          </button>
        </div>
      )}

      {diffs.map(art => (
        <div key={art.id} className="border border-zinc-800 bg-zinc-950/40 rounded-xl overflow-hidden">
          <h3 className="flex items-center justify-between px-3 py-2 bg-zinc-900/50 border-b border-zinc-800">
            <div className="flex items-center gap-2 min-w-0">
              <FileCode2 size={13} className="text-zinc-500 shrink-0" />
              <span className="text-xs font-mono font-semibold text-zinc-200 truncate">{art.path || art.id}</span>
              <span className="text-[10px] font-mono text-zinc-500 hidden sm:inline">
                {art.beforeHash?.slice(0, 7) || '-'} → {art.afterHash?.slice(0, 7) || '-'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => { void handleCopy(art); }}
                aria-label={`Copy diff for ${art.path || art.id}`}
                title={copiedId === art.id ? 'Copied' : 'Copy patch to clipboard'}
                className="px-2.5 py-1.5 min-h-[30px] rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-zinc-300 text-[11px] font-mono font-semibold border border-zinc-800 flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              >
                <Copy size={12} /> {copiedId === art.id ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => handleDownload(art)}
                disabled={!(art.patch ?? art.contentRef)}
                aria-label={`Download diff for ${art.path || art.id}`}
                title="Download patch as a file"
                className="px-2.5 py-1.5 min-h-[30px] rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-zinc-300 text-[11px] font-mono font-semibold border border-zinc-800 flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              >
                <Download size={12} /> Download
              </button>
              <button
                onClick={() => { void handleApply(art); }}
                disabled={busy}
                aria-label={`Apply diff for ${art.path || art.id}`}
                className="px-3 py-1.5 min-h-[30px] rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-semibold flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
              >
                <Check size={12} /> Apply
              </button>
              <button
                onClick={() => { void runMutation({ kind: 'revert', artifactId: art.id }); }}
                disabled={busy}
                aria-label={`Revert diff for ${art.path || art.id}`}
                className="px-3 py-1.5 min-h-[30px] rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px] font-semibold border border-zinc-700 flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              >
                <Undo2 size={12} /> Revert
              </button>
            </div>
          </h3>

          {conflictById[art.id] && (
            <div role="alert" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-mono font-semibold text-amber-300">File changed on disk</div>
                <div className="text-[11px] font-mono text-amber-200/80 break-words">{conflictById[art.id]}</div>
              </div>
              <button
                onClick={() => { void handleApplyAnyway(art); }}
                disabled={busy}
                aria-label={`Apply anyway for ${art.path || art.id}`}
                className="shrink-0 px-2.5 py-1.5 min-h-[30px] rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-[11px] font-mono font-semibold transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                Apply anyway
              </button>
              <button
                onClick={() => dismissConflict(art.id)}
                aria-label={`Dismiss conflict notice for ${art.path || art.id}`}
                className="shrink-0 px-2.5 py-1.5 min-h-[30px] rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] font-mono font-semibold border border-zinc-800 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              >
                Dismiss
              </button>
            </div>
          )}

          {art.patch ? (
            <>
              {viewMode === 'unified' ? <UnifiedView patch={art.patch} /> : <SideBySideView patch={art.patch} />}
              <HunkNotes art={art} />
            </>
          ) : art.contentRef ? (
            <pre className="p-3 bg-zinc-950 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {art.contentRef.slice(0, 4000)}
            </pre>
          ) : (
            <div className="p-3 text-xs text-zinc-500 font-mono">No patch available</div>
          )}
        </div>
      ))}
    </div>
  );
}

export default DiffViewer;
