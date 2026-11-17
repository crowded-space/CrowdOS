import React, { useCallback, useMemo } from 'react';
import { Network } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import AgentRow from './AgentRow';
import { isStoppableRunStatus } from './run-stoppability';

// Terminal run states mirror JobsView/RunHeader (server run-state-machine).
// Terminal rows render a static snapshot and hide Stop; non-terminal rows
// tick elapsed, and Stop shows only for live stoppable states (parked
// resumable/orphaned rows have no controller behind the user:cancel
// transport). No pauseRun exists: routes/runs.ts exposes only
// resume/compensations/get.
const TERMINAL_ROSTER_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Roster excludes the Owl/librarian heartbeat indexing service: it is not
// conversational (UX_GUIDELINE.md S1/S13) so it never appears as a chat
// target. No owl-species rows exist client-side today; this filter keeps
// that invariant if one ever arrives (exclusion reported in docs).
function isServiceAgentRow(ag: { species?: string; name?: string }): boolean {
  const species = String(ag.species ?? '').toLowerCase();
  const name = String(ag.name ?? '').toLowerCase();
  return species === 'owl' || species === 'librarian' || name === 'owl' || name === 'librarian';
}

/**
 * Operations roster: agent identity rows grouped by authority tier with
 * presence-site run lookup. Reads the SAME store projections as the desktop
 * right panel (agents, jobsByRun, cancellingByAgent) — no second roster or
 * run model; both RightSidebar (xl+) and OperationsSheet (below xl) mount
 * it, so the panel is reachable at every viewport width (UI audit §2.16,
 * 2026-10-22). Returns a fragment: the host owns the panel container
 * (w-[260px] column in the right sidebar, full-width column in the sheet).
 */
