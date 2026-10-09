import { useMemo, useState } from 'react';
import { ArrowRight, ClipboardList, FileCode2, RotateCcw, Square, Terminal } from 'lucide-react';
import { useCrowdOSStore, type jobRow } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import { isStoppableRunStatus } from './run-stoppability';

// Terminal run states from the server state machine (run-state-machine.ts).
// Stop is enabled only for live stoppable states (run-stoppability.ts): the
// socket user:cancel transport aborts only in-process runs, so parked
// resumable/orphaned rows disable Stop and use Retry. Only resumable rows
// enable Retry because POST /api/runs/:id/resume rejects every other state
// (routes/runs.ts).
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function formatElapsedMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '\u2014';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return minutes + 'm ' + (totalSeconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

function formatTokens(tokens: number | null | undefined): string {
  return typeof tokens === 'number' ? tokens.toLocaleString() : '\u2014';
}

function formatCost(cost: number | null | undefined): string {
  return typeof cost === 'number' ? '$' + cost.toFixed(4) : '\u2014';
}

function statusTone(status: string): string {
  const st = status.toLowerCase();
  if (st === 'completed') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20';
  if (st === 'failed') return 'bg-rose-500/15 text-rose-300 border-rose-500/20';
  if (st === 'cancelled') return 'bg-zinc-800 text-zinc-400 border-zinc-700';
  if (st === 'resumable' || st === 'orphaned') return 'bg-amber-500/15 text-amber-300 border-amber-500/20';
  return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/20';
}

/**
 * Jobs view (Phase D): cross-channel run table projected from the SAME
 * run.status_changed ingestion the header uses (store jobsByRun). No second
 * run model, no new endpoints, no invented rows: step/tokens/cost render a
 * dash until a real source provides them, unknown runtimes render
 * "unknown", and the empty state says so. Stop reuses the existing
 * cancelRun transport (socket user:cancel); Retry reuses the existing POST
 * /api/runs/:id/resume via retryRun. No Pause exists: the server exposes
 * no pause endpoint (routes/runs.ts has only resume/compensations/get).
 * Resumable rows persist across restart via the store jobs mirror.
 */
export function JobsView(): React.JSX.Element {
  const store = useCrowdOSStore(useShallow(function (s) { return {
    jobsByRun: s.jobsByRun,
    stopRun: s.stopRun,
    retryRun: s.retryRun,
    fetchArtifacts: s.fetchArtifacts,
    setActiveChannel: s.setActiveChannel,
    cancellingByAgent: s.cancellingByAgent,
    agents: s.agents,
    workspaces: s.workspaces,
    activeChannelId: s.activeChannelId,
  }; }));
  const jobsByRun = store.jobsByRun;
  const stopRun = store.stopRun;
  const retryRun = store.retryRun;
  const fetchArtifacts = store.fetchArtifacts;
  const setActiveChannel = store.setActiveChannel;
  const cancellingByAgent = store.cancellingByAgent;
  const agents = store.agents;
  const workspaces = store.workspaces;
  const activeChannelId = store.activeChannelId;
  const [statusFilter, setStatusFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("");
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const channelNameById = useMemo(function () {
    const map: Record<string, string> = {};
    for (const ws of workspaces) {
      for (const ch of (ws.channels || [])) map[ch.id] = "#" + ch.name;
      for (const cat of (ws.categories || [])) {
        for (const ch of (cat.channels || [])) map[ch.id] = "#" + ch.name;
      }
    }
    return map;
  }, [workspaces]);
  const agentNameById = useMemo(function () {
    const map: Record<string, string> = {};
    for (const ag of agents) map[ag.id] = ag.name;
    return map;
  }, [agents]);
  const jobs = useMemo(function () {
    return Object.values(jobsByRun).sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
  }, [jobsByRun]);
  const statuses = useMemo(function () {
    const out: string[] = [];
    for (const job of jobs) { if (!out.includes(job.status)) out.push(job.status); }
    return out.sort();
  }, [jobs]);
  const channelIds = useMemo(function () {
    const out: string[] = [];
    for (const job of jobs) { if (!out.includes(job.channelId)) out.push(job.channelId); }
    return out.sort();
  }, [jobs]);
  const needle = agentFilter.trim().toLowerCase();
  const filtered = jobs.filter(function (job) {
    if (statusFilter !== "all" && job.status !== statusFilter) return false;
    if (channelFilter !== "all" && job.channelId !== channelFilter) return false;
    if (needle) {
      const hay = job.agentIds.map(function (id) { return (agentNameById[id] || id).toLowerCase(); }).join(" ");
      if (hay.indexOf(needle) === -1) return false;
    }
    return true;
  });
  const handleRetry = function (runId: string) {
    setRetryBusy(runId);
    setRetryError(null);
    retryRun(runId).catch(function (err) {
      setRetryError(err instanceof Error ? err.message : "Failed to retry run");
    }).finally(function () { setRetryBusy(null); });
  };
  const handleOpenDiff = function (job: jobRow) {
    fetchArtifacts(job.runId);
    if (job.channelId !== activeChannelId) setActiveChannel(job.channelId);
  };
  const handleOpenLogs = function (job: jobRow) {
    if (job.channelId !== activeChannelId) setActiveChannel(job.channelId);
  };
  const filtersActive = statusFilter !== "all" || channelFilter !== "all" || needle !== "";
  const clearFilters = function () {
    setStatusFilter("all");
    setChannelFilter("all");
    setAgentFilter("");
  };
  return (
    <>
      <div className="px-4 py-3.5 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
        <h2 id="jobs-heading" className="text-[13px] font-medium text-zinc-300 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center" aria-hidden="true">
            <ClipboardList size={12} className="text-zinc-500" aria-hidden="true" />
          </span>
          Jobs
        </h2>
        <span className="tnum text-[11px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-md">{filtered.length}</span>
      </div>
      <div className="px-3 py-2 border-b border-zinc-900 space-y-1.5 shrink-0">
        <label className="block text-[10px] font-mono uppercase tracking-wide text-zinc-500">
          Status
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label="Filter jobs by status"
            className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-mono text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
          >
            <option value="all">All statuses</option>
            {statuses.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </label>
        <label className="block text-[10px] font-mono uppercase tracking-wide text-zinc-500">
          Channel
          <select
            value={channelFilter}
            onChange={e => setChannelFilter(e.target.value)}
            aria-label="Filter jobs by channel"
            className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-mono text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
          >
            <option value="all">All channels</option>
            {channelIds.map(id => <option key={id} value={id}>{channelNameById[id] || id}</option>)}
          </select>
        </label>
        <label className="block text-[10px] font-mono uppercase tracking-wide text-zinc-500">
          Agent
          <input
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            placeholder="Filter by agent name"
            aria-label="Filter jobs by agent"
            className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
          />
        </label>
        {filtersActive && (
          <button
            onClick={clearFilters}
            className="text-[11px] font-mono text-zinc-400 hover:text-zinc-200 underline underline-offset-2 cursor-pointer"
          >
            Clear filters
          </button>
        )}
        {retryError && (
          <p role="alert" className="text-[11px] font-mono text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1.5">
            {retryError}
          </p>
        )}
      </div>
      <div className="flex-1 overflow-auto px-3 py-3 scrollbar-thin overscroll-contain">
        {jobs.length === 0 ? (
          <div className="text-center py-12 px-4">
            <div className="w-12 h-12 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-500" aria-hidden="true">
              <ClipboardList size={18} aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-300">No jobs yet</p>
            <p className="text-xs text-zinc-500 mt-1">Queued runs will appear here once run status events arrive.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 px-4">
            <p className="text-sm font-medium text-zinc-300">No jobs match these filters</p>
            <button
              onClick={clearFilters}
              className="mt-2 text-xs font-mono text-zinc-400 hover:text-zinc-200 underline underline-offset-2 cursor-pointer"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-[11px] font-mono">
              <caption className="sr-only">Cross-channel runs with status and actions</caption>
              <thead>
                <tr className="text-left text-zinc-500">
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Channel</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Agents</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Runtime</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Step</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Elapsed</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Tokens</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Cost</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Status</th>
                  <th scope="col" className="font-medium px-2 py-1.5 whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(job => {
                  const terminal = TERMINAL_RUN_STATUSES.has(job.status.toLowerCase());
                  const stoppable = isStoppableRunStatus(job.status);
                  const resumable = job.status.toLowerCase() === String("resumable");
                  const orphaned = job.status.toLowerCase() === String("orphaned");
                  const cancelling = job.status.toLowerCase() === String("cancelling");
                  const stopping = Object.keys(cancellingByAgent).some(k => k.startsWith(job.channelId + String(":")));
                  const agentsLabel = job.agentIds.length > 0
                    ? job.agentIds.map(id => agentNameById[id] || id).join(String(", "))
                    : String("\u2014");
                  return (
                    <tr key={job.runId} className="border-t border-zinc-900 align-top">
                      <td className="px-2 py-2 text-zinc-200 whitespace-nowrap" title={job.channelId}>{channelNameById[job.channelId] || job.channelId}</td>
                      <td className="px-2 py-2 text-zinc-400 max-w-[140px] truncate" title={agentsLabel}>{agentsLabel}</td>
                      <td className="px-2 py-2 text-zinc-400 whitespace-nowrap">{job.runtime || String("unknown")}</td>
                      <td className="px-2 py-2 text-zinc-400 whitespace-nowrap">{job.step || String("\u2014")}</td>
                      <td className="px-2 py-2 tnum text-zinc-400 whitespace-nowrap">{formatElapsedMs(job.elapsedMs)}</td>
                      <td className="px-2 py-2 tnum text-zinc-400 whitespace-nowrap">{formatTokens(job.tokens)}</td>
                      <td className="px-2 py-2 tnum text-zinc-400 whitespace-nowrap">{formatCost(job.cost)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className={String("inline-block px-1.5 py-0.5 rounded border ") + statusTone(job.status)}>{job.status}{resumable ? String(" \u00b7 resumable") : null}</span>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <button
                            onClick={() => stopRun(job.runId)}
                            disabled={!stoppable || stopping}
                            title={terminal ? String("Run already ") + job.status : resumable ? String("Parked run — use Retry to resume") : orphaned ? String("Parked run — Stop unavailable") : cancelling ? String("Run is already stopping") : String("Stop this run")}
                            aria-label={String("Stop run ") + job.runId}
                            className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                          >
                            <Square size={12} aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => handleRetry(job.runId)}
                            disabled={!resumable || retryBusy !== null}
                            title={resumable ? String("Retry this run (resume from checkpoint)") : String("Only resumable runs can be retried")}
                            aria-label={String("Retry run ") + job.runId}
                            className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                          >
                            <RotateCcw size={12} aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => { if (job.channelId !== activeChannelId) setActiveChannel(job.channelId); }}
                            title={String("Jump to ") + (channelNameById[job.channelId] || job.channelId)}
                            aria-label={String("Jump to channel for run ") + job.runId}
                            className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                          >
                            <ArrowRight size={12} aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => handleOpenDiff(job)}
                            title="Open this run diffs (loads artifacts, jumps to its channel)"
                            aria-label={String("Open diffs for run ") + job.runId}
                            className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                          >
                            <FileCode2 size={12} aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => handleOpenLogs(job)}
                            title="Open this run logs (the channel message stream is the log source)"
                            aria-label={String("Open logs for run ") + job.runId}
                            className="w-7 h-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                          >
                            <Terminal size={12} aria-hidden="true" />
                          </button>
                        </span>
                        {stopping && !terminal && (
                          <span className="block text-[10px] text-zinc-500 mt-1">Stopping...</span>
                        )}
                        {retryBusy === job.runId && (
                          <span className="block text-[10px] text-zinc-500 mt-1">Retrying...</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="px-4 py-2 border-t border-zinc-900 text-[10px] font-mono text-zinc-600 shrink-0 select-none">
        No Pause: the server exposes no pause endpoint, so Stop and Retry are the only run actions.
      </p>
    </>
  );
}

export default JobsView;
