import { useState } from 'react';
import { Hash, ChevronRight, ChevronDown, Plus, Settings2 } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
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
    leaveWorkspace
  } = useCrowdOSStore();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);

  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);

  return (
    <div 
      id="workspace-sidebar"
      className="w-[245px] bg-[#0c0c0e]/95 border-r border-zinc-900 flex flex-col h-full overflow-hidden select-none"
    >
      {/* Server Header Dropdown */}
      <WorkspaceDropdown />

      {/* Nav Content area */}
      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4 scrollbar-thin">
        {/* Top-Level Channels */}
        {activeWS?.channels && activeWS.channels.length > 0 && (
          <div className="space-y-0.5">
            {activeWS.channels.map(channel => {
              const isActive = channel.id === activeChannelId;
              const hasMention = channel.hasMention;
              const unreads = channel.unreadCount;

              return (
                <button
                  key={channel.id}
                  onClick={() => setActiveChannel(channel.id)}
                  className={`w-full group flex items-center justify-between px-2 py-2 md:py-1.5 rounded-lg text-sm text-[13px] md:text-xs font-medium font-sans tracking-tight text-left transition select-none cursor-pointer focus:outline-none ${
                    isActive 
                      ? 'bg-zinc-800/90 text-zinc-100 shadow-sm' 
                      : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 truncate">
                    <Hash size={16} className={`shrink-0 ${isActive ? 'text-zinc-300' : 'text-zinc-500 group-hover:text-zinc-400'}`} />
                    <span className="truncate text-zinc-300 font-semibold">{channel.name}</span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0 pl-1">
                    {hasMention && (
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]" />
                    )}
                    {unreads > 0 && (
                      <span className="px-1.5 py-[1px] min-w-[15px] text-center rounded bg-rose-500 text-[9px] font-mono font-bold text-white selection:bg-transparent">
                        {unreads}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
            <div className="border-b border-zinc-900/40 my-2 pointer-events-none" />
          </div>
        )}

        {activeWS?.categories.map(category => (
          <div key={category.id} className="space-y-0.5" id={`category-${category.id}`}>
            {/* Category header block */}
            <div className="flex items-center justify-between text-[11px] font-mono tracking-wider font-bold text-zinc-500 hover:text-zinc-300 px-1 py-1">
              <button
                onClick={() => toggleCategoryCollapse(category.id)}
                className="flex items-center gap-1 cursor-pointer focus:outline-none text-left p-1"
              >
                {category.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span>{category.name}</span>
              </button>
              
              <button
                onClick={() => {
                  setSelectedCatId(category.id);
                  setCreateModalOpen(true);
                }}
                className="hover:text-zinc-200 transition focus:outline-none cursor-pointer p-1"
                title="Create Channel"
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Collapsible channels list */}
            {!category.collapsed && (
              <div className="space-y-0.5">
                {category.channels.map(channel => {
                  const isActive = channel.id === activeChannelId;
                  const hasMention = channel.hasMention;
                  const unreads = channel.unreadCount;

                  return (
                    <button
                      key={channel.id}
                      onClick={() => setActiveChannel(channel.id)}
                      className={`w-full group flex items-center justify-between px-2 py-2 md:py-1.5 rounded-lg text-sm text-[13px] md:text-xs font-medium font-sans tracking-tight text-left transition select-none cursor-pointer focus:outline-none ${
                        isActive 
                          ? 'bg-zinc-800/90 text-zinc-100 shadow-sm' 
                          : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0 truncate">
                        <Hash size={16} className={`shrink-0 ${isActive ? 'text-zinc-300' : 'text-zinc-500 group-hover:text-zinc-400'}`} />
                        <span className="truncate">{channel.name}</span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0 pl-1">
                        {hasMention && (
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]" />
                        )}
                        {unreads > 0 && (
                          <span className="px-1.5 py-[1px] min-w-[15px] text-center rounded bg-rose-500 text-[9px] font-mono font-bold text-white selection:bg-transparent">
                            {unreads}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
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

      {/* Operator User profile summary bar - Discord Style */}
      <div className="bg-[#09090b] border-t border-zinc-900 p-2.5 flex items-center justify-between gap-2.5 select-none shrink-0" id="sidebar-user-section">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center text-xs shrink-0 select-none font-bold">
            JH
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-xs font-semibold text-zinc-200 truncate tracking-tight font-sans">
              Juan Hamzah
            </div>
            <div className="text-[10px] text-zinc-500 truncate font-mono">
              juanhamzah@gmail.com
            </div>
          </div>
        </div>

        <button 
          onClick={() => {
            setWorkspaceSettingsTab('overview');
            setSettingsModalOpen(true);
          }}
          className="text-zinc-400 hover:text-zinc-100 p-2 hover:bg-zinc-900 rounded-lg transition focus:outline-none cursor-pointer"
          title="Open Settings Console"
        >
          <Settings2 size={18} className="shrink-0" />
        </button>
      </div>
    </div>
  );
}

