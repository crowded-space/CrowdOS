import { useState } from 'react';
import { Hash, ChevronRight, ChevronDown, Plus, Settings2 } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import type { Channel } from '@/types/crowd-os';
import WorkspaceDropdown from './workspace-dropdown';
import InlineChannelModal from './modals/inline-channel-modal';

export default function WorkspaceSidebar() {
  const {
    workspaces,
    activeWorkspaceId,
    activeChannelId,
    setActiveChannel,
    toggleCategoryCollapse,
    setSettingsModalOpen,
    setWorkspaceSettingsTab,
    setMobileDrawerLeft
  } = useCrowdOSStore();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);

  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);

  const handleSelectChannel = (channelId: string) => {
    setActiveChannel(channelId);
    setMobileDrawerLeft(false);
    try { (navigator as any)?.vibrate?.(6); } catch {}
  };

  const ChannelButton = ({ channel }: { channel: Channel }) => {
    const isActive = channel.id === activeChannelId;
    const hasMention = channel.hasMention;
    const unreads = channel.unreadCount;

    return (
      <button
        key={channel.id}
        onClick={() => handleSelectChannel(channel.id)}
        aria-current={isActive ? 'page' : undefined}
        className={`relative w-full group flex items-center justify-between px-2.5 py-2.5 min-h-[42px] rounded-xl text-[13.5px] font-medium tracking-[-0.01em] text-left transition-all select-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 touch-manipulation active:scale-[0.99] ${
          isActive
            ? 'bg-[#1e1e22] text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] border border-white/[0.06]'
            : 'text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200 border border-transparent'
        }`}
      >
        {isActive && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.5)]" aria-hidden="true" />
        )}
        <div className="flex items-center gap-2.5 min-w-0 truncate pl-1">
          <Hash size={16} className={`shrink-0 transition-colors ${isActive ? 'text-indigo-300' : 'text-zinc-500 group-hover:text-zinc-400'}`} />
          <span className={`truncate ${isActive ? 'text-zinc-100 font-semibold' : ''}`}>{channel.name}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 pl-2">
          {hasMention && (
            <span className="w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(239,68,68,0.5)] animate-pulse" />
          )}
          {unreads > 0 && (
            <span className="px-1.5 py-0.5 min-w-[20px] h-[19px] flex items-center justify-center text-center rounded-full bg-rose-500 text-[10px] font-mono font-bold text-white leading-none">
              {unreads > 99 ? '99+' : unreads}
            </span>
          )}
        </div>
      </button>
    );
  };

  const isLoading = !activeWS;

  return (
    <div
      id="workspace-sidebar"
      className="w-full bg-[#0c0c0f] flex flex-col h-full overflow-hidden select-none"
    >
      {/* Server Header Dropdown */}
      <WorkspaceDropdown />

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
            {/* Top-Level Channels */}
            {activeWS?.channels && activeWS.channels.length > 0 && (
              <div className="space-y-1">
                {activeWS.channels.map(channel => (
                  <ChannelButton key={channel.id} channel={channel} />
                ))}
                <div className="h-px bg-zinc-900/60 my-3 mx-1" />
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
                    className="flex items-center gap-1.5 text-[11px] font-mono tracking-[0.08em] font-bold text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 rounded-lg text-left px-1.5 py-2 min-h-[36px] touch-manipulation active:text-zinc-200"
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
                    className="w-9 h-9 rounded-xl bg-zinc-900/40 hover:bg-zinc-900 border border-transparent hover:border-zinc-800 text-zinc-500 hover:text-zinc-200 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer flex items-center justify-center shrink-0 touch-manipulation active:scale-95"
                    title="Create Channel"
                  >
                    <Plus size={15} aria-hidden="true" />
                  </button>
                </div>

                {/* Collapsible channels list */}
                {!category.collapsed && (
                  <div className="space-y-1 animate-fade-in">
                    {category.channels.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-zinc-600 font-mono">No channels</div>
                    ) : (
                      category.channels.map(channel => (
                        <ChannelButton key={channel.id} channel={channel} />
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}

            {activeWS?.categories.length === 0 && (!activeWS?.channels || activeWS.channels.length === 0) && (
              <div className="text-center py-10 px-4">
                <div className="w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-600">
                  <Hash size={16} />
                </div>
                <p className="text-xs font-medium text-zinc-300">No channels yet</p>
                <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">Create a category or channel to get started.</p>
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
      <div className="bg-[#09090b]/95 backdrop-blur border-t border-zinc-900 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center justify-between gap-2.5 select-none shrink-0" id="sidebar-user-section">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative w-9 h-9 rounded-xl bg-amber-500/12 border border-amber-500/20 text-amber-400 flex items-center justify-center text-[11px] shrink-0 font-bold">
            JH
            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-[#09090b]" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-[13px] font-semibold text-zinc-100 truncate tracking-[-0.01em]">
              Juan Hamzah
            </div>
            <div className="text-[11px] text-zinc-500 truncate font-mono">
              juanhamzah@gmail.com
            </div>
          </div>
        </div>

        <button
          onClick={() => {
            setWorkspaceSettingsTab('overview');
            setSettingsModalOpen(true);
          }}
          aria-label="Open settings"
          className="w-11 h-11 rounded-xl bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/60 hover:border-zinc-700 text-zinc-400 hover:text-zinc-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer flex items-center justify-center shrink-0 active:scale-95 touch-manipulation"
          title="Open Settings Console"
        >
          <Settings2 size={18} className="shrink-0" />
        </button>
      </div>
    </div>
  );
}
