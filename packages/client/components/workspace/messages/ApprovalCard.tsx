import { useState } from 'react';
import { ShieldAlert, Check, X, Clock } from 'lucide-react';
import { useCrowdOSStore, type ApprovalRequest } from '@/stores/crowdOsStore';

function truncateJson(value: Record<string, unknown> | null, max = 300): string {
  if (!value) return '-';
  try {
    const s = JSON.stringify(value, null, 2);
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  } catch {
    return String(value).slice(0, max);
  }
}

function riskBadgeClass(risk: string): string {
  const map: Record<string, string> = {
    install: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    network: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    destructive: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    git_push: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    db_write: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
    general: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  };
  return map[risk] || map.general;
}

export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const decideApproval = useCrowdOSStore(s => s.decideApproval);
  const [deciding, setDeciding] = useState<string | null>(null);
  const isPending = approval.status === 'pending';
  const preview = truncateJson(approval.argsPreview);

  async function handleDecision(decision: 'approved' | 'denied', scope?: string | null) {
    if (!isPending || deciding) return;
    setDeciding(decision + (scope || ''));
    try {
      await decideApproval(approval.id, decision, scope ?? null);
    } catch {
      setDeciding(null);
    } finally {
      setDeciding(null);
    }
  }

  return (
    <div
      id={`approval-${approval.id}`}
      className="max-w-xl mx-auto border border-amber-500/25 bg-amber-500/[0.04] rounded-xl my-3 overflow-hidden shadow-md"
    >
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-amber-500/15 bg-amber-500/[0.06]">
        <div className="flex items-center gap-2 text-amber-300 text-[12px] font-semibold">
          <ShieldAlert size={14} className="shrink-0" />
          <span>Approval requested</span>
          <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold border ${riskBadgeClass(approval.riskClass)}`}>
            {approval.riskClass}
          </span>
        </div>
        <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1">
          <Clock size={10} />
          {approval.expiresAt ? new Date(approval.expiresAt).toLocaleTimeString() : 'pending'}
        </span>
      </div>

      <div className="p-3.5 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono font-bold text-zinc-300">{approval.tool}</span>
          <span className="text-[10px] font-mono text-zinc-500">run {approval.runId.slice(0, 8)}…</span>
          {!isPending && (
            <span className={`ml-auto px-2 py-0.5 rounded text-[10px] font-medium border ${approval.status === 'approved' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' : approval.status === 'denied' ? 'bg-rose-500/15 text-rose-300 border-rose-500/20' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
              {approval.status}
            </span>
          )}
        </div>

        <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-2.5">
          <div className="text-[11px] font-medium text-zinc-400 mb-1">Arguments</div>
          <pre className="text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto scrollbar-thin">
            {preview}
          </pre>
        </div>

        {isPending ? (
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => handleDecision('approved')}
              disabled={!!deciding}
              className="flex-1 min-h-[36px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition cursor-pointer"
            >
              <Check size={14} />
              Grant
            </button>
            <button
              onClick={() => handleDecision('denied')}
              disabled={!!deciding}
              className="flex-1 min-h-[36px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs font-semibold border border-zinc-700 transition cursor-pointer"
            >
              <X size={14} />
              Deny
            </button>
            <button
              onClick={() => handleDecision('approved', 'reusable')}
              disabled={!!deciding}
              className="flex-1 min-h-[36px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold transition cursor-pointer"
              title="Grant and remember for this tool+args for session"
            >
              Grant for session
            </button>
          </div>
        ) : (
          <div className="text-[11px] font-mono text-zinc-500 pt-1">
            Decided: {approval.status}
          </div>
        )}
      </div>
    </div>
  );
}

export default ApprovalCard;
