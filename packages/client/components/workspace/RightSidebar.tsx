import React, { useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useScreenLockStore, isScreenlockError } from '@/stores/screenLockStore';
import { resolveApiUrl } from '@/src/api/client';
import { useShallow } from 'zustand/react/shallow';
import { BarChart3, Database, Coins, Activity, Network } from 'lucide-react';
import AgentRow from './AgentRow';
const FileExplorer = lazy(() => import('./FileExplorer'));

export default function RightSidebar() {
  const { agents, messages, activeChannelId, activeWorkspaceId, workspaces, openAgentProfileModal, rightSidebarOpen } = useCrowdOSStore(useShallow(s => ({
    agents: s.agents,
    messages: s.messages,
    activeChannelId: s.activeChannelId,
    activeWorkspaceId: s.activeWorkspaceId,
    workspaces: s.workspaces,
    openAgentProfileModal: s.openAgentProfileModal,
    rightSidebarOpen: s.rightSidebarOpen,
  })));
  const { totalTokensConsumed } = useCrowdOSStore(useShallow(s => ({ totalTokensConsumed: s.totalTokensConsumed })));
  const shouldReduceMotion = useReducedMotion();
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
  React.useEffect(() => {
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


  // Filter agents into corporate tiers
  const tierL0 = agents.filter(ag => ag.level === 0);
  const tierL1 = agents.filter(ag => ag.level === 1);
  const tierL2 = agents.filter(ag => ag.level === 2);
  const tierL3 = agents.filter(ag => ag.level === 3);

  // Group level tags — hoisted to AgentRow component (memoized)
  const handleOpenAgent = useCallback((id: string) => openAgentProfileModal(id), [openAgentProfileModal]);

  // Respect reduced-motion: disable AnimatePresence spring when user prefers reduced motion
  const MotionDiv: any = shouldReduceMotion ? 'div' : motion.div;

  if (shouldReduceMotion) {
    // Reduced-motion: no AnimatePresence spring, plain divs preserve UX quality statically
    if (!rightSidebarOpen) {
      return (
        <div className="w-[260px] flex flex-col h-full overflow-hidden shrink-0 border-l border-zinc-900 border-x-0">
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading repository…</div>}>
            <FileExplorer />
          </Suspense>
        </div>
      );
    }
    return (
      <div id="right-sidebar" className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0">
        {renderRoster()}
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait">
      {!rightSidebarOpen ? (
        <motion.div 
          key="file-explorer"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15 }}
          className="w-[260px] flex flex-col h-full overflow-hidden shrink-0 border-l border-zinc-900 border-x-0"
        >
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading repository…</div>}>
            <FileExplorer />
          </Suspense>
        </motion.div>
      ) : (
        <motion.div 
          key="roster-view"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15 }}
          id="right-sidebar"
          className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0"
        >
          {renderRoster()}
        </motion.div>
      )}
    </AnimatePresence>
  );

  function renderRoster() {
    return (
      <>

      {/* Title — larger, calmer */}
      <div className="px-4 py-3.5 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
        <h2 className="text-[13px] font-medium text-zinc-300 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Network size={12} className="text-zinc-500" />
          </span>
          Operations roster
        </h2>
        <span className="tnum text-[11px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-md">{agents.length}</span>
      </div>

      {/* Roster Area — airy spacing, progressive disclosure */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 scrollbar-thin overscroll-contain">
        {/* Tier L0 */}
        {tierL0.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-medium text-zinc-300 px-1 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-sm bg-cyan-400" />
              L0 · Surveillance
              <span className="tnum ml-auto text-[10px] font-mono font-medium bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 px-1.5 py-0.5 rounded">{tierL0.length}</span>
            </h3>
            <div className="space-y-1">
              {tierL0.map(ag => <AgentRow key={ag.id} {...ag} onOpen={handleOpenAgent} />)}
            </div>
          </div>
        )}

        {/* Tier L1 */}
        {tierL1.length > 0 && (
          <div className="space-y-2" id="roster-tier-l1">
            <h3 className="text-[13px] font-medium text-zinc-300 px-1 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-sm bg-rose-400" />
              L1 · Executive
              <span className="tnum ml-auto text-[10px] font-mono font-medium bg-rose-500/10 border border-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded">{tierL1.length}</span>
            </h3>
            <div className="space-y-1">
              {tierL1.map(ag => <AgentRow key={ag.id} {...ag} onOpen={handleOpenAgent} />)}
            </div>
          </div>
        )}

        {/* Tier L2 */}
        {tierL2.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-medium text-zinc-300 px-1 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-sm bg-indigo-400" />
              L2 · Coordinators
              <span className="tnum ml-auto text-[10px] font-mono font-medium bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded">{tierL2.length}</span>
            </h3>
            <div className="space-y-1">
              {tierL2.map(ag => <AgentRow key={ag.id} {...ag} onOpen={handleOpenAgent} />)}
            </div>
          </div>
        )}

        {/* Tier L3 */}
        {tierL3.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-medium text-zinc-300 px-1 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-sm bg-emerald-400" />
              L3 · Workers
              <span className="tnum ml-auto text-[10px] font-mono font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">{tierL3.length}</span>
            </h3>
            <div className="space-y-1">
              {tierL3.map(ag => <AgentRow key={ag.id} {...ag} onOpen={handleOpenAgent} />)}
            </div>
          </div>
        )}

        {agents.length === 0 && (
          <div className="text-center py-12 px-4">
            <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-600">
              <Network size={18} />
            </div>
            <p className="text-sm font-medium text-zinc-300">No agents yet</p>
            <p className="text-xs text-zinc-500 mt-1">Spawn your first agent in Settings → Agents Board.</p>
          </div>
        )}
      </div>

      {/* Bottom Telemetry Dashboard — readable, airy */}
      <div className="bg-[#09090b] border-t border-zinc-900 p-4 space-y-3.5 shrink-0 select-none">
        <div className="flex items-center justify-between">
          <h4 className="text-[13px] font-medium text-zinc-300 flex items-center gap-1.5">
            <BarChart3 size={12} className="text-zinc-500" />
            <span>{telemetryTab === 'channel' ? 'Channel telemetry' : 'Global telemetry'}</span>
          </h4>
          <div className="flex bg-zinc-900 rounded-lg p-1 border border-zinc-800" role="tablist" aria-label="Telemetry scope">
            <button
              onClick={() => setTelemetryTab('channel')}
              role="tab"
              aria-selected={telemetryTab === 'channel'}
              className={`px-3 py-1 text-[11px] font-mono font-medium rounded-md transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer ${telemetryTab === 'channel' ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Channel
            </button>
            <button
              onClick={() => setTelemetryTab('global')}
              role="tab"
              aria-selected={telemetryTab === 'global'}
              className={`px-3 py-1 text-[11px] font-mono font-medium rounded-md transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer ${telemetryTab === 'global' ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Global
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 text-left">
          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Database size={11} className="text-zinc-500" />
              <span>Tokens</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-zinc-100 font-mono mt-1.5 tracking-tight">
              {ledgerStatus === 'loading' && telemetryTab === 'global' ? <span className="inline-block h-4 w-16 skeleton" /> : calculatedTokens.toLocaleString()}
            </div>
          </div>

          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Coins size={11} className="text-emerald-500" />
              <span>Est. cost</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-emerald-400 font-mono mt-1.5 tracking-tight">
              ${calculatedBudgetSpent.toFixed(4)}
            </div>
          </div>

          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Activity size={11} className="text-zinc-500" />
              <span>Active</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-zinc-100 font-mono mt-1.5">
              {activeCount} / {totalAgentsCount}
            </div>
          </div>

          <div className="bg-zinc-900/70 p-3 rounded-xl border border-zinc-800 leading-tight">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
              <Network size={11} className="text-zinc-500" />
              <span>Channels</span>
            </div>
            <div className="tnum text-[13px] font-semibold text-zinc-100 font-mono mt-1.5">
              {currentChannelsCount}
            </div>
          </div>
        </div>
      </div>
      </>
    );
  }
}
