import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Hash, Users, Hammer, MessageSquare, X, ArrowRight } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';

interface OmniSearchModalProps {
  open: boolean;
  onClose: () => void;
}

export default function OmniSearchModal({ open, onClose }: OmniSearchModalProps) {
  const { 
    workspaces, 
    activeWorkspaceId, 
    agents, 
    tools, 
    messages, 
    setActiveChannel, 
    openAgentProfileModal 
  } = useCrowdOSStore();

  const [query, setQuery] = useState('');

  // Keybinding trigger listener (Cmd+K or Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (open) onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const activeWS = workspaces.find(w => w.id === activeWorkspaceId);
  const allChannels = activeWS?.categories.flatMap(cat => cat.channels) || activeWS?.channels || [];

  const filteredChannels = query.trim() 
    ? allChannels.filter(c => c.name.toLowerCase().includes(query.toLowerCase()))
    : allChannels.slice(0, 5);

  const filteredAgents = query.trim()
    ? agents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()) || a.species.toLowerCase().includes(query.toLowerCase()))
    : agents.slice(0, 5);

  const filteredTools = query.trim()
    ? tools.filter(t => t.name.toLowerCase().includes(query.toLowerCase()) || t.id.toLowerCase().includes(query.toLowerCase()))
    : tools.slice(0, 4);

  const filteredMessages = query.trim()
    ? messages.filter(m => m.content.toLowerCase().includes(query.toLowerCase())).slice(0, 5)
    : [];

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[9995] flex items-start justify-center pt-20 p-4 font-sans select-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ type: "spring", duration: 0.25 }}
            className="relative w-full max-w-xl bg-[#0c0c0e] border border-zinc-800 rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[75vh]"
          >
            {/* Search Input Bar */}
            <div className="flex items-center px-4 py-3 border-b border-zinc-800 bg-zinc-950/80 shrink-0">
              <Search size={18} className="text-zinc-400 shrink-0 mr-3" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type to search channels, agents, tools, or message history... (Esc to close)"
                className="w-full bg-transparent border-none text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-0"
              />
              <button
                onClick={onClose}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-md hover:bg-zinc-900 transition focus:outline-none cursor-pointer shrink-0"
              >
                <X size={15} />
              </button>
            </div>

            {/* Results List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-thin">
              {/* Channels Section */}
              {filteredChannels.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-mono font-bold text-zinc-500 px-2 py-0.5 uppercase tracking-wider">
                    Channels ({filteredChannels.length})
                  </div>
                  {filteredChannels.map(ch => (
                    <button
                      key={ch.id}
                      onClick={() => {
                        setActiveChannel(ch.id);
                        onClose();
                      }}
                      className="w-full flex items-center justify-between px-2.5 py-2 hover:bg-zinc-900 rounded-lg text-xs font-sans text-left transition select-none cursor-pointer group"
                    >
                      <div className="flex items-center gap-2">
                        <Hash size={14} className="text-zinc-400 group-hover:text-indigo-400 transition" />
                        <span className="font-semibold text-zinc-200">{ch.name}</span>
                        {ch.description && (
                          <span className="text-zinc-500 text-[11px] truncate max-w-xs">{ch.description}</span>
                        )}
                      </div>
                      <ArrowRight size={13} className="text-zinc-600 group-hover:text-zinc-300 transition" />
                    </button>
                  ))}
                </div>
              )}

              {/* Agents Section */}
              {filteredAgents.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-mono font-bold text-zinc-500 px-2 py-0.5 uppercase tracking-wider">
                    Agents ({filteredAgents.length})
                  </div>
                  {filteredAgents.map(ag => (
                    <button
                      key={ag.id}
                      onClick={() => {
                        openAgentProfileModal(ag.id);
                        onClose();
                      }}
                      className="w-full flex items-center justify-between px-2.5 py-2 hover:bg-zinc-900 rounded-lg text-xs font-sans text-left transition select-none cursor-pointer group"
                    >
                      <div className="flex items-center gap-2">
                        <Users size={14} className="text-indigo-400 shrink-0" />
                        <span className="font-semibold text-zinc-200">{ag.name}</span>
                        <span className="text-zinc-500 font-mono text-[10px]">{ag.species} • L{ag.level}</span>
                      </div>
                      <span className="text-[10px] font-mono text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">View Profile</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Tools Section */}
              {filteredTools.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-mono font-bold text-zinc-500 px-2 py-0.5 uppercase tracking-wider">
                    Enabled Tools ({filteredTools.length})
                  </div>
                  {filteredTools.map(t => (
                    <div
                      key={t.id}
                      className="w-full flex items-center justify-between px-2.5 py-2 hover:bg-zinc-900/50 rounded-lg text-xs font-sans text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Hammer size={14} className="text-emerald-400 shrink-0" />
                        <span className="font-mono font-semibold text-zinc-200">{t.id}</span>
                        <span className="text-zinc-400 text-[11px]">{t.name}</span>
                      </div>
                      <span className="text-[10px] font-mono text-zinc-500">{t.category}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Message Matches */}
              {filteredMessages.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-mono font-bold text-zinc-500 px-2 py-0.5 uppercase tracking-wider">
                    Matching Messages ({filteredMessages.length})
                  </div>
                  {filteredMessages.map(m => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setActiveChannel(m.channelId);
                        onClose();
                      }}
                      className="w-full flex items-start gap-2 px-2.5 py-2 hover:bg-zinc-900 rounded-lg text-xs font-sans text-left transition"
                    >
                      <MessageSquare size={14} className="text-zinc-500 mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <span className="font-semibold text-zinc-300 font-mono text-[11px] mr-2">{m.authorName}:</span>
                        <span className="text-zinc-400 truncate text-[11.5px]">{m.content}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {query.trim() && filteredChannels.length === 0 && filteredAgents.length === 0 && filteredMessages.length === 0 && (
                <div className="text-center py-8 text-zinc-500 text-xs font-sans">
                  No matching entities or logs found for "{query}".
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
