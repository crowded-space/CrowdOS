import { useEffect, useState } from 'react';
import { Coins, Square } from 'lucide-react';
import { useCrowdOSStore, type ArtifactRow, type jobRow } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';

export interface runHeaderProps {
  runId: string;
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
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
  return typeof cost === "number" ? "$" + cost.toFixed(4) : "\u2014";
}
function formatElapsedMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "\u2014";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return minutes + 'm ' + (totalSeconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleTimeString();
}
export function RunHeader(args: runHeaderProps): React.JSX.Element {
  const selected = useCrowdOSStore(useShallow(function (s) {
    return {
      job: ((s.jobsByRun[args.runId] ?? null) as jobRow | null),
      artifacts: ((s.artifactsByRun[args.runId] ?? NO_ARTIFACTS) as ArtifactRow[]),
      stopRun: s.stopRun,
      cancelling: s.cancellingByAgent,
      setRightPanelView: s.setRightPanelView,
    };
  }));
  const job = selected.job;
  const artifacts = selected.artifacts;
  const stopRun = selected.stopRun;
  const runId = args.runId;
  let stopping = false;
  if (job) {
    const keys = Object.keys(selected.cancelling);
    for (const k of keys) { if (k.indexOf(job.channelId + ':') === 0) { stopping = true; break; } }
  }
  const startedMs = job ? Date.parse(job.firstSeenAt) : NaN;
  const hasLiveElapsed = Number.isFinite(startedMs);
  const nowPair = useState(function () { return Date.now(); });
  const now = nowPair[0];
  const setNow = nowPair[1];
  useEffect(function () {
    if (!hasLiveElapsed) return;
    const id = setInterval(function () { setNow(Date.now()); }, 1000);
    return function () { clearInterval(id); };
  }, [hasLiveElapsed, job ? job.firstSeenAt : null]);
  const elapsedLabel = hasLiveElapsed
    ? formatElapsedMs(Math.max(0, now - (startedMs as number)))
    : formatElapsedMs(job ? job.elapsedMs : null);
  let artifactCost: number | null = null;
  for (const a of artifacts) {
    const meta = a.metadata as { cost?: unknown } | null | undefined;
    if (meta && typeof meta.cost === 'number' && Number.isFinite(meta.cost)) { artifactCost = meta.cost; break; }
  }
  const jobCost = job && typeof job.cost === 'number' && Number.isFinite(job.cost) ? job.cost : null;
  const effectiveCost = jobCost ?? artifactCost;
  const hasCost = typeof effectiveCost === 'number' && Number.isFinite(effectiveCost);
  const costLabel = formatCost(effectiveCost);
  const openTelemetry = function () { selected.setRightPanelView('telemetry'); };
  const status = job ? job.status : "\u2014";
  const shortId = runId.length > 8 ? runId.slice(0, 8) : runId;
  const agentCount = job ? job.agentIds.length : null;
  let terminal = false;
  if (job) { terminal = TERMINAL_RUN_STATUSES.has(job.status.toLowerCase()); }
  const stopCls = stopping
    ? 'bg-zinc-800 border-zinc-700 text-zinc-500 cursor-wait'
    : 'bg-rose-600 hover:bg-rose-500 border-rose-500/20 text-white cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30';
  const stepLabel = job && job.step ? job.step : "\u2014";
  return (
    <div role="status" aria-label={"Active run " + shortId} className="mx-auto max-w-3xl w-full border border-indigo-500/20 bg-indigo-500/[0.06] rounded-xl px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className={"shrink-0 inline-block px-1.5 py-0.5 rounded border text-[10px] font-mono font-medium " + statusTone(status)}>
          {status}
        </span>
        <span className="tnum truncate text-[11px] font-mono text-zinc-200">
          run {shortId}
        </span>
        <span className="tnum shrink-0 text-[11px] font-mono text-zinc-400">
          step {stepLabel}
        </span>
        <span className="tnum shrink-0 text-[11px] font-mono text-zinc-400">
          {elapsedLabel}
        </span>
        {hasCost ? (
          <button
            type="button"
            onClick={openTelemetry}
            title="Open telemetry panel"
            aria-label={'Open telemetry panel: run cost ' + costLabel}
            className="tnum shrink-0 inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400 rounded hover:text-emerald-300 hover:underline hover:underline-offset-2 transition motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
          >
            <Coins size={11} aria-hidden="true" />
            <span>{costLabel}</span>
          </button>
        ) : (
          <span className="tnum shrink-0 text-[11px] font-mono text-zinc-400" title="No ledger row for this run yet" aria-label="Run cost unavailable">
            {costLabel}
          </span>
        )}
        {job && !terminal && (
          <button
            type="button"
            onClick={function () { stopRun(runId); }}
            disabled={stopping}
            aria-label="Stop run"
            className={"ml-auto shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 min-h-[28px] rounded-md border text-[11px] font-mono font-bold transition active:scale-[0.97] " + stopCls}
          >
            <Square size={10} className="fill-white" aria-hidden="true" />
            {stopping ? 'Stopping...' : 'Stop'}
          </button>
        )}
      </div>
      <div className="mt-1.5 truncate text-[10px] font-mono text-zinc-500" aria-label="Run logs tail">
        last status: {status} · {formatTime(job ? job.updatedAt : undefined)}
        {agentCount !== null && agentCount > 0 ? ' · ' + agentCount + ' agent' + (agentCount === 1 ? '' : 's') : ''}
        {' · run ' + shortId}
      </div>
    </div>
  );
}
