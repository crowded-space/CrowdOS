import React from 'react';
import { X } from 'lucide-react';
import type { Agent, ComposerMode, contextBreakdown, writeScope } from '../../types/crowdOs';
import { COMPOSER_MODE_META } from '../../types/crowdOs';
import { contextTooltipText, costHintText, overflowState, shortPath, writeScopeLabel } from './composer-preflight-model';
import { sourceHint, sourceLabel } from './explorer-model';

/** Agent chip shown in the preflight row. */
export interface preflightAgent { agent: Agent; onRemove?: (id: string) => void }

/** Mount segment of the preflight row. */
export interface preflightMount { path: string | null; source: string | null; onOpen: () => void }

export interface ComposerPreflightProps {
  mode: ComposerMode;
  resolvedTo?: string | null;
  pinnedAgents: preflightAgent[];
  mount: preflightMount;
  charCount: number;
  maxChars?: number;
  onOverflowConfirm?: () => void;
  contextPct?: number | null;
  contextBreakdown?: contextBreakdown | null;
  scope?: writeScope | null;
  costHint?: string | null;
}

/**
 * Preflight line above Send (UX_GUIDELINE section 5.2): runtime plus an
 * honest Auto resolved-to slot, removable pinned-agent chips, mount chip
 * with source badge and why-tooltip, context meter, write-scope chip, cost
 * hint, and an overflow guard. Presentational only: no fetch, no DB, no
 * store reads. Unknown values render honest empty and hide their segment.
 */
export function ComposerPreflight(props: ComposerPreflightProps): React.JSX.Element | null {
  const { mode, resolvedTo, pinnedAgents, mount, charCount, maxChars = 4000 } = props;
  const state = overflowState(charCount, maxChars);
  const meta = COMPOSER_MODE_META[mode];
  const resolved = typeof resolvedTo === 'string' ? resolvedTo.trim() : '';
  const runtimeLabel = mode === 'auto' && resolved ? 'Auto - ' + resolved : meta.label;
  const mountShort = shortPath(mount.path);
  const mountWhy = sourceHint(mount.source);
  const mountBadge = sourceLabel(mount.source);
  const showMount = mountShort !== '';
  const pct = typeof props.contextPct === 'number' && Number.isFinite(props.contextPct) ? Math.max(0, Math.min(100, Math.round(props.contextPct))) : null;
  const breakdown = contextTooltipText(props.contextBreakdown);
  const scopeLabel = writeScopeLabel(props.scope);
  const cost = costHintText(props.costHint);
  if (!showMount && pinnedAgents.length === 0 && pct === null && scopeLabel === '' && cost === '' && state !== 'over') return null;
  return (
    <div role="status" aria-label="Send preflight" className="flex flex-wrap items-center gap-1.5 px-4 pt-2.5 text-[11px] font-mono select-none">
      <span className="inline-flex items-center rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-indigo-200" title={mode === 'auto' && !resolved ? 'Router decides at send time' : meta.hint}>
        {runtimeLabel}
      </span>
      {pinnedAgents.map(({ agent, onRemove }) => (
        <span key={agent.id} className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-300" title={agent.name + ' - Tier L' + agent.level}>
          <span className="max-w-[120px] truncate font-medium text-zinc-200">{agent.name}</span>
          <span className="text-zinc-500">L{agent.level}</span>
          {onRemove ? (
            <button type="button" onClick={() => onRemove(agent.id)} aria-label={'Remove ' + agent.name} title={'Remove ' + agent.name} className="rounded p-0.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-rose-400 focus:outline-none cursor-pointer">
              <X size={11} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
      {showMount ? (
        <button type="button" onClick={mount.onOpen} title={mountWhy} aria-label={'Open repository panel: ' + mountShort} className="inline-flex max-w-[220px] items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100 focus:outline-none cursor-pointer">
          <span className="truncate" title={mount.path ?? ''}>{mountShort}</span>
          <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1 text-[10px] text-zinc-500" title={mountWhy}>{mountBadge}</span>
        </button>
      ) : null}
      {pct !== null ? (
        <span role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Context used" title={breakdown || 'Share of context used'} className="inline-flex items-center gap-1.5 text-zinc-400">
          <span aria-hidden="true" className="inline-block h-1 w-14 overflow-hidden rounded bg-zinc-800">
            <span className="block h-full rounded bg-indigo-400" style={{ width: pct + '%' }} />
          </span>
          <span>{pct}%</span>
        </span>
      ) : null}
      {scopeLabel !== '' ? (
        <span className="inline-flex items-center rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-400" title="Allowed write scope for this run">{scopeLabel}</span>
      ) : null}
      {cost !== '' ? (
        <span className="inline-flex items-center rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-zinc-400" title="Estimated cost for this send">{cost}</span>
      ) : null}
      {state === 'over' ? (
        <button type="button" onClick={props.onOverflowConfirm} aria-label="Message exceeds the limit; review before sending" title="Message exceeds the limit; review before sending" className="inline-flex items-center rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 font-medium text-rose-300 transition hover:bg-rose-500/20 focus:outline-none cursor-pointer">
          Over limit
        </button>
      ) : null}
    </div>
  );
}

export default ComposerPreflight;
