import React, { useCallback } from 'react';
import PresenceIndicator from './ui/presence-indicator';

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
}

function AgentRowInner({ id, name, species, status, level, avatar, isOmniscient, onOpen }: Props) {
  const meta = levelStyles[level] || { text: 'text-zinc-400', bg: 'bg-zinc-800', border: 'border-zinc-700' };
  const handleClick = useCallback(() => onOpen(id), [onOpen, id]);
  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center gap-3 px-2.5 py-2.5 min-h-[52px] hover:bg-zinc-900/60 active:bg-zinc-900 rounded-xl transition-colors text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 border border-transparent hover:border-zinc-800/60 touch-manipulation active:scale-[0.99]"
      id={`agent-row-${id}`}
    >
      <div className={`relative w-9 h-9 rounded-xl flex items-center justify-center bg-zinc-950 border ${meta.border} select-none text-[15px] font-sans shrink-0 shadow-sm`}>
        {avatar || '🤖'}
        <div className="absolute -bottom-1 -right-1 bg-[#0c0c0e] rounded-full p-0.5">
          <PresenceIndicator status={status as any} size="sm" />
        </div>
      </div>
      <div className="min-w-0 leading-snug flex-1">
        <div className="text-[13px] font-semibold text-zinc-100 truncate flex items-center gap-1.5 font-sans tracking-[-0.01em]">
          <span className={`${meta.text}`}>{name}</span>
          {isOmniscient && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-extrabold font-mono bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 tracking-tight leading-none">👁️ OMNI</span>
          )}
        </div>
        <div className="text-[11px] text-zinc-500 font-sans flex items-center gap-1.5">
          <span>{species}</span>
          <span className="w-1 h-1 rounded-full bg-zinc-700" />
          <span className="font-mono text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400">L{level}</span>
        </div>
      </div>
    </button>
  );
}

export const AgentRow = React.memo(AgentRowInner);
export default AgentRow;
