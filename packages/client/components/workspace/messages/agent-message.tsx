import { useState, useEffect } from 'react';
import { Eye, EyeOff, Brain, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import MentionParser from './mention-parser';
import AttachmentsView from './attachments-view';
import ToolExecutionMessage from './tool-execution-message';
import { AgentLevel, Attachment, AgentTurnStep, AgentTurnStatus } from '@/types/crowd-os';
import { useCrowdOSStore } from '@/stores/crowd-os-store';

interface AgentMessageProps {
  id?: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, any>;
  level?: AgentLevel;
  attachments?: Attachment[];
  turnSteps?: AgentTurnStep[];
  turnStatus?: AgentTurnStatus;
}

export default function AgentMessage({
  id,
  authorId,
  authorName,
  authorAvatar = '🤖',
  content,
  timestamp,
  metadata,
  level = 3,
  attachments,
  turnSteps,
  turnStatus
}: AgentMessageProps) {
  const isStreaming = id?.startsWith('stream-');
  const [monologueExpanded, setMonologueExpanded] = useState(isStreaming);
  const { openAgentProfileModal } = useCrowdOSStore();
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  useEffect(() => {
    if (isStreaming && (metadata?.monologue || turnSteps?.some(s => s.type === 'reasoning'))) {
      setMonologueExpanded(true);
    }
  }, [isStreaming, metadata?.monologue, turnSteps]);

  // Level roles styling
  const levelMeta = {
    0: { label: 'L0 Omniscient', border: 'border-cyan-500/50', badgeBg: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' },
    1: { label: 'L1 Admin', border: 'border-rose-500/50', badgeBg: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
    2: { label: 'L2 Coordinator', border: 'border-indigo-500/50', badgeBg: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30' },
    3: { label: 'L3 Worker', border: 'border-emerald-500/50', badgeBg: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' }
  }[level] || { label: 'L3 Worker', border: 'border-zinc-700', badgeBg: 'bg-zinc-800 text-zinc-300 border-zinc-700' };

  const hasMonologue = !!metadata?.monologue;

  return (
    <div 
      id={`agent-message-${authorId}`}
      className={`group flex gap-3 p-4 bg-zinc-900/40 border rounded-lg hover:bg-zinc-900/70 transition ${
        isStreaming ? 'border-indigo-500/40 shadow-[0_0_15px_rgba(99,102,241,0.08)]' : 'border-zinc-800/60'
      }`}
    >
      {/* Level-themed avatar border */}
      <button 
        type="button"
        onClick={() => openAgentProfileModal(authorId)}
        className={`flex items-center justify-center w-8 h-8 rounded-full border ${levelMeta.border} bg-zinc-950 text-sm select-none hover:opacity-80 hover:scale-105 active:scale-95 transition cursor-pointer focus:outline-none shrink-0 mt-0.5`}
        title={`View Profile of ${authorName}`}
      >
        {authorAvatar}
      </button>

      <div className="flex-1 min-w-0 space-y-2">
        {/* Header Header Info Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openAgentProfileModal(authorId)}
              className="font-semibold text-zinc-100 text-sm tracking-tight truncate hover:text-indigo-400/90 transition cursor-pointer focus:outline-none text-left"
              title={`View Profile of ${authorName}`}
            >
              {authorName}
            </button>
            <span 
              onClick={() => openAgentProfileModal(authorId)}
              className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border ${levelMeta.badgeBg} cursor-pointer hover:opacity-85 transition`}
            >
              {levelMeta.label}
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">
              {timeStr}
            </span>
          </div>

          {/* Streaming or Turn Status Pill */}
          {isStreaming && (
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-[10px] font-mono text-indigo-400 animate-pulse select-none">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping" />
              <span>AGENT PROCESSING...</span>
            </div>
          )}

          {turnStatus === 'failed' && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-[10px] font-mono text-rose-400 select-none">
              <AlertCircle size={10} />
              <span>TURN FAILED</span>
            </div>
          )}
        </div>

        {/* Dynamic Monologue / Reasoning block */}
        {hasMonologue && (
          <div className="border border-indigo-500/15 bg-indigo-500/[0.02] rounded-md p-2.5 space-y-1.5">
            <button 
              onClick={() => setMonologueExpanded(!monologueExpanded)}
              className="flex items-center justify-between w-full text-[10px] text-indigo-400 font-mono hover:text-indigo-300 transition focus:outline-none select-none"
            >
              <div className="flex items-center gap-1.5">
                <Brain size={12} className="text-indigo-400" />
                <span>{monologueExpanded ? 'HIDE INTERNAL MONOLOGUE' : 'SHOW INTERNAL MONOLOGUE'}</span>
              </div>
              <span className="text-[9px] text-zinc-550 font-mono">
                {metadata.monologue.length} chars
              </span>
            </button>
            {monologueExpanded && (
              <div className="text-xs text-zinc-300 leading-relaxed border-t border-indigo-500/10 pt-2 pl-2.5 border-l-2 border-indigo-500/30 font-sans">
                <MentionParser text={metadata.monologue} />
              </div>
            )}
          </div>
        )}

        {/* Render Inline Turn Steps if populated */}
        {turnSteps && turnSteps.length > 0 && (
          <div className="space-y-2">
            {turnSteps.map((step) => {
              if (step.type === 'tool_call' && step.toolExecution) {
                return (
                  <ToolExecutionMessage 
                    key={step.id} 
                    toolExecution={step.toolExecution} 
                    timestamp={step.timestamp || timestamp} 
                  />
                );
              }
              return null;
            })}
          </div>
        )}

        {/* Main Response Content */}
        {content ? (
          <div className="text-sm text-zinc-300 leading-relaxed font-sans select-text">
            <MentionParser text={content} />
          </div>
        ) : (
          isStreaming && !hasMonologue && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono animate-pulse py-1">
              <Sparkles size={12} className="text-indigo-400" />
              <span>Generating response...</span>
            </div>
          )
        )}

        {/* Render Attachments */}
        <AttachmentsView attachments={attachments} />
      </div>
    </div>
  );
}
