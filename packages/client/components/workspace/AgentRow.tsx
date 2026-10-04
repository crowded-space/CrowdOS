import React, { useCallback, useEffect, useState } from 'react';
import { Bot, Square } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import PresenceIndicator from './ui/PresenceIndicator';

const levelStyles: Record<number, { text: string; bg: string; border: string }> = {
  0: { text: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/25' },
  1: { text: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/25' },
  2: { text: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/25' },
  3: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' },
};

interface Props {
  id: string;
  name: string;
  species: string;
  status: string;
  level: number;
  avatar?: string;
  isOmniscient?: boolean;
  onOpen: (id: string) => void;
  runId?: string | null;
  elapsedMs?: number | null;
  cost?: number | null;
  liveSince?: string | null;
  live?: boolean;
  stopping?: boolean;
  canStop?: boolean;
  onStop?: (runId: string) => void;
}

function formatElapsedMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return minutes + 'm ' + (totalSeconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

function formatCost(cost: number | null | undefined): string {
  return typeof cost === 'number' ? '$' + cost.toFixed(4) : '—';
}

function AgentRowInner({ id, name, species, status, level, avatar, isOmniscient, onOpen, runId, elapsedMs, cost, liveSince, live, stopping, canStop, onStop }: Props) {
  const meta = levelStyles[level] || { text: 'text-zinc-400', bg: 'bg-zinc-800', border: 'border-zinc-700' };
  const reduceMotion = useReducedMotion();
  const handleClick = useCallback(() => onOpen(id), [onOpen, id]);
  const handleStop = useCallback(() => {
    if (runId && onStop) onStop(runId);
  }, [runId, onStop]);
  // Live tick: elapsed counts up from the run's first-seen wall clock while
  // the run is non-terminal, static snapshot otherwise (unknown renders a
  // dash, never a zero). Frozen under prefers-reduced-motion, never a live
  // region so the 1s tick stays screen-reader silent, and never pulsing.
  const startedMs = liveSince ? Date.parse(liveSince) : NaN;
  const ticking = live === true && !reduceMotion && Number.isFinite(startedMs);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, liveSince]);
  const elapsedLabel = ticking
    ? formatElapsedMs(Math.max(0, nowMs - (startedMs as number)))
    : formatElapsedMs(elapsedMs ?? null);
  const costLabel = formatCost(cost ?? null);
  const showStop = canStop === true && typeof onStop === 'function' && typeof runId === 'string' && runId !== '';
  const stopCls = stopping
    ? 'bg-zinc-800 border-zinc-700 text-zinc-500 cursor-wait'
    : 'bg-rose-600 hover:bg-rose-500 border-rose-500/20 text-white cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30';
  return (
    <div
      id={`agent-row-${id}`}
      className="w-full flex items-center gap-2 px-2.5 py-2.5 min-h-[52px] hover:bg-zinc-900/60 rounded-xl transition-colors border border-transparent hover:border-zinc-800/60"
    >
      <button
        onClick={handleClick}
        aria-label={`Open profile for ${name}`}
        className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 rounded-lg active:scale-[0.99]"
      >
        <div className={`relative w-9 h-9 rounded-lg flex items-center justify-center bg-zinc-950 border ${meta.border} select-none text-[15px] font-sans shrink-0 shadow-sm`}>
          {avatar || <Bot size={16} className="text-zinc-500" aria-hidden="true" />}
          <div className="absolute bottom-0 right-0 bg-[#0c0c0e] rounded-full p-0.5" aria-hidden="true">
            <PresenceIndicator status={status as any} size="sm" />
          </div>
        </div>
        <div className="min-w-0 leading-snug flex-1">
          <div className="text-[13px] font-semibold text-zinc-100 truncate whitespace-nowrap flex items-center gap-2 font-sans tracking-[-0.01em]">
            <span className={`${meta.text} whitespace-nowrap`}>{name}</span>
            {isOmniscient && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold font-mono bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 tracking-tight leading-none">Omni</span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500 font-sans flex items-center gap-1.5">
            <span>{species}</span>
            <span className="w-1 h-1 rounded-full bg-zinc-700" />
            <span className="tnum font-mono text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">L{level}</span>
          </div>
        </div>
      </button>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span
          className="tnum text-[10px] font-mono text-zinc-400 whitespace-nowrap"
          title={runId ? `Run ${runId}` : 'No run observed for this agent yet'}
          aria-label={`Run time ${elapsedLabel}, cost ${costLabel}`}
        >
          {elapsedLabel} · {costLabel}
        </span>
        {showStop && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            aria-label={`Stop run for ${name}`}
            className={'shrink-0 inline-flex items-center gap-1 px-2 py-1 min-h-[28px] rounded-md border text-[10px] font-mono font-bold transition active:scale-[0.97] ' + stopCls}
          >
            <Square size={9} className="fill-white" aria-hidden="true" />
            {stopping ? 'Stopping...' : 'Stop'}
          </button>
        )}
      </div>
    </div>
  );
}

export const AgentRow = React.memo(AgentRowInner);
export default AgentRow;
