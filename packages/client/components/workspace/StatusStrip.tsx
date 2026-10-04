import { useEffect, useState } from 'react';
import { Clock, Coins, Cpu, FolderGit2, Gauge, Pin, TriangleAlert } from 'lucide-react';
import type { ComposerMode } from '../../types/crowdOs';
import { COMPOSER_MODE_META } from '../../types/crowdOs';

/** Mount segment of the status strip (strings precomputed by the parent). */
export interface statusStripMount { shortPath: string; sourceLabel: string; sourceHint: string; onOpen: () => void }

/** One degraded/offline dot (text + hint, never color-only). */
export interface statusStripDegradedDot { id: string; label: string; hint: string; onOpen?: () => void }

export interface statusStripProps {
  runtime: ComposerMode | string;
  runtimeHint?: string | null;
  pinned: boolean;
  mount: statusStripMount | null;
  contextPct?: number | null;
  onContextOpen?: () => void;
  tokens?: number | null;
  runCost?: string | null;
  onCostOpen?: () => void;
  elapsedMs?: number | null;
  runStartedAt?: string | null;
  degradedDots?: statusStripDegradedDot[];
  onDegradedOpen?: () => void;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return minutes + 'm ' + (totalSeconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

/**
 * Status strip (Phase D): thin run-status line adjacent the composer.
 * Presentational only (props in, no store reads, no fetch) — like
 * ComposerPreflight. DECISION: no store stripSnapshot slice exists on
 * purpose; MainChatArea already owns mountScope/mode and passes real
 * values (or null) as props, so a stored snapshot would be a second
 * model of the same state. Unknown values hide their segment (honest
 * empty); the strip returns null when nothing is known. Every navigable
 * segment is a real button to its source view (mount to repo,
 * context/cost to telemetry, degraded to settings/telemetry); the
 * runtime segment is status text for the composer ModeSelector. Elapsed
 * ticks locally at 1/s and only when a start time is provided; the
 * strip is never modal.
 */
export function StatusStrip(props: statusStripProps): React.JSX.Element | null {
  const { runtime, runtimeHint, pinned, mount, contextPct, onContextOpen, tokens, runCost, onCostOpen, elapsedMs, runStartedAt, degradedDots, onDegradedOpen } = props;
  const meta = (COMPOSER_MODE_META as Record<string, { label: string; hint: string }>)[String(runtime)];
  const runtimeLabel = meta ? meta.label : String(runtime);
  const runtimeTitle = typeof runtimeHint === 'string' && runtimeHint.trim() !== '' ? runtimeHint : (meta ? meta.hint : runtimeLabel);
  const pct = typeof contextPct === 'number' && Number.isFinite(contextPct) ? Math.max(0, Math.min(100, Math.round(contextPct))) : null;
  const costText = typeof runCost === 'string' ? runCost.trim() : '';
  const tokenText = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens.toLocaleString() : '';
  const showCost = costText !== '' || tokenText !== '';
  const costLabel = [tokenText !== '' ? tokenText + ' tok' : '', costText].filter(Boolean).join(' \u00b7 ');
  const startedMs = typeof runStartedAt === 'string' ? Date.parse(runStartedAt) : NaN;
  const hasLiveElapsed = Number.isFinite(startedMs);
  const hasStaticElapsed = !hasLiveElapsed && typeof elapsedMs === 'number' && Number.isFinite(elapsedMs);
  const showElapsed = hasLiveElapsed || hasStaticElapsed;
  const [now, setNow] = useState(function () { return Date.now(); });
  useEffect(function () {
    if (!hasLiveElapsed) return;
    const id = setInterval(function () { setNow(Date.now()); }, 1000);
    return function () { clearInterval(id); };
  }, [hasLiveElapsed, runStartedAt]);
  const elapsedLabel = hasLiveElapsed ? formatElapsed(Math.max(0, now - (startedMs as number))) : (hasStaticElapsed ? formatElapsed(elapsedMs as number) : '');
  const dots = Array.isArray(degradedDots) ? degradedDots.filter(function (d) { return d && typeof d.id === 'string' && typeof d.label === 'string'; }) : [];
  const showMount = !!mount && typeof mount.shortPath === 'string' && mount.shortPath !== '';
  if (!runtimeLabel && !showMount && pct === null && !showCost && !showElapsed && dots.length === 0) return null;
  return (
    <div role="status" aria-label="Run status" className="flex flex-wrap items-center gap-1.5 px-4 pt-2 text-[11px] font-mono select-none">
      <span className="inline-flex items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-indigo-200" title={runtimeTitle} aria-label={'Runtime ' + runtimeLabel + (pinned ? ', pinned' : '')}>
        <Cpu size={11} aria-hidden="true" />
        {runtimeLabel}
        {pinned ? (<span className="inline-flex items-center gap-0.5 text-indigo-300"><Pin size={11} aria-hidden="true" />pinned</span>) : null}
      </span>
      {showMount ? (
        <button type="button" onClick={mount!.onOpen} title={mount!.sourceHint} aria-label={'Open repository panel: ' + mount!.shortPath} className="inline-flex max-w-[220px] items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100 focus:outline-none cursor-pointer">
          <FolderGit2 size={11} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{mount!.shortPath}</span>
          <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1 text-[10px] text-zinc-500">{mount!.sourceLabel}</span>
        </button>
      ) : null}
      {pct !== null ? (
        <button type="button" onClick={onContextOpen} title="Open telemetry panel" aria-label={'Open telemetry panel: context ' + pct + ' percent'} className="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100 focus:outline-none cursor-pointer">
          <Gauge size={11} aria-hidden="true" />
          <span role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Context used" className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-1 w-14 overflow-hidden rounded bg-zinc-800">
              <span className="block h-full rounded bg-indigo-400" style={{ width: pct + '%' }} />
            </span>
            <span>{pct}%</span>
          </span>
        </button>
      ) : null}
      {showCost ? (
        <button type="button" onClick={onCostOpen} title="Open telemetry panel" aria-label={'Open telemetry panel: ' + costLabel} className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100 focus:outline-none cursor-pointer">
          <Coins size={11} aria-hidden="true" />
          {costLabel}
        </button>
      ) : null}
      {showElapsed ? (
        <span className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-400" title="Elapsed run time" aria-label={'Elapsed ' + elapsedLabel}>
          <Clock size={11} aria-hidden="true" />
          {elapsedLabel}
        </span>
      ) : null}
      {dots.length > 0 ? (
        <span className="inline-flex items-center gap-1">
          {dots.map(function (d) {
            const open = d.onOpen || onDegradedOpen;
            return (
              <button key={d.id} type="button" onClick={open} title={d.hint || d.label} aria-label={d.label + (d.hint ? ': ' + d.hint : '')} className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-amber-300 transition hover:bg-amber-500/15 focus:outline-none cursor-pointer">
                <TriangleAlert size={11} aria-hidden="true" />
                {d.label}
              </button>
            );
          })}
        </span>
      ) : null}
    </div>
  );
}

export default StatusStrip;
