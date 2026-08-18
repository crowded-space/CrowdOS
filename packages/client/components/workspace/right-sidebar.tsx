import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import PresenceIndicator from './ui/presence-indicator';
import { Sparkles, BarChart3, Database, Coins, Activity, Network } from 'lucide-react';
import FileExplorer from './file-explorer';

export default function RightSidebar() {
  const { agents, messages, activeChannelId, activeWorkspaceId, workspaces, openAgentProfileModal, rightSidebarOpen } = useCrowdOSStore();
  const { totalTokensConsumed } = useCrowdOSStore();
  const [telemetryTab, setTelemetryTab] = useState<'channel' | 'global'>('global');

  // Dynamic telemetry metrics
  const { calculatedTokens, calculatedBudgetSpent, activeCount, totalAgentsCount, currentChannelsCount } = useMemo(() => {
    const relevantMessages = telemetryTab === 'global' 
      ? messages 
      : messages.filter(m => m.channelId === activeChannelId);

    let tokens = 0;
    let cost = 0;

    relevantMessages.forEach(m => {
      const textTokens = Math.floor(m.content.length * 1.5);
      const msgTokens = (m.delegationInfo?.tokens || 0) + textTokens;
      const msgCost = (m.delegationInfo?.cost || 0) + (textTokens * 0.000003);
      
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

    const baseTokens = telemetryTab === 'global' ? (totalTokensConsumed || 42000) : 1200;
    const baseCost = (baseTokens + tokens) * 0.000003;

    return {
      calculatedTokens: baseTokens + tokens,
      calculatedBudgetSpent: baseCost + cost,
      activeCount: activeAgs,
      totalAgentsCount: totalAgs || agents.length,
      currentChannelsCount: telemetryTab === 'global' ? channelsCount : 1
    };
  }, [messages, telemetryTab, activeChannelId, agents, workspaces, activeWorkspaceId, totalTokensConsumed]);


  // Filter agents into corporate tiers
  const tierL0 = agents.filter(ag => ag.level === 0);
  const tierL1 = agents.filter(ag => ag.level === 1);
  const tierL2 = agents.filter(ag => ag.level === 2);
  const tierL3 = agents.filter(ag => ag.level === 3);

  // Group level tags
  const levelStyles: Record<number, { text: string; bg: string; border: string }> = {
    0: { text: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/25' },
    1: { text: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/25' },
    2: { text: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/25' },
    3: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' }
  };

  const AgentRow = ({ id, name, species, status, level, avatar, isOmniscient }: any) => {
    const meta = levelStyles[level] || { text: 'text-zinc-400', bg: 'bg-zinc-800', border: 'border-zinc-700' };

    return (
      <button
        onClick={() => openAgentProfileModal(id)}
        className="w-full flex items-center gap-2.5 px-2 py-1.5 hover:bg-zinc-900/40 rounded-md transition text-left cursor-pointer focus:outline-none"
        id={`agent-row-${id}`}
      >
        {/* Border mapped to Level-Color */}
        <div className={`relative w-8 h-8 rounded-full flex items-center justify-center bg-zinc-950 border ${meta.border} select-none text-sm font-sans shrink-0`}>
          {avatar || '🤖'}
          {/* Presence cutout Dot */}
          <div className="absolute -bottom-0.5 -right-0.5">
            <PresenceIndicator status={status} size="sm" />
          </div>
        </div>

        <div className="min-w-0 leading-snug">
          <div className="text-xs font-semibold text-zinc-100 truncate flex items-center gap-1.5 font-sans">
            <span className={`${meta.text}`}>{name}</span>
            {isOmniscient && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-extrabold font-mono bg-cyan-950/80 text-cyan-400 border border-cyan-800/35 tracking-tight leading-none animate-pulse">
                👁️ OMNI
              </span>
            )}
          </div>
          <div className="text-[9.5px] text-zinc-500 font-mono flex items-center gap-1">
            <span>{species}</span>
            <span>•</span>
            <span className="uppercase text-[8px] font-bold">L{level}</span>
          </div>
        </div>
      </button>
    );
  };

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
          <FileExplorer />
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
      {/* Title */}
      <h2 className="p-3.5 border-b border-zinc-900 text-[10.5px] font-mono tracking-wider font-bold text-zinc-550 flex items-center gap-1.5 shrink-0 uppercase select-none">
        <Network size={12} className="text-zinc-550 rotate-90" />
        <span>Operations Roster</span>
      </h2>

      {/* Roster Area */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-5 scrollbar-thin">
        {/* Tier L0 */}
        {tierL0.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-[10px] font-mono font-bold text-cyan-500/80 tracking-wide px-1">
              TIER L0 — SURVEILLANCE ({tierL0.length})
            </h3>
            <div className="space-y-0.5">
              {tierL0.map(ag => <AgentRow key={ag.id} {...ag} />)}
            </div>
          </div>
        )}

        {/* Tier L1 */}
        {tierL1.length > 0 && (
          <div className="space-y-10" id="roster-tier-l1">
            <div className="space-y-1">
              <h3 className="text-[10px] font-mono font-bold text-rose-500/80 tracking-wide px-1">
                TIER L1 — EXECUTIVE ADM ({tierL1.length})
              </h3>
              <div className="space-y-0.5">
                {tierL1.map(ag => <AgentRow key={ag.id} {...ag} />)}
              </div>
            </div>
          </div>
        )}

        {/* Tier L2 */}
        {tierL2.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-[10px] font-mono font-bold text-indigo-400 tracking-wide px-1">
              TIER L2 — COORDINATORS ({tierL2.length})
            </h3>
            <div className="space-y-0.5">
              {tierL2.map(ag => <AgentRow key={ag.id} {...ag} />)}
            </div>
          </div>
        )}

        {/* Tier L3 */}
        {tierL3.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-[10px] font-mono font-bold text-emerald-500/80 tracking-wide px-1">
              TIER L3 — WORKER MODULES ({tierL3.length})
            </h3>
            <div className="space-y-0.5">
              {tierL3.map(ag => <AgentRow key={ag.id} {...ag} />)}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Collapsible Telemetry Dashboard */}
      <div className="bg-[#09090b] border-t border-zinc-900 p-3.5 space-y-3 shrink-0 select-none">
        <div className="flex items-center justify-between">
          <h4 className="text-[9.5px] font-mono font-bold text-zinc-550 flex items-center gap-1 uppercase">
            <BarChart3 size={11} className="text-zinc-650" />
            <span>{telemetryTab === 'channel' ? 'Channel Telemetry' : 'Global Telemetry'}</span>
          </h4>
          <div className="flex bg-zinc-900 rounded-[4px] p-0.5">
            <button
              onClick={() => setTelemetryTab('channel')}
              className={`px-2 py-0.5 text-[8.5px] font-mono uppercase rounded-[2px] transition focus:outline-none ${telemetryTab === 'channel' ? 'bg-zinc-700 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              CH
            </button>
            <button
              onClick={() => setTelemetryTab('global')}
              className={`px-2 py-0.5 text-[8.5px] font-mono uppercase rounded-[2px] transition focus:outline-none ${telemetryTab === 'global' ? 'bg-zinc-700 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              GL
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-left">
          <div className="bg-zinc-950/50 p-2 rounded border border-zinc-900/60 leading-tight">
            <div className="flex items-center gap-1 text-[8.5px] font-mono text-zinc-550 uppercase">
              <Database size={10} className="text-zinc-650" />
              <span>Context (Tokens)</span>
            </div>
            <div className="text-xs font-semibold text-zinc-350 font-mono mt-1">
              {calculatedTokens.toLocaleString()}
            </div>
          </div>

          <div className="bg-zinc-950/50 p-2 rounded border border-zinc-900/60 leading-tight">
            <div className="flex items-center gap-0.5 text-[8.5px] font-mono text-zinc-550 uppercase">
              <Coins size={10} className="text-emerald-600" />
              <span>Est Cost</span>
            </div>
            <div className="text-xs font-semibold text-emerald-500 font-mono mt-1">
              ${calculatedBudgetSpent.toFixed(4)}
            </div>
          </div>

          <div className="bg-zinc-950/50 p-2 rounded border border-zinc-900/60 leading-tight">
            <div className="flex items-center gap-1 text-[8.5px] font-mono text-zinc-550 uppercase">
              <Activity size={10} className="text-zinc-650" />
              <span>Active Agents</span>
            </div>
            <div className="text-xs font-semibold text-zinc-350 font-mono mt-1">
              {activeCount} / {totalAgentsCount}
            </div>
          </div>

          <div className="bg-zinc-950/50 p-2 rounded border border-zinc-900/60 leading-tight">
            <div className="flex items-center gap-1 text-[8.5px] font-mono text-zinc-550 uppercase">
              <Network size={10} className="text-zinc-650" />
              <span>Channels</span>
            </div>
            <div className="text-xs font-semibold text-zinc-350 font-mono mt-1">
              {currentChannelsCount} Areas
            </div>
          </div>
        </div>
      </div>
    </motion.div>
    )}
    </AnimatePresence>
  );
}
