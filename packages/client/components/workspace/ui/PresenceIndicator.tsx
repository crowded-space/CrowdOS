import { AgentStatus } from '@/types/crowdOs';

interface PresenceIndicatorProps {
  status: AgentStatus;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

export default function PresenceIndicator({ 
  status, 
  size = 'md', 
  showLabel = false 
}: PresenceIndicatorProps) {
  
  // Custom OKLCH variables mapping to agent states
  const statusColors: Record<AgentStatus, string> = {
    active: 'bg-[oklch(0.65_0.18_145)] shadow-[0_0_8px_oklch(0.65_0.18_145/0.4)]', // jade
    idle: 'bg-[oklch(0.55_0.08_90)]', // amber
    thinking: 'bg-[oklch(0.62_0.15_250)] animate-pulse shadow-[0_0_10px_oklch(0.62_0.15_250/0.5)]', // indigo
    delegating: 'bg-[oklch(0.60_0.15_290)] shadow-[0_0_8px_oklch(0.60_0.15_290/0.4)]', // purple
    executing: 'bg-[oklch(0.60_0.12_200)] shadow-[0_0_8px_oklch(0.60_0.12_200/0.4)]', // teal
    working: 'bg-[oklch(0.60_0.12_200)] animate-pulse shadow-[0_0_8px_oklch(0.60_0.12_200/0.4)]',
    paused: 'bg-[oklch(0.55_0.08_90)]',
    offline: 'bg-zinc-500',
    sleeping: 'bg-zinc-500' // gray
  };

  const sizes = {
    sm: 'w-2.5 h-2.5',
    md: 'w-3.5 h-3.5 ring-2 ring-zinc-950',
    lg: 'w-4 h-4 ring-2 ring-zinc-950'
  };

  return (
    <div className="flex items-center gap-1.5" id={`presence-${status}-${size}`}>
      <span 
        className={`rounded-full inline-block transition-transform duration-300 ${sizes[size]} ${statusColors[status]}`}
        title={`Status: ${status}`}
      />
      {showLabel && (
        <span className="text-xs font-mono capitalize tracking-tight text-zinc-400">
          {status}
        </span>
      )}
    </div>
  );
}
