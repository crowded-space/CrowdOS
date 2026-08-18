import MentionParser from './mention-parser';
import AttachmentsView from './attachments-view';
import { Attachment } from '@/types/crowd-os';

interface HumanMessageProps {
  authorName: string;
  content: string;
  timestamp: string;
  attachments?: Attachment[];
  mentions?: string[];
}

export default function HumanMessage({ authorName, content, timestamp, attachments, mentions }: HumanMessageProps) {
  // Format nice time
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <div 
      id={`human-message-${authorName}`}
      className="group flex gap-4 p-4 border-l-4 border-amber-500 bg-amber-500/5 rounded-r-lg hover:bg-amber-500/[0.08] transition"
    >
      <div className="flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-amber-200 tracking-tight text-sm">
            {authorName}
          </span>
          <span className="text-[10px] font-mono uppercase bg-amber-500/15 text-amber-300 px-1 rounded">
            Human Operator
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">
            {timeStr}
          </span>
        </div>
        <div className="text-sm text-zinc-200 leading-relaxed font-sans mt-1">
          <MentionParser text={content} />
        </div>
        
        {/* Render Attachments */}
        <AttachmentsView attachments={attachments} />
      </div>
    </div>
  );
}
