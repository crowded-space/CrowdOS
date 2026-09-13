import React from 'react';
import { Message, AgentLevel } from '@/types/crowdOs';
import HumanMessage from './HumanMessage';
import AgentMessage from './AgentMessage';
import SystemMessage from './SystemMessage';
import DelegationMessage from './DelegationMessage';
import ToolExecutionMessage from './ToolExecutionMessage';
import { ShieldAlert, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface MessageRouterProps {
  message: Message;
  agentLevel?: AgentLevel;
  key?: string;
  toolExecutions?: import('@/types/crowdOs').ToolExecution[];
}

export function MessageRouter({ message, agentLevel = 3, toolExecutions }: MessageRouterProps) {
  switch (message.type) {
    case 'human':
      return (
        <HumanMessage 
          id={message.id}
          authorName={message.authorName} 
          content={message.content} 
          timestamp={message.timestamp} 
          attachments={message.attachments}
          mentions={message.mentions}
        />
      );
      
    case 'agent':
      return (
        <AgentMessage 
          id={message.id}
          authorId={message.authorId}
          authorName={message.authorName}
          authorAvatar={message.authorAvatar}
          content={message.content}
          timestamp={message.timestamp}
          metadata={message.metadata}
          level={agentLevel}
          attachments={message.attachments}
          turnSteps={message.turnSteps}
          turnStatus={message.turnStatus}
          toolExecutions={toolExecutions}
        />
      );
      
    case 'system':
      return (
        <SystemMessage 
          content={message.content} 
          timestamp={message.timestamp} 
        />
      );

    case 'delegation':
      return (
        <DelegationMessage 
          delegationInfo={message.delegationInfo} 
          timestamp={message.timestamp} 
        />
      );

    case 'tool_execution':
      return (
        <ToolExecutionMessage 
          toolExecution={message.toolExecution} 
          timestamp={message.timestamp} 
        />
      );

    case 'governance':
      const subtype = message.metadata?.subtype;

      if (subtype === 'strike') {
        const count = message.metadata?.strikeCount || 1;
        const max = message.metadata?.maxStrikes || 3;
        
        return (
          <div 
            id="strike-warning"
            className="max-w-xl mx-auto border border-amber-500/25 bg-amber-500/[0.02] p-3.5 rounded-lg my-3 font-mono text-xs text-amber-300 animate-pulse shadow-md"
          >
            <div className="flex items-center gap-2 mb-1.5 text-amber-450 font-bold tracking-wide select-none">
              <ShieldAlert size={14} className="shrink-0 text-amber-450 animate-bounce" />
              <span>SWARM SAFETY STRIKE INITIATED</span>
            </div>
            
            <div className="flex items-center gap-2 my-2 select-none">
              <div className="flex gap-1">
                {Array.from({ length: max }).map((_, i) => (
                  <span 
                    key={i} 
                    className={`w-4 h-2.5 rounded-xs border ${
                      i < count 
                        ? 'bg-amber-500 border-amber-600 shadow-[0_0_4px_#f59e0b]' 
                        : 'bg-zinc-950 border-zinc-800'
                    }`} 
                  />
                ))}
              </div>
              <span className="text-[10px] text-zinc-550 font-bold ml-1">STRIKE {count} OF {max} RECORDED</span>
            </div>

            <p className="leading-relaxed text-zinc-300 font-sans pl-0 mt-1 select-text">
              <strong>Agent Exception:</strong> {message.content}
            </p>
            <div className="text-right text-[8.5px] text-zinc-650 mt-2 select-none">
              AUDITED AT {new Date(message.timestamp).toLocaleTimeString()}
            </div>
          </div>
        );
      }

      if (subtype === 'parliament') {
        const votes = (message.metadata?.votes || {}) as Record<string, 'approve' | 'reject' | 'pending'>;
        const status = message.metadata?.status || 'voting';
        const topic = message.metadata?.topic || message.content;
        
        const totalVotes = Object.keys(votes).length;
        const approveCount = Object.values(votes).filter(v => v === 'approve').length;
        const rejectCount = Object.values(votes).filter(v => v === 'reject').length;
        const approvePercent = totalVotes > 0 ? (approveCount / totalVotes) * 100 : 0;
        const rejectPercent = totalVotes > 0 ? (rejectCount / totalVotes) * 100 : 0;

        return (
          <div 
            id="parliament-panel"
            className="max-w-xl mx-auto border border-indigo-500/20 bg-zinc-950/40 p-4 rounded-lg my-3 font-sans text-xs text-zinc-300 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-indigo-950/30 pb-2 mb-2 select-none">
              <span className="font-bold text-zinc-300 font-mono text-[10px] tracking-widest uppercase flex items-center gap-1.5">
                🏛️ Swarm Parliament Consensus
              </span>
              <span className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase ${
                status === 'approved' 
                  ? 'bg-teal-500/10 text-teal-400 border border-teal-500/20' 
                  : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 animate-pulse'
              }`}>
                {status}
              </span>
            </div>

            <p className="leading-relaxed text-zinc-200 font-medium text-xs mb-3 select-text">
              {topic}
            </p>

            {/* Voting Visual Bars */}
            <div className="space-y-1.5 mb-3.5 select-none">
              <div className="flex justify-between text-[9px] font-mono text-zinc-550 font-bold uppercase">
                <span>APPROVE ({approveCount})</span>
                <span>REJECT ({rejectCount})</span>
              </div>
              <div className="w-full h-2 rounded bg-zinc-900 overflow-hidden flex">
                <div 
                  className="bg-teal-500 shadow-[0_0_4px_#14b8a6] transition-all duration-500" 
                  style={{ width: `${approvePercent}%` }} 
                />
                <div 
                  className="bg-rose-500 shadow-[0_0_4px_#f43f5e] transition-all duration-500" 
                  style={{ width: `${rejectPercent}%` }} 
                />
              </div>
            </div>

            {/* Voters List */}
            <div className="space-y-2 border-t border-zinc-900/60 pt-3">
              <span className="text-[9px] font-mono font-bold text-zinc-650 uppercase tracking-wide block select-none">
                Consensus Ballots:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {Object.entries(votes).map(([voterName, vote]) => (
                  <div 
                    key={voterName}
                    className={`p-2 rounded border flex items-center justify-between gap-2 font-mono text-[10px] ${
                      vote === 'approve' 
                        ? 'bg-teal-500/5 border-teal-500/20 text-teal-400' 
                        : vote === 'reject'
                        ? 'bg-rose-500/5 border-rose-500/20 text-rose-400'
                        : 'bg-zinc-900/40 border-zinc-850 text-zinc-500'
                    }`}
                  >
                    <span className="truncate font-semibold">{voterName}</span>
                    <span className="shrink-0 flex items-center">
                      {vote === 'approve' ? (
                        <CheckCircle2 size={11} className="text-teal-400 shadow-sm" />
                      ) : vote === 'reject' ? (
                        <XCircle size={11} className="text-rose-450" />
                      ) : (
                        <Loader2 size={10} className="text-zinc-600 animate-spin" />
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="text-right text-[8.5px] text-zinc-650 mt-3 select-none border-t border-zinc-900/20 pt-1.5">
              CONVENED AT {new Date(message.timestamp).toLocaleTimeString()}
            </div>
          </div>
        );
      }

      // Render a special safe-audit warning alert for general escalations
      return (
        <div 
          id="governance-alert"
          className="max-w-xl mx-auto border border-rose-500/25 bg-rose-500/[0.03] p-3 rounded-lg my-2 font-mono text-xs text-rose-300"
        >
          <div className="flex items-center gap-2 mb-1 text-rose-400 font-bold tracking-wide select-none">
            <ShieldAlert size={14} className="shrink-0 animate-bounce" />
            <span>SWARM GOVERNANCE EXCEPTION</span>
          </div>
          <p className="leading-relaxed text-zinc-300 font-sans pl-6 select-text">
            {message.content}
          </p>
          <div className="text-right text-[9px] text-zinc-500 mt-2 select-none">
            AUDITED AT {new Date(message.timestamp).toLocaleTimeString()}
          </div>
        </div>
      );

    default:
      return null;
  }
}

// Memoized: message objects come from the store with stable references, so
// composer keystrokes / unrelated store updates skip re-rendering history.
export default React.memo(MessageRouter);
