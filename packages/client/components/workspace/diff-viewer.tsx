import { useEffect, useState, useMemo } from 'react';
import { FileCode2, Check, Undo2, LayoutPanelLeft, Rows3 } from 'lucide-react';
import { useCrowdOSStore, type ArtifactRow } from '@/stores/crowd-os-store';

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
        <div className="text-[10px] font-mono font-bold text-zinc-500 px-2 py-1 bg-zinc-900 border-b border-zinc-800">BEFORE</div>
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
        <div className="text-[10px] font-mono font-bold text-zinc-500 px-2 py-1 bg-zinc-900 border-b border-zinc-800">AFTER</div>
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

export function DiffViewer({ runId, artifactId }: { runId?: string; artifactId?: string }) {
  const fetchArtifacts = useCrowdOSStore(s => s.fetchArtifacts);
  const artifactsByRun = useCrowdOSStore(s => s.artifactsByRun);
  const applyDiff = useCrowdOSStore(s => s.applyDiff);
  const revertDiff = useCrowdOSStore(s => s.revertDiff);
  const [viewMode, setViewMode] = useState<'unified' | 'side'>('unified');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (runId) void fetchArtifacts(runId);
  }, [runId, fetchArtifacts]);

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
            role="button"
            className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition ${viewMode === 'unified' ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            <Rows3 size={12} /> Unified
          </button>
          <button
            onClick={() => setViewMode('side')}
            aria-pressed={viewMode === 'side'}
            role="button"
            className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition ${viewMode === 'side' ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            <LayoutPanelLeft size={12} /> Side-by-side
          </button>
        </div>
        <span className="text-[10px] font-mono text-zinc-500">{diffs.length} file(s)</span>
      </div>

      {diffs.map(art => (
        <div key={art.id} className="border border-zinc-800 bg-zinc-950/40 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/50 border-b border-zinc-800">
            <div className="flex items-center gap-2 min-w-0">
              <FileCode2 size={13} className="text-zinc-500 shrink-0" />
              <span className="text-xs font-mono font-semibold text-zinc-200 truncate">{art.path || art.id}</span>
              <span className="text-[10px] font-mono text-zinc-500 hidden sm:inline">
                {art.beforeHash?.slice(0, 7) || '—'} → {art.afterHash?.slice(0, 7) || '—'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={async () => {
                  setBusy(art.id + '-apply');
                  try { await applyDiff(art.id); } finally { setBusy(null); }
                }}
                disabled={!!busy}
                className="px-3 py-1.5 min-h-[30px] rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-semibold flex items-center gap-1.5 transition cursor-pointer"
              >
                <Check size={12} /> Apply
              </button>
              <button
                onClick={async () => {
                  setBusy(art.id + '-revert');
                  try { await revertDiff(art.id); } finally { setBusy(null); }
                }}
                disabled={!!busy}
                className="px-3 py-1.5 min-h-[30px] rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px] font-semibold border border-zinc-700 flex items-center gap-1.5 transition cursor-pointer"
              >
                <Undo2 size={12} /> Revert
              </button>
            </div>
          </div>

          {art.patch ? (
            viewMode === 'unified' ? <UnifiedView patch={art.patch} /> : <SideBySideView patch={art.patch} />
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
