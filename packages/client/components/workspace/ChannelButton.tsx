import React, { useCallback } from 'react';
import { Hash } from 'lucide-react';
import type { Channel } from '@/types/crowdOs';

interface Props {
  channel: Channel;
  isActive: boolean;
  onSelect: (id: string) => void;
}

function ChannelButtonInner({ channel, isActive, onSelect }: Props) {
  const handleClick = useCallback(() => onSelect(channel.id), [onSelect, channel.id]);
  const hasMention = channel.hasMention;
  const unreads = channel.unreadCount;
  return (
    <button
      onClick={handleClick}
      aria-current={isActive ? 'page' : undefined}
      className={`relative w-full group flex items-center justify-between px-2.5 py-2.5 min-h-[42px] rounded-xl text-[13.5px] font-medium tracking-[-0.01em] text-left transition-all select-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 touch-manipulation active:scale-[0.99] ${
        isActive
          ? 'bg-[#1e1e22] text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] border border-white/[0.06]'
          : 'text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200 border border-transparent'
      }`}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.5)]" aria-hidden="true" />
      )}
      <div className="flex items-center gap-2.5 min-w-0 truncate pl-1">
        <Hash size={16} className={`shrink-0 transition-colors ${isActive ? 'text-indigo-300' : 'text-zinc-500 group-hover:text-zinc-400'}`} />
        <span className={`truncate ${isActive ? 'text-zinc-100 font-semibold' : ''}`}>{channel.name}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 pl-2">
        {hasMention && <span className="w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(239,68,68,0.5)] animate-pulse" />}
        {unreads > 0 && (
          <span className="px-1.5 py-0.5 min-w-[20px] h-[19px] flex items-center justify-center text-center rounded-full bg-rose-500 text-[10px] font-mono font-bold text-white leading-none">
            {unreads > 99 ? '99+' : unreads}
          </span>
        )}
      </div>
    </button>
  );
}

export const ChannelButton = React.memo(ChannelButtonInner);
export default ChannelButton;
