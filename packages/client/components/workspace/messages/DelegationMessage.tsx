import { GitFork, ArrowRight, Database, DollarSign, Coins } from 'lucide-react';
import { DelegationInfo } from '@/types/crowdOs';
import { useCrowdOSStore } from '@/stores/crowdOsStore';

interface DelegationMessageProps {
  delegationInfo?: DelegationInfo;
  timestamp: string;
}

export default function DelegationMessage({ delegationInfo, timestamp }: DelegationMessageProps) {
  if (!delegationInfo) return null;

  const { openAgentProfileModal, setRightPanelView } = useCrowdOSStore();
  const { fromAgentId, fromAgentName, toAgentId, toAgentName, task, status, tokens, cost } = delegationInfo;
  const hasTokens = typeof tokens === 'number' && Number.isFinite(tokens);
  const tokensText = hasTokens ? tokens.toLocaleString() + ' tokens' : '\u2014';
  const hasCost = typeof cost === 'number' && Number.isFinite(cost);
  const costText = hasCost ? '$' + cost.toFixed(4) : '\u2014';
  const openTelemetry = () => setRightPanelView('telemetry');
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const statusStyles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    executing: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20 animate-pulse',
    completed: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    failed: 'bg-rose-500/10 text-rose-300 border-rose-500/20'
  };

  return (
    <div 
      id={`delegation-message-${delegationInfo.id}`}
      className="max-w-xl mx-auto border border-indigo-500/20 bg-indigo-500/[0.02] p-4 rounded-lg my-2 font-mono text-zinc-300 space-y-3 shadow-md"
    >
      <div className="flex items-center justify-between border-b border-indigo-500/10 pb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-300">
          <GitFork size={13} className="rotate-90 text-indigo-400" />
          <span>Delegation</span>
        </div>
        <span className="text-[10px] text-zinc-500">
          {timeStr}
        </span>
      </div>

      {/* From Node to Target Node */}
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => openAgentProfileModal(fromAgentId)}
          className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700/60 font-medium hover:text-indigo-400 border-zinc-700 hover:border-indigo-500/30 transition cursor-pointer focus:outline-none"
          title={`View Profile of ${fromAgentName}`}
        >
          {fromAgentName}
        </button>
        <ArrowRight size={12} className="text-zinc-500" />
        <button
          type="button"
          onClick={() => openAgentProfileModal(toAgentId)}
          className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-200 border border-indigo-500/20 font-semibold hover:border-indigo-500/40 hover:text-indigo-300 transition cursor-pointer focus:outline-none"
          title={`View Profile of ${toAgentName}`}
        >
          {toAgentName}
        </button>
      </div>

      {/* Instruction Task */}
      <div className="text-xs bg-zinc-950/65 border border-zinc-900/80 p-2.5 rounded text-zinc-300 leading-relaxed font-sans">
        <span className="text-[11px] font-medium text-zinc-400 block mb-1">Task</span>
        {task}
      </div>

      {/* Computational budgets and status */}
      <div className="flex flex-wrap items-center justify-between text-[11px] gap-2 pt-1 border-t border-indigo-500/5">
        <div className="flex items-center gap-3 text-zinc-400">
          <span className="flex items-center gap-1">
            <Database size={11} className="text-zinc-500" />
            <span>{tokensText}</span>
          </span>
          {hasCost ? (
            <button
              type="button"
              onClick={openTelemetry}
              title="Open telemetry panel"
              aria-label={'Open telemetry panel: delegation cost ' + costText}
              className="flex items-center gap-0.5 rounded hover:text-emerald-300 hover:underline hover:underline-offset-2 transition motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
            >
              <DollarSign size={11} className="text-emerald-500" aria-hidden="true" />
              <span>{costText}</span>
            </button>
          ) : (
            <span className="flex items-center gap-0.5" title="No ledger row for this delegation yet" aria-label="Delegation cost unavailable">
              <DollarSign size={11} className="text-emerald-500" aria-hidden="true" />
              <span>—</span>
            </span>
          )}
        </div>
        <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${statusStyles[status]}`}>
          {status}
        </span>
      </div>
    </div>
  );
}
