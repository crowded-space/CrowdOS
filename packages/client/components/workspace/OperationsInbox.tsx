import { useState } from 'react';
import { ArrowRight, AtSign, Check, Clock, Inbox, RotateCcw, ShieldAlert, TriangleAlert, Undo2, X } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';

/**
 * Operations inbox (Phase D): pending approvals + failures + mentions.
 * Approvals project live from approvalRequests (pending only); failures
 * from messages whose turnStatus is failed/cancelled; mentions from
 * channels with hasMention set. Derived via store inboxItems, never a
 * second approval model. Later is local-only via deferLater (no server
 * defer endpoint exists). Deep-links are channel-only via setActiveChannel;
 * run/inbox targets come later (recorded gap, never invented).
 */
export function OperationsInbox(): React.JSX.Element {
  const store = useCrowdOSStore(useShallow(function (s) { return {
    approvalRequests: s.approvalRequests,
    inboxDeferred: s.inboxDeferred,
    inboxItems: s.inboxItems,
    decideApproval: s.decideApproval,
    deferLater: s.deferLater,
    undeferInbox: s.undeferInbox,
    setActiveChannel: s.setActiveChannel,
    retryRun: s.retryRun,
    activeChannelId: s.activeChannelId,
    workspaces: s.workspaces,
  }; }));
  const approvalRequests = store.approvalRequests;
  const inboxDeferred = store.inboxDeferred;
  const inboxItems = store.inboxItems;
  const decideApproval = store.decideApproval;
  const deferLater = store.deferLater;
  const undeferInbox = store.undeferInbox;
  const setActiveChannel = store.setActiveChannel;
  const retryRun = store.retryRun;
  const activeChannelId = store.activeChannelId;
  const workspaces = store.workspaces;
  const [approveBusy, setApproveBusy] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const channelNameById: Record<string, string> = {};
  for (const ws of workspaces) {
    for (const ch of (ws.channels || [])) channelNameById[ch.id] = '#' + ch.name;
    for (const cat of (ws.categories || [])) {
      for (const ch of (cat.channels || [])) channelNameById[ch.id] = '#' + ch.name;
    }
  }
  const pending = approvalRequests.filter(function (r) { return r.status === 'pending' && !inboxDeferred[r.id]; });
  const later = approvalRequests.filter(function (r) { return r.status === 'pending' && inboxDeferred[r.id]; });
  const items = inboxItems();
  const failures = items.filter(function (i) { return i.kind === 'failure'; });
  const mentions = items.filter(function (i) { return i.kind === 'mention'; });
  const isEmpty = pending.length === 0 && failures.length === 0 && mentions.length === 0 && later.length === 0;
  const handleApprove = function (approvalId: string) {
    setApproveBusy(approvalId);
    setInboxError(null);
    decideApproval(approvalId, 'approved').catch(function (err) {
      setInboxError(err instanceof Error ? err.message : 'Failed to approve');
    }).finally(function () { setApproveBusy(null); });
  };
  const handleDeny = function (approvalId: string) {
    setApproveBusy(approvalId);
    setInboxError(null);
    decideApproval(approvalId, 'denied').catch(function (err) {
      setInboxError(err instanceof Error ? err.message : 'Failed to deny');
    }).finally(function () { setApproveBusy(null); });
  };
  const handleRetry = function (key: string, runId: string | null) {
    if (!runId) return;
    setRetryBusy(key);
    setInboxError(null);
    retryRun(runId).catch(function (err) {
      setInboxError(err instanceof Error ? err.message : 'Failed to retry run');
    }).finally(function () { setRetryBusy(null); });
  };
  const jumpLabel = function (channelId: string | null) {
    if (!channelId) return 'No channel linked';
    return 'Jump to ' + (channelNameById[channelId] || channelId);
  };
  return (
    <section aria-label="Operations inbox" className="shrink-0 border-b border-zinc-900 max-h-[46%] overflow-auto overscroll-contain">
      <div className="px-4 py-3 border-b border-zinc-900 flex items-center justify-between select-none">
        <h2 className="text-[13px] font-medium text-zinc-300 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center" aria-hidden="true">
            <Inbox size={12} className="text-zinc-500" aria-hidden="true" />
          </span>
          Inbox
        </h2>
        <span className="tnum text-[11px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-md">{pending.length + failures.length + mentions.length}</span>
      </div>
      {inboxError && (
        <p role="alert" className="mx-3 mt-2 text-[11px] font-mono text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1.5">
          {inboxError}
        </p>
      )}
      {isEmpty ? (
        <div className="text-center py-8 px-4">
          <p className="text-sm font-medium text-zinc-300">No pending items</p>
          <p className="text-xs text-zinc-500 mt-1">Approvals, failures, and mentions will appear here when they arrive.</p>
        </div>
      ) : (
        <div className="px-3 py-2 space-y-3">
          <div>
            <h3 className="text-[10px] font-mono uppercase tracking-wide text-zinc-500 px-1 pb-1">Pending approvals ({pending.length})</h3>
            {pending.length === 0 ? (
              <p className="text-[11px] font-mono text-zinc-600 px-1">No pending approvals.</p>
            ) : (
              <ul className="space-y-1.5">
                {pending.map(function (req) {
                  const busy = approveBusy === req.id;
                  return (
                    <li key={req.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono bg-amber-500/15 text-amber-300 border-amber-500/20">
                          <ShieldAlert size={11} aria-hidden="true" />approval
                        </span>
                        <span className="text-[11px] font-mono text-zinc-200 truncate" title={req.tool}>{req.tool}</span>
                      </div>
                      {req.riskClass && <p className="text-[10px] font-mono text-zinc-500 mt-0.5 px-0.5 truncate">{req.riskClass}</p>}
                      <span className="mt-1.5 inline-flex items-center gap-1">
                        <button
                          onClick={function () { handleApprove(req.id); }}
                          disabled={busy}
                          title="Approve this request"
                          aria-label={'Approve ' + req.id}
                          className="h-7 px-2 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 inline-flex items-center gap-1 text-[11px] font-mono transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <Check size={12} aria-hidden="true" />Approve
                        </button>
                        <button
                          onClick={function () { handleDeny(req.id); }}
                          disabled={busy}
                          title="Deny this request"
                          aria-label={'Deny ' + req.id}
                          className="h-7 px-2 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 inline-flex items-center gap-1 text-[11px] font-mono transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <X size={12} aria-hidden="true" />Deny
                        </button>
                        <button
                          onClick={function () { if (req.channelId && req.channelId !== activeChannelId) void setActiveChannel(req.channelId); }}
                          disabled={!req.channelId}
                          title={jumpLabel(req.channelId ?? null)}
                          aria-label={'Jump to channel for approval ' + req.id}
                          className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <ArrowRight size={12} aria-hidden="true" />
                        </button>
                        <button
                          onClick={function () { deferLater(req.id); }}
                          title="Defer to Later (local only, no server endpoint)"
                          aria-label={'Defer approval ' + req.id + ' to Later'}
                          className="h-7 px-2 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1 text-[11px] font-mono transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <Clock size={12} aria-hidden="true" />Later
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-[10px] font-mono uppercase tracking-wide text-zinc-500 px-1 pb-1">Failures ({failures.length})</h3>
            {failures.length === 0 ? (
              <p className="text-[11px] font-mono text-zinc-600 px-1">No failures.</p>
            ) : (
              <ul className="space-y-1.5">
                {failures.map(function (item) {
                  const busy = retryBusy === item.id;
                  return (
                    <li key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono bg-zinc-800 text-zinc-300 border-zinc-700">
                          <TriangleAlert size={11} aria-hidden="true" />failure
                        </span>
                        <span className="text-[11px] font-mono text-zinc-200 truncate" title={item.detail ?? item.title}>{item.title}</span>
                      </div>
                      {item.detail && <p className="text-[10px] font-mono text-zinc-500 mt-0.5 px-0.5 truncate" title={item.detail}>{item.detail}</p>}
                      <span className="mt-1.5 inline-flex items-center gap-1">
                        <button
                          onClick={function () { handleRetry(item.id, item.runId); }}
                          disabled={!item.runId || busy}
                          title={item.runId ? 'Retry this run (resume from checkpoint)' : 'No run linked, retry unavailable'}
                          aria-label={'Retry ' + item.id}
                          className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <RotateCcw size={12} aria-hidden="true" />
                        </button>
                        <button
                          onClick={function () { if (item.channelId && item.channelId !== activeChannelId) void setActiveChannel(item.channelId); }}
                          disabled={!item.channelId}
                          title={jumpLabel(item.channelId)}
                          aria-label={'Jump to channel for ' + item.id}
                          className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <ArrowRight size={12} aria-hidden="true" />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-[10px] font-mono uppercase tracking-wide text-zinc-500 px-1 pb-1">Mentions ({mentions.length})</h3>
            {mentions.length === 0 ? (
              <p className="text-[11px] font-mono text-zinc-600 px-1">No mentions.</p>
            ) : (
              <ul className="space-y-1.5">
                {mentions.map(function (item) {
                  return (
                    <li key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono bg-rose-500/15 text-rose-300 border-rose-500/20">
                          <AtSign size={11} aria-hidden="true" />mention
                        </span>
                        <span className="text-[11px] font-mono text-zinc-200 truncate" title={item.channelId ?? item.title}>{item.title}</span>
                      </div>
                      <span className="mt-1.5 inline-flex items-center gap-1">
                        <button
                          onClick={function () { if (item.channelId && item.channelId !== activeChannelId) void setActiveChannel(item.channelId); }}
                          disabled={!item.channelId}
                          title={jumpLabel(item.channelId)}
                          aria-label={'Jump to channel for ' + item.id}
                          className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <ArrowRight size={12} aria-hidden="true" />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {later.length > 0 && (
            <div>
              <h3 className="text-[10px] font-mono uppercase tracking-wide text-zinc-500 px-1 pb-1">Later ({later.length})</h3>
              <ul className="space-y-1.5">
                {later.map(function (req) {
                  return (
                    <li key={req.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 opacity-80">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono bg-amber-500/15 text-amber-300 border-amber-500/20">
                          <ShieldAlert size={11} aria-hidden="true" />approval
                        </span>
                        <span className="text-[11px] font-mono text-zinc-200 truncate" title={req.tool}>{req.tool}</span>
                      </div>
                      <span className="mt-1.5 inline-flex items-center gap-1">
                        <button
                          onClick={function () { handleApprove(req.id); }}
                          disabled={approveBusy === req.id}
                          title="Approve this request"
                          aria-label={'Approve deferred ' + req.id}
                          className="h-7 px-2 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 inline-flex items-center gap-1 text-[11px] font-mono transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <Check size={12} aria-hidden="true" />Approve
                        </button>
                        <button
                          onClick={function () { undeferInbox(req.id); }}
                          title="Move back to Pending"
                          aria-label={'Move ' + req.id + ' back to Pending'}
                          className="h-7 px-2 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1 text-[11px] font-mono transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                        >
                          <Undo2 size={12} aria-hidden="true" />Undefer
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className="px-4 py-2 border-t border-zinc-900 text-[10px] font-mono text-zinc-600 select-none">
        Later is local-only (no server defer endpoint). Deep-links jump to the channel only.
      </p>
    </section>
  );
}

export default OperationsInbox;
