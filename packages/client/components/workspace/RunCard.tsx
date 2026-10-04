import { useState } from 'react';
import { ChevronDown, ChevronUp, Coins, FileCode2, MessageSquare } from 'lucide-react';
import { useCrowdOSStore, type ArtifactRow, type jobRow } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';

export interface runCardProps {
  runId: string;
  onOpenThread?: (runId: string) => void;
  onOpenDiff?: (runId: string) => void;
}

const NO_ARTIFACTS: ArtifactRow[] = [];

function statusTone(status: string): string {
  const st = status.toLowerCase();
  if (st === 'completed') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20';
  if (st === 'failed') return 'bg-rose-500/15 text-rose-300 border-rose-500/20';
  if (st === 'cancelled') return 'bg-zinc-800 text-zinc-400 border-zinc-700';
  if (st === 'resumable' || st === 'orphaned') return 'bg-amber-500/15 text-amber-300 border-amber-500/20';
  return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/20';
}

function formatCost(cost: number | null | undefined): string {
  return typeof cost === 'number' ? '$' + cost.toFixed(4) : '\u2014';
}

function formatElapsedMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '\u2014';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return minutes + 'm ' + (totalSeconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

function formatTokens(tokens: number | null | undefined): string {
  return typeof tokens === 'number' ? tokens.toLocaleString() : '\u2014';
}

/**
 * Run card (Phase E): compact index card per run in the channel stream.
 * Reads the SAME run-status source as JobsView (store jobsByRun projected
 * from run.status_changed, plus artifactsByRun) - never a second run model.
 * Status/cost/step render a dash until a real source provides them, never a
 * zero or an estimate. Collapsed summary by default; Open thread / Open diff
 * are caller callbacks (ThreadDrawer wiring lands in the next slice).
 */
export function RunCard({ runId, onOpenThread, onOpenDiff }: runCardProps): React.JSX.Element {
  const { job, artifacts, setRightPanelView } = useCrowdOSStore(useShallow((s) => ({
    job: (s.jobsByRun[runId] ?? null) as jobRow | null,
    artifacts: (s.artifactsByRun[runId] ?? NO_ARTIFACTS) as ArtifactRow[],
    setRightPanelView: s.setRightPanelView,
  })));
  const [expanded, setExpanded] = useState(false);

  const status = job?.status ?? '\u2014';
  const runtime = job ? (job.runtime || 'unknown') : '\u2014';
  const diffCount = artifacts.filter((a) => a.artifactType === 'diff' || a.patch).length;
  const shortId = runId.length > 8 ? runId.slice(0, 8) : runId;
  const rawCost = job?.cost ?? null;
  const hasCost = typeof rawCost === 'number' && Number.isFinite(rawCost);
  const costText = formatCost(rawCost);
  const openTelemetry = () => setRightPanelView('telemetry');

  return (
    <div
      className="mx-auto max-w-3xl w-full border border-zinc-800 bg-zinc-950/40 rounded-xl px-3 py-2"
      aria-label={'Run ' + shortId}
    >
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse run summary' : 'Expand run summary'}
          className="w-7 h-7 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition shrink-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        <span className={'shrink-0 inline-block px-1.5 py-0.5 rounded border text-[10px] font-mono font-medium ' + statusTone(status)}>
          {status}
        </span>
        <span className="tnum truncate text-[11px] font-mono text-zinc-300" title={runId}>
          run {shortId}
        </span>
        <span className="shrink-0 text-[10px] font-mono text-zinc-500">{runtime}</span>
        {hasCost ? (
          <button
            type="button"
            onClick={openTelemetry}
            title="Open telemetry panel"
            aria-label={'Open telemetry panel: run cost ' + costText}
            className="tnum ml-auto shrink-0 inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400 rounded hover:text-emerald-300 hover:underline hover:underline-offset-2 transition motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
          >
            <Coins size={11} aria-hidden="true" />
            <span>{costText}</span>
          </button>
        ) : (
          <span className="tnum ml-auto shrink-0 text-[11px] font-mono text-zinc-400" title="No ledger row for this run yet" aria-label="Run cost unavailable">
            —
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpenThread?.(runId)}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
        >
          <MessageSquare size={11} aria-hidden="true" />
          Thread
        </button>
        <button
          type="button"
          onClick={() => onOpenDiff?.(runId)}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
        >
          <FileCode2 size={11} aria-hidden="true" />
          Diff
        </button>
      </div>
      {expanded && (
        <dl className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px] font-mono">
          <div className="rounded-lg border border-zinc-900 bg-zinc-950/60 px-2 py-1.5">
            <dt className="text-zinc-600 text-[10px] uppercase tracking-wide">Step</dt>
            <dd className="tnum text-zinc-300">{job?.step ?? '\u2014'}</dd>
          </div>
          <div className="rounded-lg border border-zinc-900 bg-zinc-950/60 px-2 py-1.5">
            <dt className="text-zinc-600 text-[10px] uppercase tracking-wide">Elapsed</dt>
            <dd className="tnum text-zinc-300">{formatElapsedMs(job?.elapsedMs)}</dd>
          </div>
          <div className="rounded-lg border border-zinc-900 bg-zinc-950/60 px-2 py-1.5">
            <dt className="text-zinc-600 text-[10px] uppercase tracking-wide">Tokens</dt>
            <dd className="tnum text-zinc-300">{formatTokens(job?.tokens)}</dd>
          </div>
          <div className="rounded-lg border border-zinc-900 bg-zinc-950/60 px-2 py-1.5">
            <dt className="text-zinc-600 text-[10px] uppercase tracking-wide">Diffs</dt>
            <dd className="tnum text-zinc-300">{diffCount}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
