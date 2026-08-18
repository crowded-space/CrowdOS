import { Terminal } from 'lucide-react';

interface SystemMessageProps {
  content: string;
  timestamp: string;
}

export default function SystemMessage({ content, timestamp }: SystemMessageProps) {
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <div 
      id="system-message"
      className="flex items-center justify-center gap-2 py-2 px-4 bg-zinc-950/45 border border-zinc-900/80 rounded-md max-w-2xl mx-auto my-1 select-none"
    >
      <Terminal size={12} className="text-zinc-500 shrink-0" />
      <span className="text-xs font-mono text-zinc-400 text-center leading-normal">
        {content}
      </span>
      <span className="text-[9px] font-mono text-zinc-650 ml-auto pl-2">
        {timeStr}
      </span>
    </div>
  );
}
