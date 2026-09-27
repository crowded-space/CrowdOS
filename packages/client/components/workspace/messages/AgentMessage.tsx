import { useState, useEffect, useMemo } from 'react';
import { Brain, Sparkles, AlertCircle, Wrench, ChevronDown, ChevronUp, Square, RotateCcw, RefreshCw } from 'lucide-react';
import MentionParser from './MentionParser';
import AttachmentsView from './AttachmentsView';
import ToolExecutionMessage from './ToolExecutionMessage';
import { AgentLevel, Attachment, AgentTurnStep, AgentTurnStatus, ToolExecution } from '@/types/crowdOs';
import { useCrowdOSStore } from '@/stores/crowdOsStore';

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
  toolExecutions?: ToolExecution[];
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
  turnStatus,
  toolExecutions
}: AgentMessageProps) {
  const isStreaming = id?.startsWith('stream-');
  const isCancelled = turnStatus === 'cancelled' || (metadata as any)?.cancelled === true || (metadata as any)?.status === 'cancelled';
  const [monologueExpanded, setMonologueExpanded] = useState(isStreaming);
  const { openAgentProfileModal, activeChannelId, cancellingByAgent, cancelRun, regenerate, retryRun } = useCrowdOSStore();
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const canRegenerate = !!id && !isStreaming;
  const canRetry = turnStatus === 'failed' || isCancelled || (metadata as any)?.status === 'failed' || (metadata as any)?.status === 'cancelled';
  const runtimeBadge = (metadata as any)?.runtimeType || (metadata as any)?.runtime || (metadata as any)?.runId ? String((metadata as any)?.runtimeType || (metadata as any)?.runtime || '').toLowerCase() : null;
  const runtimeLabel = runtimeBadge ? runtimeBadge.charAt(0).toUpperCase() + runtimeBadge.slice(1) : null;
  const isCancelling = activeChannelId ? !!(cancellingByAgent[`${activeChannelId}:${authorId}`] || cancellingByAgent[`${activeChannelId}:*`]) : false;

  // Aggregate all tool calls (turnSteps + folded toolExecutions) into a single list for the collapsible container
  const allTools: ToolExecution[] = useMemo(() => {
    const list: ToolExecution[] = [];
    if (turnSteps) {
      for (const s of turnSteps) {
        if (s.type === 'tool_call' && s.toolExecution) list.push(s.toolExecution);
      }
    }
    if (toolExecutions) {
      list.push(...toolExecutions);
    }
    return list;
  }, [turnSteps, toolExecutions]);

  const [toolsExpanded, setToolsExpanded] = useState(false);

  // Auto-expand monologue only once on initial mount if streaming
  useEffect(() => {
    if (isStreaming && (metadata?.monologue || turnSteps?.some(s => s.type === 'reasoning'))) {
      setMonologueExpanded(true);
    }
  }, []);

  // If tools are streaming/running, auto-expand the outer container so the user sees live activity
  useEffect(() => {
    if (allTools.some(t => t.status === 'working')) {
      setToolsExpanded(true);
    }
  }, [allTools.map(t => t.status).join(',')]);

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
      className={`group relative flex gap-3 p-3.5 sm:p-4 bg-[#1A1A1E] border rounded-2xl hover:bg-[#1E1E22] transition-colors ${
        isCancelled ? 'border-amber-500/40 shadow-[0_4px_16px_rgba(245,158,11,0.12)] opacity-95' : isStreaming ? 'border-indigo-500/30 shadow-[0_4px_20px_rgba(99,102,241,0.12)]' : 'border-zinc-800/70'
      }`}
    >
      {/* Level-themed avatar border */}
      <button 
        type="button"
        onClick={() => openAgentProfileModal(authorId)}
        className={`flex items-center justify-center w-9 h-9 rounded-xl border ${levelMeta.border} bg-zinc-950 text-[15px] select-none hover:opacity-90 hover:scale-[1.03] active:scale-95 transition cursor-pointer focus:outline-none shrink-0 mt-0.5 shadow-sm`}
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
              className={`tnum text-[10px] font-mono px-1.5 py-0.5 rounded border ${levelMeta.badgeBg} cursor-pointer hover:opacity-85 transition`}
            >
              {levelMeta.label}
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">
              {timeStr}
            </span>
            {runtimeLabel && (
              <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                {runtimeLabel}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {isStreaming && !isCancelled && (
              <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/30 text-[10px] font-medium text-indigo-400 animate-pulse select-none">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping" />
                <span>Working</span>
              </div>
            )}
            {isCancelled && (
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] font-medium text-amber-400 select-none">
                <Square size={10} className="fill-amber-400" />
                <span>Cancelled</span>
              </div>
            )}
            {turnStatus === 'failed' && !isCancelled && (
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-[10px] font-mono text-rose-400 select-none">
                <AlertCircle size={10} />
                <span>Turn failed</span>
              </div>
            )}
            {isStreaming && !isCancelled && activeChannelId && (
              <button
                type="button"
                onClick={() => activeChannelId && cancelRun(activeChannelId, authorId)}
                disabled={isCancelling}
                aria-label="Stop generation"
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded border text-[10px] font-medium transition active:scale-95 ${isCancelling ? 'bg-zinc-800 border-zinc-700 text-zinc-500 cursor-wait' : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 hover:text-white'}`}
              >
                <Square size={10} className={isCancelling ? 'fill-zinc-500' : 'fill-zinc-300'} />
                <span>{isCancelling ? 'Stopping' : 'Stop'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Internal Monologue — always on top per spec */}
        {hasMonologue && (
          <div className="border border-indigo-500/15 bg-indigo-500/[0.02] rounded-md p-2.5 space-y-1.5">
            <button 
              onClick={() => setMonologueExpanded(!monologueExpanded)}
              className="flex items-center justify-between w-full text-[10px] text-indigo-400 font-mono hover:text-indigo-300 transition focus:outline-none select-none"
            >
              <div className="flex items-center gap-1.5">
                <Brain size={12} className="text-indigo-400" />
                <span>{monologueExpanded ? 'Hide reasoning' : 'Show reasoning'}</span>
              </div>
              <span className="text-[9px] text-zinc-550 font-mono">
                {metadata.monologue.length} chars
              </span>
            </button>
            {monologueExpanded && (
              <div className="text-xs text-zinc-300 leading-relaxed border-t border-indigo-500/10 pt-2 pl-2.5 border-l-2 border-indigo-500/30 font-sans overflow-x-auto">
                <MentionParser text={metadata.monologue} />
              </div>
            )}
          </div>
        )}

        {/* Main Response Content — middle per spec */}
        {content ? (
          <div className="text-sm text-zinc-300 leading-relaxed font-sans select-text overflow-x-auto">
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

        {/* Tool Calls — grouped 1-level collapsible at very bottom per spec
            Structure: @Agent → [Monologue] → [Final Message] → [Collapsible Tool Container] */}
        {allTools.length > 0 && (
          <div className="pt-2 mt-1">
            {(content || hasMonologue) && <div className="h-px bg-zinc-800/60 mb-2" />}
            <div className="border border-zinc-800 bg-zinc-950/40 rounded-xl overflow-hidden">
              <button
                onClick={() => setToolsExpanded(v => !v)}
                aria-expanded={toolsExpanded}
                aria-controls={`tools-${id}`}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-900/30 hover:bg-zinc-900/60 transition text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/20"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-6 h-6 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                    <Wrench size={11} className="text-zinc-500" />
                  </span>
                  <span className="text-[11px] font-medium text-zinc-400">
                    {toolsExpanded ? 'Hide tool calls' : 'Show tool calls'}
                  </span>
                  <span className="tnum px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono font-medium text-zinc-400">
                    {allTools.length}
                  </span>
                  {/* quick status summary — saves a click when spammed */}
                  <span className="hidden sm:flex items-center gap-1 ml-1">
                    {allTools.some(t => t.status === 'working') && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/20 text-[9px] font-medium text-amber-400 animate-pulse">Running</span>
                    )}
                    {allTools.filter(t => t.status === 'error').length > 0 && (
                      <span className="tnum px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/20 text-[9px] font-medium text-rose-400">
                        {allTools.filter(t => t.status === 'error').length} failed
                      </span>
                    )}
                    {allTools.filter(t => t.status === 'success').length > 0 && allTools.filter(t => t.status === 'error').length === 0 && !allTools.some(t => t.status === 'working') && (
                      <span className="tnum px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/20 text-[9px] font-medium text-emerald-400">
                        {allTools.filter(t => t.status === 'success').length} done
                      </span>
                    )}
                  </span>
                </div>
                <span className="flex items-center gap-1 shrink-0 text-zinc-500">
                  {toolsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </span>
              </button>

              {toolsExpanded && (
                <div
                  id={`tools-${id}`}
                  className="border-t border-zinc-800 p-2 space-y-2 bg-zinc-900/20 max-h-[420px] overflow-y-auto scrollbar-thin overscroll-contain"
                >
                  {allTools.map((te, idx) => (
                    <ToolExecutionMessage
                      key={`tool-${idx}-${te.name}-${te.status}`}
                      toolExecution={te}
                      timestamp={timestamp}
                      inline
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {canRetry && (
          <div className="pt-1">
            <button
              onClick={() => {
                const runId = (metadata as any)?.runId || (metadata as any)?.run_id || id;
                if (runId) void retryRun(runId);
              }}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
            >
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        )}
      </div>

      {(canRegenerate || canRetry) && (
        <div className="absolute -top-2 right-2 hidden group-hover:flex group-focus-within:flex focus-within:flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-[4px] shadow-lg p-1">
          {canRegenerate && (
            <button
              onClick={() => id && regenerate(id)}
              className="w-7 h-7 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center transition cursor-pointer"
              title="Regenerate"
            >
              <RotateCcw size={12} />
            </button>
          )}
          {canRetry && (
            <button
              onClick={() => {
                const runId = (metadata as any)?.runId || (metadata as any)?.run_id || id;
                if (runId) void retryRun(runId);
              }}
              className="w-7 h-7 rounded-full bg-amber-600 hover:bg-amber-500 text-white flex items-center justify-center transition cursor-pointer"
              title="Retry failed run"
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