export function RosterPanel(): React.JSX.Element {
  const { agents, openAgentProfileModal, jobsByRun, stopRun, cancellingByAgent } = useCrowdOSStore(useShallow(s => ({
    agents: s.agents,
    openAgentProfileModal: s.openAgentProfileModal,
    jobsByRun: s.jobsByRun,
    stopRun: s.stopRun,
    cancellingByAgent: s.cancellingByAgent,
  })));

  // Filter agents into corporate tiers (service rows excluded via helper).
  const visibleAgents = useMemo(() => agents.filter(ag => !isServiceAgentRow(ag)), [agents]);
  const tierL0 = visibleAgents.filter(ag => ag.level === 0);
  const tierL1 = visibleAgents.filter(ag => ag.level === 1);
  const tierL2 = visibleAgents.filter(ag => ag.level === 2);
  const tierL3 = visibleAgents.filter(ag => ag.level === 3);

  // Group level tags — hoisted to AgentRow component (memoized)
  const handleOpenAgent = useCallback((id: string) => openAgentProfileModal(id), [openAgentProfileModal]);
  const handleStopRun = useCallback((runId: string) => stopRun(runId), [stopRun]);

  // Presence-site run lookup: latest non-terminal job naming this agent wins,
  // else the latest job of any status (static snapshot, Stop hidden). Reads
  // the SAME jobsByRun projection JobsView/RunHeader use (run.status_changed),
  // never a second run model; elapsed is honest wall-clock observation and
  // cost renders a dash until a real source provides it (job.cost is null
  // today). Owl/librarian species are roster-filtered, never chat targets.
  const presenceByAgent = useMemo(() => {
    const jobs = Object.values(jobsByRun ?? {}).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const byAgent = new Map<string, { runId: string; elapsedMs: number | null; cost: number | null; liveSince: string | null; live: boolean; stopping: boolean; canStop: boolean }>();
    const cancellingKeys = Object.keys(cancellingByAgent ?? {});
    for (const job of jobs) {
      const terminal = TERMINAL_ROSTER_RUN_STATUSES.has(String(job.status).toLowerCase());
      const stopping = cancellingKeys.some(k => k.startsWith(job.channelId + ':'));
      for (const agentId of job.agentIds) {
        const prev = byAgent.get(agentId);
        // Jobs sorted newest-first: first live job wins; a terminal job only
        // fills the slot when no live job named this agent.
        if (!prev) {
          byAgent.set(agentId, {
            runId: job.runId,
            elapsedMs: job.elapsedMs ?? null,
            cost: job.cost ?? null,
            liveSince: job.firstSeenAt ?? null,
            live: !terminal,
            stopping,
            canStop: isStoppableRunStatus(job.status),
          });
        } else if (!prev.live && !terminal) {
          byAgent.set(agentId, {
            runId: job.runId,
            elapsedMs: job.elapsedMs ?? null,
            cost: job.cost ?? null,
            liveSince: job.firstSeenAt ?? null,
            live: true,
            stopping,
            canStop: isStoppableRunStatus(job.status),
          });
        }
      }
    }
    return byAgent;
  }, [jobsByRun, cancellingByAgent]);

  const renderTier = (
    tierAgents: typeof tierL0,
    label: string,
    dotClass: string,
    badgeClass: string,
    id?: string,
  ) => (
    <div className="space-y-2" id={id}>
      <h3 className="text-[13px] font-medium text-zinc-300 px-1 flex items-center gap-2">
        <span className={dotClass} />
        {label}
        <span className={`tnum ml-auto text-[10px] font-mono font-medium px-1.5 py-0.5 rounded ${badgeClass}`}>{tierAgents.length}</span>
      </h3>
      <div className="space-y-1">
        {tierAgents.map(ag => {
          const presence = presenceByAgent.get(ag.id);
          return (
            <AgentRow
              key={ag.id}
              {...ag}
              onOpen={handleOpenAgent}
              runId={presence?.runId ?? null}
              elapsedMs={presence?.elapsedMs ?? null}
              cost={presence?.cost ?? null}
              liveSince={presence?.liveSince ?? null}
              live={presence?.live ?? false}
              stopping={presence?.stopping ?? false}
              canStop={presence?.canStop ?? false}
              onStop={handleStopRun}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      {/* Title — larger, calmer */}
      <div className="px-4 py-3.5 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
        <h2 id="roster-heading" className="text-[13px] font-medium text-zinc-300 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center" aria-hidden="true">
            <Network size={12} className="text-zinc-500" aria-hidden="true" />
          </span>
          Operations roster
        </h2>
        <span className="tnum text-[11px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-md">{visibleAgents.length}</span>
      </div>

      {/* Roster Area — airy spacing, progressive disclosure */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 scrollbar-thin overscroll-contain">
        {tierL0.length > 0 && renderTier(tierL0, 'L0 · Surveillance', 'w-1.5 h-1.5 rounded-sm bg-cyan-400', 'bg-cyan-500/10 border border-cyan-500/20 text-cyan-300')}
        {tierL1.length > 0 && renderTier(tierL1, 'L1 · Executive', 'w-1.5 h-1.5 rounded-sm bg-rose-400', 'bg-rose-500/10 border border-rose-500/20 text-rose-300', 'roster-tier-l1')}
        {tierL2.length > 0 && renderTier(tierL2, 'L2 · Coordinators', 'w-1.5 h-1.5 rounded-sm bg-indigo-400', 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-300')}
        {tierL3.length > 0 && renderTier(tierL3, 'L3 · Workers', 'w-1.5 h-1.5 rounded-sm bg-emerald-400', 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300')}

        {visibleAgents.length === 0 && (
          <div className="text-center py-12 px-4">
            <div className="w-12 h-12 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-500" aria-hidden="true">
              <Network size={18} aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-300">No agents yet</p>
            <p className="text-xs text-zinc-500 mt-1">Spawn your first agent in Settings → Agents Board.</p>
          </div>
        )}
      </div>
    </>
  );
}

export default RosterPanel;
