import { useState, useCallback, useMemo } from 'react';
import { Clock, Hash, ChevronRight, ChevronDown, Plus, Search, Settings2, Star, Database } from 'lucide-react';
import type { Channel } from '@/types/crowdOs';
import { safeGet, safeSet } from '@/src/config/desktop-storage';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import WorkspaceDropdown from './WorkspaceDropdown';
import InlineChannelModal from './modals/InlineChannelModal';
import ChannelButton from './ChannelButton';
import OperatorProfileModal from './modals/OperatorProfileModal';
import ThemeToggle from '@/components/ui/ThemeToggle';
import { loadOperatorProfile } from './operator-profile-model';

interface WorkspaceSidebarProps {
  onClose?: () => void;
}

export default function WorkspaceSidebar({ onClose }: WorkspaceSidebarProps) {
  const {
    workspaces,
    activeWorkspaceId,
    activeChannelId,
    setActiveChannel,
    toggleCategoryCollapse,
    setSettingsModalOpen,
    setWorkspaceSettingsTab,
    isDatabaseOffline,
    databaseErrorMessage,
    fetchWorkspaces,
    draftByChannel,
    approvalRequests,
    inboxDeferred,
    jobsByRun,
    runRuntimeByRun,
  } = useCrowdOSStore(useShallow(s => ({
    workspaces: s.workspaces,
    activeWorkspaceId: s.activeWorkspaceId,
    activeChannelId: s.activeChannelId,
    setActiveChannel: s.setActiveChannel,
    toggleCategoryCollapse: s.toggleCategoryCollapse,
    setSettingsModalOpen: s.setSettingsModalOpen,
    setWorkspaceSettingsTab: s.setWorkspaceSettingsTab,
    isDatabaseOffline: s.isDatabaseOffline,
    databaseErrorMessage: s.databaseErrorMessage,
    fetchWorkspaces: s.fetchWorkspaces,
    draftByChannel: s.draftByChannel,
    approvalRequests: s.approvalRequests,
    inboxDeferred: s.inboxDeferred,
    jobsByRun: s.jobsByRun,
    runRuntimeByRun: s.runRuntimeByRun,
  })));

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);

  const [filter, setFilter] = useState('');
  const [operatorProfile, setOperatorProfile] = useState(() => loadOperatorProfile());
  const [profileOpen, setProfileOpen] = useState(false);
  const operatorInitials = useMemo(() => {
    const parts = operatorProfile.name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'LO';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }, [operatorProfile.name]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => {
    try {
      const raw = safeGet('crowdos_sidebar_favorites');
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string');
    } catch { return []; }
  });

  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);

  const handleSelectChannel = useCallback((channelId: string) => {
    setActiveChannel(channelId);
    onClose?.();
  }, [onClose, setActiveChannel]);

  // Favorites are a local-only overlay (crowdos_sidebar_favorites). Toggling
  // a star never touches the shared workspace tree, only localStorage.
  const toggleFavorite = useCallback((channelId: string) => {
    setFavoriteIds(prev => {
      const next = prev.includes(channelId)
        ? prev.filter(id => id !== channelId)
        : [...prev, channelId];
      try { safeSet('crowdos_sidebar_favorites', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const allChannels: Channel[] = useMemo(() => {
    if (!activeWS) return [];
    return [...(activeWS.channels || []), ...activeWS.categories.flatMap(c => c.channels || [])];
  }, [activeWS]);

  // Approval counts per channel from live approvalRequests (pending,
  // non-deferred only). Requests without a channelId cannot map to a row
  // and are omitted, never guessed.
  const approvalCountByChannel: Record<string, number> = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const req of approvalRequests || []) {
      if (req.status !== 'pending') continue;
      if ((inboxDeferred || {})[req.id]) continue;
      const cid = req.channelId ?? null;
      if (!cid) continue;
      counts[cid] = (counts[cid] ?? 0) + 1;
    }
    return counts;
  }, [approvalRequests, inboxDeferred]);

  // Live-run state per channel from the shared jobsByRun projection (the
  // same model JobsView renders). Terminal rows (completed/failed/
  // cancelled) are not live; channels with no live row render no badge.
  const liveByChannel: Record<string, { runtime: string | null }> = useMemo(() => {
    const live: Record<string, { runtime: string | null }> = {};
    const rows = Object.values(jobsByRun || {});
    for (const job of rows) {
      const st = String(job.status || '').toLowerCase();
      if (st === 'completed' || st === 'failed' || st === 'cancelled') continue;
      if (!job.channelId) continue;
      if (live[job.channelId]) continue;
      live[job.channelId] = { runtime: job.runtime ?? (runRuntimeByRun || {})[job.runId] ?? null };
    }
    return live;
  }, [jobsByRun, runRuntimeByRun]);

  const normalizedFilter = filter.trim().toLowerCase();
  const matchesFilter = useCallback((ch: Channel) => {
    if (!normalizedFilter) return true;
    return ch.name.toLowerCase().includes(normalizedFilter);
  }, [normalizedFilter]);

  // Favorites resolve against the live tree, so deleted channels drop out.
  const favoriteChannels = useMemo(
    () => allChannels.filter(ch => favoriteIds.includes(ch.id)),
    [allChannels, favoriteIds],
  );

  // Recents from honest activity signals only: unread, mention, draft, or
  // the active channel. There is no visit-history source, so nothing here
  // claims recency beyond live activity.
  const recentChannels = useMemo(() => {
    const scored = allChannels.map(ch => {
      let score = 0;
      if (ch.hasMention) score += 3;
      if (ch.unreadCount > 0) score += 2;
      if (draftByChannel[ch.id]?.text) score += 1;
      if (ch.id === activeChannelId) score += 1;
      return { ch, score };
    }).filter(s => s.score > 0);
    scored.sort((a, b) => b.score - a.score || a.ch.name.localeCompare(b.ch.name));
    return scored.slice(0, 5).map(s => s.ch);
  }, [allChannels, draftByChannel, activeChannelId]);

  // One row renderer for every channel list (personal + shared). Badges
  // come from the shared projections; the star toggles only local
  // favorites and never mutates the shared tree.
  const renderChannelRow = useCallback((channel: Channel) => {
    const isFav = favoriteIds.includes(channel.id);
    return (
      <div key={channel.id} className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <ChannelButton
            channel={channel}
            isActive={channel.id === activeChannelId}
            onSelect={handleSelectChannel}
            draftPreview={draftByChannel[channel.id]?.text || undefined}
            approvalCount={approvalCountByChannel[channel.id] ?? 0}
            isLive={Boolean(liveByChannel[channel.id])}
            liveRuntime={liveByChannel[channel.id]?.runtime ?? null}
          />
        </div>
        <button
          onClick={() => toggleFavorite(channel.id)}
          aria-pressed={isFav}
          aria-label={`${isFav ? 'Remove' : 'Add'} #${channel.name} ${isFav ? 'from' : 'to'} favorites`}
          title={isFav ? 'Remove from favorites' : 'Add to favorites'}
          className="w-7 h-7 shrink-0 rounded-lg border border-transparent hover:border-zinc-800 text-zinc-600 hover:text-amber-300 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer flex items-center justify-center active:scale-95"
        >
          <Star size={13} aria-hidden="true" className={isFav ? 'fill-amber-400 text-amber-400' : ''} />
        </button>
      </div>
    );
  }, [favoriteIds, activeChannelId, handleSelectChannel, draftByChannel, approvalCountByChannel, liveByChannel, toggleFavorite]);

  const isLoading = !activeWS;

  return (
    <div
      id="workspace-sidebar"
      className="w-full bg-[#0c0c0f] flex flex-col h-full overflow-hidden select-none"
    >
      {/* Server Header Dropdown */}
      <WorkspaceDropdown />

      {/* Degraded State Banner */}
      {isDatabaseOffline && (
        <div className="mx-2.5 mt-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 flex items-start gap-2.5 select-text">
          <Database size={15} className="shrink-0 text-amber-400 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold leading-tight text-amber-300">Database Offline</div>
            <div className="text-[10.5px] text-amber-400/80 leading-snug mt-0.5 line-clamp-2">
              {databaseErrorMessage || "Could not reach workspace database. Operations are running in degraded mode."}
            </div>
            <div className="flex gap-1.5 mt-2">
              <button onClick={() => void fetchWorkspaces()} className="px-2 py-1 text-[10.5px] font-semibold rounded-md bg-amber-400/15 hover:bg-amber-400/25 text-amber-200 border border-amber-400/30 transition cursor-pointer">Retry Connection</button>
              <button onClick={() => { setWorkspaceSettingsTab('overview'); setSettingsModalOpen(true); }} className="px-2 py-1 text-[10.5px] font-semibold rounded-md hover:bg-amber-400/10 text-amber-300/90 border border-transparent hover:border-amber-400/20 transition cursor-pointer">Edit Database Settings</button>
            </div>
          </div>
        </div>
      )}

      {/* Nav Content area */}
      <div className="flex-1 overflow-y-auto px-2.5 py-3 space-y-5 scrollbar-thin overscroll-contain">
        {isLoading ? (
          <div className="space-y-2 animate-pulse">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="h-[42px] rounded-xl skeleton" />
            ))}
          </div>
        ) : (
          <>
            {/* Channel filter */}
            <div className="px-1">
              <label htmlFor="sidebar-channel-filter" className="sr-only">Filter channels</label>
              <div className="relative">
                <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
                <input
                  id="sidebar-channel-filter"
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter channels"
                  autoComplete="off"
                  className="w-full min-h-[36px] rounded-xl border border-zinc-800/60 bg-zinc-900/40 py-2 pl-8 pr-2 text-[12.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                />
              </div>
            </div>

            {/* Personal navigation overlay: local-only favorites + recent
                activity. Read-only over the shared tree, never mutates it. */}
            {(favoriteChannels.filter(matchesFilter).length > 0 || recentChannels.filter(matchesFilter).length > 0) && (
              <section aria-label="Personal navigation" className="space-y-3">
                {favoriteChannels.filter(matchesFilter).length > 0 && (
                  <div className="space-y-1">
                    <h3 className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      <Star size={11} aria-hidden="true" />
                      <span>Favorites</span>
                    </h3>
                    <div role="group" aria-label="Favorite channels" className="space-y-1">
                      {favoriteChannels.filter(matchesFilter).map(renderChannelRow)}
                    </div>
                  </div>
                )}
                {recentChannels.filter(matchesFilter).length > 0 && (
                  <div className="space-y-1">
                    <h3 className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      <Clock size={11} aria-hidden="true" />
                      <span>Recent activity</span>
                    </h3>
                    <p className="px-1 text-[10.5px] leading-snug text-zinc-600">From unread, mentions, drafts, and the open channel.</p>
                    <div role="group" aria-label="Recently active channels" className="space-y-1">
                      {recentChannels.filter(matchesFilter).map(renderChannelRow)}
                    </div>
                  </div>
                )}
                <div className="h-px bg-zinc-900/60 mx-1" aria-hidden="true" />
              </section>
            )}

            {/* Top-Level Channels */}
            {activeWS?.channels && activeWS.channels.filter(matchesFilter).length > 0 && (
              <div className="space-y-1">
                {activeWS.channels.filter(matchesFilter).map(renderChannelRow)}
                <div className="h-px bg-zinc-900/60 my-3 mx-1" aria-hidden="true" />
              </div>
            )}

            {activeWS?.categories.map(category => (
              <div key={category.id} className="space-y-1" id={`category-${category.id}`}>
                {/* Category header block — larger touch target */}
                <div className="flex items-center justify-between px-1 py-0.5">
                  <button
                    onClick={() => toggleCategoryCollapse(category.id)}
                    aria-label={`${category.collapsed ? 'Expand' : 'Collapse'} category ${category.name}`}
                    aria-expanded={!category.collapsed}
                    className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors duration-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 rounded-lg text-left px-1.5 py-2 min-h-[36px] active:text-zinc-200"
                  >
                    <span className="w-5 h-5 rounded-md bg-zinc-900/60 border border-zinc-800/60 flex items-center justify-center shrink-0">
                      {category.collapsed ? <ChevronRight size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
                    </span>
                    <span className="truncate max-w-[140px]">{category.name}</span>
                  </button>

                  <button
                    onClick={() => {
                      setSelectedCatId(category.id);
                      setCreateModalOpen(true);
                    }}
                    aria-label={`Create channel in ${category.name}`}
                    className="w-9 h-9 rounded-xl bg-zinc-900/40 hover:bg-zinc-900 border border-transparent hover:border-zinc-800 text-zinc-500 hover:text-zinc-200 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer flex items-center justify-center shrink-0 active:scale-95"
                    title="Create Channel"
                  >
                    <Plus size={15} aria-hidden="true" />
                  </button>
                </div>

                {/* Collapsible channels list */}
                {!category.collapsed && (
                  <div className="space-y-1 animate-fade-in">
                    {category.channels.filter(matchesFilter).length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-zinc-600 font-mono" role="status">{normalizedFilter ? 'No matching channels' : 'No channels'}</div>
                    ) : (
                      category.channels.filter(matchesFilter).map(renderChannelRow)
                    )}
                  </div>
                )}
              </div>
            ))}

            {normalizedFilter && allChannels.filter(matchesFilter).length === 0 && (
              <div className="text-center py-8 px-4" role="status">
                <p className="text-xs font-medium text-zinc-300">No channels match &ldquo;{filter.trim()}&rdquo;</p>
                <p className="text-[11px] text-zinc-500 mt-1">Clear the filter to see the full list.</p>
              </div>
            )}

            {!normalizedFilter && activeWS?.categories.length === 0 && (!activeWS?.channels || activeWS.channels.length === 0) && (
              <div className="text-center py-10 px-4" role="status">
                <div className="w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-500" aria-hidden="true">
                  <Hash size={16} aria-hidden="true" />
                </div>
                <p className="text-xs font-medium text-zinc-300">No channels yet</p>
                <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">Create a category or channel to open your first thread.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Inline Channel Creation Modal */}
      <InlineChannelModal
        open={createModalOpen}
        categoryId={selectedCatId}
        onClose={() => {
          setCreateModalOpen(false);
          setSelectedCatId(null);
        }}
      />

      {/* Operator profile — sticky bottom, safe area */}
      <div className="bg-[#09090b] border-t border-zinc-900 p-2 flex items-center justify-between gap-1 select-none shrink-0" id="sidebar-user-section">
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          aria-label="Open user profile"
          title="Open user profile"
          className="flex items-center gap-1 min-w-0 text-left rounded-xl px-1 py-0.5 hover:bg-zinc-900/60 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer"
        >
          <div className="relative w-9 h-9 rounded-xl bg-amber-500/12 border border-amber-500/20 text-amber-400 flex items-center justify-center text-[11px] shrink-0 font-bold">
            {operatorInitials}
            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-zinc-500 border-2 border-[#09090b]" title="Local profile - presence unknown (no live source)" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-[13px] font-semibold text-zinc-100 truncate tracking-[-0.01em]">
              {operatorProfile.name}
            </div>
            <div className="text-[11px] text-zinc-500 truncate font-mono">
              {operatorProfile.tag}
            </div>
          </div>
        </button>

        <div className="flex items-center gap-1 shrink-0 [&>button]:w-7 [&>button]:h-7">
          <ThemeToggle />
          <button
            onClick={() => {
              setWorkspaceSettingsTab('overview');
              setSettingsModalOpen(true);
            }}
            aria-label="Open settings"
            className="w-11 h-11 rounded-xl bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/60 hover:border-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer flex items-center justify-center shrink-0 active:scale-95"
            title="Open settings console"
          >
            <Settings2 size={18} className="shrink-0" />
          </button>
        </div>
      </div>

      <OperatorProfileModal
        open={profileOpen}
        onClose={() => {
          setProfileOpen(false);
          setOperatorProfile(loadOperatorProfile());
        }}
      />
    </div>
  );
}
