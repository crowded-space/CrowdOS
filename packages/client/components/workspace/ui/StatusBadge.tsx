import { AgentStatus } from '@/types/crowdOs';

interface StatusBadgeProps {
  status: AgentStatus;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const styles: Record<AgentStatus, { bg: string; text: string; dot: string }> = {
    active: {
      bg: 'bg-[oklch(0.65_0.18_145/0.12)] border-[oklch(0.65_0.18_145/0.2)]',
      text: 'text-[oklch(0.65_0.18_145)]',
      dot: 'bg-[oklch(0.65_0.18_145)]'
    },
    idle: {
      bg: 'bg-[oklch(0.55_0.08_90/0.12)] border-[oklch(0.55_0.08_90/0.2)]',
      text: 'text-[oklch(0.55_0.08_90)]',
      dot: 'bg-[oklch(0.55_0.08_90)]'
    },
    thinking: {
      bg: 'bg-[oklch(0.62_0.15_250/0.12)] border-[oklch(0.62_0.15_250/0.2)]',
      text: 'text-[oklch(0.62_0.15_250)] animate-pulse',
      dot: 'bg-[oklch(0.62_0.15_250)] animate-pulse'
    },
    delegating: {
      bg: 'bg-[oklch(0.60_0.15_290/0.12)] border-[oklch(0.60_0.15_290/0.2)]',
      text: 'text-[oklch(0.60_0.15_290)]',
      dot: 'bg-[oklch(0.60_0.15_290)]'
    },
    executing: {
      bg: 'bg-[oklch(0.60_0.12_200/0.12)] border-[oklch(0.60_0.12_200/0.2)]',
      text: 'text-[oklch(0.60_0.12_200)]',
      dot: 'bg-[oklch(0.60_0.12_200)]'
    },
    working: {
      bg: 'bg-[oklch(0.60_0.12_200/0.12)] border-[oklch(0.60_0.12_200/0.2)]',
      text: 'text-[oklch(0.60_0.12_200)] animate-pulse',
      dot: 'bg-[oklch(0.60_0.12_200)] animate-pulse'
    },
    paused: {
      bg: 'bg-[oklch(0.55_0.08_90/0.12)] border-[oklch(0.55_0.08_90/0.2)]',
      text: 'text-[oklch(0.55_0.08_90)]',
      dot: 'bg-[oklch(0.55_0.08_90)]'
    },
    offline: {
      bg: 'bg-zinc-800/60 border-zinc-700/50',
      text: 'text-zinc-400',
      dot: 'bg-zinc-500'
    },
    sleeping: {
      bg: 'bg-zinc-800/60 border-zinc-700/50',
      text: 'text-zinc-400',
      dot: 'bg-zinc-500'
    }
  };

  const current = styles[status] || styles.idle;

  return (
    <span 
      id={`status-badge-${status}`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-mono tracking-tight font-medium ${current.bg} ${current.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${current.dot}`} />
      <span className="capitalize">{status}</span>
    </span>
  );
}
