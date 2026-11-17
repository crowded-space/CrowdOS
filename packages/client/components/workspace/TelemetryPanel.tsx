import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, Database, Coins, Activity, Network } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useScreenLockStore, isScreenlockError } from '@/stores/screenLockStore';
import { resolveApiUrl } from '@/src/api/client';
import { useShallow } from 'zustand/react/shallow';

/**
 * Telemetry: Channel/Global scope tablist, tokens/cost/active/channels cards.
 * Reads the SAME store projections as the desktop right panel and runs the
 * SAME 30s workspace-scoped ledger poll (UX-7, §19 screenlock-aware) — no
 * second telemetry model; both RightSidebar (xl+) and OperationsSheet
 * (below xl) mount it, so the panel is reachable at every viewport width
 * (UI audit §2.16, 2026-10-22). Returns a fragment: the host owns the
 * panel container (w-[260px] column in the right sidebar, full-width
 * column in the sheet).
 */
export function TelemetryPanel(): React.JSX.Element {
  const { messages, activeChannelId, activeWorkspaceId, workspaces, agents, totalTokensConsumed } = useCrowdOSStore(useShallow(s => ({
    messages: s.messages,
    activeChannelId: s.activeChannelId,
    activeWorkspaceId: s.activeWorkspaceId,
    workspaces: s.workspaces,
    agents: s.agents,
    totalTokensConsumed: s.totalTokensConsumed,
  })));
  const [telemetryTab, setTelemetryTab] = useState<'channel' | 'global'>('global');
  const [ledger, setLedger] = useState<{ totalTokens: number; totalCostUsd: number } | null>(null);
  // 'loading' → skeleton; 'ready' → ledger totals; 'offline' → honest local sums.
  // A single null-able ledger could not tell "still fetching" from "fetch failed",
  // so a failing poll rendered the skeleton forever and hid the fallback.
  const [ledgerStatus, setLedgerStatus] = useState<'loading' | 'ready' | 'offline'>('loading');

  // UX-7: fetch real ledger aggregates from observability cost dashboard (SCL-3)
  // When available, global telemetry uses ledger totals instead of local estimates.
  // Fallback to DEMO_FALLBACK=false shows honest outage (no fake 421035 baseline).
  //
  // §19 screenlock: the poll is WORKSPACE-SCOPED (x-workspace-id). Untargeted,
  // the PIN gate evaluates "is a screenlock configured in ANY workspace" and
  // 401s an unlocked workspace whenever a sibling workspace has a PIN. Targeted,
  // only this workspace's lock decides — an unlocked workspace answers, a locked
  // one 401s and re-locks the shell (same contract as the store's tenant fetches).
  // resolveApiUrl keeps the packaged app:// renderer pointed at the embedded
  // backend instead of its own origin.
  useEffect(() => {
    let cancelled = false;
    const workspaceId = activeWorkspaceId;
    if (!workspaceId) return;
    // Explicit annotation: the guard above proves non-null, but TS does not
    // carry that narrowing into a hoisted function declaration's closure, and
    // HeadersInit requires a plain string.
    const scopedWorkspaceId: string = workspaceId;
    async function fetchLedger() {
      try {
        const res = await fetch(resolveApiUrl('/api/observability/cost/dashboard'), {
          headers: { 'x-workspace-id': scopedWorkspaceId },
        });
        if (res.status === 401) {
          const body = await res.clone().json().catch(() => ({} as { message?: string }));
          if (isScreenlockError(body?.message)) {
            useScreenLockStore.getState().lock();
            return;
          }
          if (!cancelled) setLedgerStatus('offline');
          return;
        }
        if (!res.ok) {
          if (!cancelled) setLedgerStatus('offline');
          return;
        }
        const data = await res.json() as { totalTokens?: number; totalCostUsd?: number };
        if (cancelled) return;
        if (typeof data.totalTokens === 'number') {
          setLedger({ totalTokens: data.totalTokens, totalCostUsd: data.totalCostUsd ?? 0 });
          setLedgerStatus('ready');
        } else {
          setLedgerStatus('offline');
        }
      } catch {
        if (!cancelled) setLedgerStatus('offline');
      }
    }
    fetchLedger();
    const id = setInterval(fetchLedger, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeWorkspaceId]);

  // Dynamic telemetry metrics
  const { calculatedTokens, calculatedBudgetSpent, activeCount, totalAgentsCount, currentChannelsCount } = useMemo(() => {
    const relevantMessages = telemetryTab === 'global'
      ? messages
      : messages.filter(m => m.channelId === activeChannelId);

    let tokens = 0;
    let cost = 0;

    relevantMessages.forEach(m => {
      // UX-7: Honest telemetry — use actual metadata.usage if available, otherwise 0 (no fake length*1.5)
      const metadataUsage = m.metadata?.usage;
      const textTokens = (typeof metadataUsage?.totalTokens === 'number')
        ? metadataUsage.totalTokens
        : ((typeof metadataUsage?.promptTokens === 'number' || typeof metadataUsage?.completionTokens === 'number')
            ? (metadataUsage?.promptTokens || 0) + (metadataUsage?.completionTokens || 0)
            : 0);
      const msgTokens = (m.delegationInfo?.tokens || 0) + textTokens;
      const msgCost = (m.delegationInfo?.cost || 0) + (typeof m.metadata?.cost === 'number' ? m.metadata.cost : (textTokens * 0.000003));

      tokens += msgTokens;
      cost += msgCost;
    });

    const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId);
    let channelsCount = 0;
    if (activeWorkspace) {
      channelsCount = activeWorkspace.categories.reduce((acc, cat) => acc + cat.channels.length, 0);
    }

    const channelParticipantIds = new Set(relevantMessages.map(m => m.authorId));

    let activeAgs = 0;
    let totalAgs = agents.length;

    if (telemetryTab === 'global') {
      activeAgs = agents.filter(a => a.status === 'active' || a.status === 'executing' || a.status === 'thinking').length;
    } else {
      totalAgs = agents.filter(a => channelParticipantIds.has(a.id)).length;
      activeAgs = agents.filter(a =>
        (a.status === 'active' || a.status === 'executing' || a.status === 'thinking') &&
        channelParticipantIds.has(a.id)
      ).length;
    }

    // UX-7: ledger-backed global totals when available; else honest local sum (no 421035 fake baseline)
    if (telemetryTab === 'global' && ledger) {
      return {
        calculatedTokens: ledger.totalTokens,
        calculatedBudgetSpent: ledger.totalCostUsd,
        activeCount: activeAgs,
        totalAgentsCount: totalAgs || agents.length,
        currentChannelsCount: channelsCount,
      };
    }
    const baseTokens = telemetryTab === 'global' ? (totalTokensConsumed || 0) : 0;
    const baseCost = (baseTokens + tokens) * 0.000003;

    return {
      calculatedTokens: baseTokens + tokens,
      calculatedBudgetSpent: telemetryTab === 'global' && totalTokensConsumed > 0 ? (totalTokensConsumed * 0.000003 + cost) : (baseCost + cost),
      activeCount: activeAgs,
      totalAgentsCount: totalAgs || agents.length,
      currentChannelsCount: telemetryTab === 'global' ? channelsCount : (activeChannelId ? 1 : 0)
    };
  }, [messages, telemetryTab, activeChannelId, agents, workspaces, activeWorkspaceId, totalTokensConsumed, ledger]);

  return (
    <>
      {/* Title — telemetry graduated from roster footer to its own view */}
      <div className="px-4 py-3.5 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
        <h2 className="text-[13px] font-medium text-zinc-300 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center" aria-hidden="true">
            <BarChart3 size={12} className="text-zinc-500" aria-hidden="true" />
          </span>
          Telemetry
        </h2>
      </div>

      {/* Graduated telemetry — Channel/Global tablist moved out of the roster footer; 30s ledger poll + offline honesty intact */}
      <section aria-labelledby="telemetry-heading" className="bg-[#09090b] p-4 space-y-3.5 flex-1 overflow-y-auto scrollbar-thin overscroll-contain select-none">
        <div className="flex items-center justify-between">
          <h2 id="telemetry-heading" className="text-[13px] font-medium text-zinc-300 flex items-center gap-1.5">
            <BarChart3 size={12} className="text-zinc-500" aria-hidden="true" />
            <span>{telemetryTab === 'channel' ? 'Channel telemetry' : 'Global telemetry'}</span>
          </h2>
          <div className="flex bg-zinc-900 rounded-lg p-1 border border-zinc-800" role="tablist" aria-label="Telemetry scope">
            <button
              id="telemetry-tab-channel"
              onClick={() => setTelemetryTab('channel')}
              role="tab"
              aria-selected={telemetryTab === 'channel'}
              aria-controls="telemetry-panel"
              className={`px-3 py-1 text-[11px] font-mono font-medium rounded-md transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer ${telemetryTab === 'channel' ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Channel
            </button>
            <button
              id="telemetry-tab-global"
              onClick={() => setTelemetryTab('global')}
              role="tab"
              aria-selected={telemetryTab === 'global'}
              aria-controls="telemetry-panel"
              className={`px-3 py-1 text-[11px] font-mono font-medium rounded-md transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer ${telemetryTab === 'global' ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Global
            </button>
          </div>
        </div>

        <div id="telemetry-panel" role="tabpanel" aria-labelledby={telemetryTab === 'channel' ? 'telemetry-tab-channel' : 'telemetry-tab-global'} className="grid grid-cols-2 gap-2.5 text-left">
          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Database size={11} className="text-zinc-500" aria-hidden="true" />
              <span>Tokens</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-zinc-100 font-mono mt-1.5 tracking-tight">
              {ledgerStatus === 'loading' && telemetryTab === 'global' ? <span className="inline-block h-4 w-16 skeleton" /> : calculatedTokens.toLocaleString()}
            </div>
            {ledgerStatus === 'offline' && telemetryTab === 'global' && (
              <p className="mt-1.5 text-[10px] font-mono text-zinc-400">Ledger offline, showing local totals.</p>
            )}
          </div>

          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Coins size={11} className="text-zinc-500" aria-hidden="true" />
              <span>Est. cost</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-emerald-300 font-mono mt-1.5 tracking-tight">
              ${calculatedBudgetSpent.toFixed(4)}
            </div>
          </div>

          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Activity size={11} className="text-zinc-500" aria-hidden="true" />
              <span>Active</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-zinc-100 font-mono mt-1.5">
              {activeCount} / {totalAgentsCount}
            </div>
          </div>

          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Network size={11} className="text-zinc-500" aria-hidden="true" />
              <span>Channels</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-zinc-100 font-mono mt-1.5">
              {currentChannelsCount}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export default TelemetryPanel;
