import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Hash, Users, Hammer, MessageSquare, X, ArrowRight } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useOverlayFocus } from '@/components/ui/use-overlay-focus';

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
  const [serverResults, setServerResults] = useState<{
    channels: Array<{ id: string; name: string; categoryId?: string | null; type?: string; description?: string }>;
    messages: Array<{ id: string; channelId: string; authorId: string; authorName: string; content: string; timestamp?: string }>;
  } | null>(null);
  const [isSearchingServer, setIsSearchingServer] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useOverlayFocus(open, dialogRef, {
    initialFocusRef: searchInputRef,
    fallbackFocusSelector: '[aria-label="Search"]',
  });

  // Keybinding trigger listener (Cmd+K or Ctrl+K) and Escape + body lock
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (open) onClose();
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      // reset query on open
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        document.body.style.overflow = prev;
      };
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setServerResults(null);
    }
  }, [open]);

  // UX-8: Wire server search endpoint for deep DB queries across channels and messages
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !open) {
      setServerResults(null);
      setIsSearchingServer(false);
      return;
    }

    let active = true;
    setIsSearchingServer(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=20`);
        if (res.ok && active) {
          const data = await res.json();
          setServerResults({
            channels: data.channels || [],
            messages: data.messages || [],
          });
        }
      } catch (err) {
        console.error('Omni-search server query failed:', err);
      } finally {
        if (active) setIsSearchingServer(false);
      }
    }, 200);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  const activeWS = workspaces.find(w => w.id === activeWorkspaceId);
  const allChannels = [ ...(activeWS?.channels || []), ...(activeWS?.categories.flatMap(cat => cat.channels) || []) ];

  // Merge server channel results with local channels
  const filteredChannels = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return allChannels.slice(0, 5);

    const seen = new Set<string>();
    const merged: Array<{ id: string; name: string; description?: string }> = [];

    // Local matches
    allChannels.forEach(c => {
      if (c.name.toLowerCase().includes(trimmed)) {
        seen.add(c.id);
        merged.push(c);
      }
    });

    // Server matches
    if (serverResults?.channels) {
      serverResults.channels.forEach(sc => {
        if (!seen.has(sc.id)) {
          seen.add(sc.id);
          const localMatch = allChannels.find(c => c.id === sc.id);
          merged.push(localMatch || sc);
        }
      });
    }

    return merged.slice(0, 10);
  }, [query, allChannels, serverResults]);

  const filteredAgents = query.trim()
    ? agents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()) || a.species.toLowerCase().includes(query.toLowerCase()))
    : agents.slice(0, 5);

  const filteredTools = query.trim()
    ? tools.filter(t => t.name.toLowerCase().includes(query.toLowerCase()) || t.id.toLowerCase().includes(query.toLowerCase()))
    : tools.slice(0, 4);

  // Merge server messages with in-memory messages
  const filteredMessages = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];

    const seen = new Set<string>();
    const merged: Array<{ id: string; channelId: string; authorName: string; content: string }> = [];

    // Server messages first (persisted historical data)
    if (serverResults?.messages) {
      serverResults.messages.forEach(sm => {
        if (!seen.has(sm.id)) {
          seen.add(sm.id);
          merged.push(sm);
        }
      });
    }

    // In-memory messages (recent streaming or local state)
    messages.forEach(m => {
      if (m.content.toLowerCase().includes(trimmed) && !seen.has(m.id)) {
        seen.add(m.id);
        merged.push({
          id: m.id,
          channelId: m.channelId,
          authorName: m.authorName,
          content: m.content,
        });
      }
    });

    return merged.slice(0, 10);
  }, [query, messages, serverResults]);

  return (
    <AnimatePresence>
      {open && (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Omni search" className="fixed inset-0 z-[9995] flex items-start justify-center pt-3 sm:pt-20 p-3 sm:p-4 font-sans select-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-[#040405]/70 backdrop-blur-md supports-[backdrop-filter]:bg-black/60"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -10 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="relative w-full max-w-[640px] bg-[#141416] border border-zinc-800 rounded-xl overflow-hidden shadow-[0_24px_64px_rgba(10,14,32,0.6)] flex flex-col max-h-[min(78vh,640px)]"
          >
            {/* Search Input Bar — 48px min, thumb comfortable */}
            <div className="flex items-center px-3 sm:px-4 py-3 border-b border-zinc-800 bg-zinc-950/60 shrink-0 gap-2">
              <span className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                <Search size={16} className={`transition-colors ${isSearchingServer ? 'text-indigo-400 animate-pulse' : 'text-zinc-400'}`} />
              </span>
              <input
                ref={searchInputRef}
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search channels, agents, history…"
                className="w-full bg-transparent border-none text-[15px] sm:text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-0 py-1"
              />
              <button
                onClick={onClose}
                aria-label="Close search"
                className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 flex items-center justify-center transition focus:outline-none cursor-pointer shrink-0 active:scale-95"
              >
                <X size={15} />
              </button>
            </div>

            {/* Results List — generous touch targets, calm hierarchy */}
            <div className="flex-1 overflow-y-auto p-3 sm:p-3.5 space-y-5 scrollbar-thin overscroll-contain">
              {/* Channels Section */}
              {filteredChannels.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[13px] font-medium text-zinc-400 px-2 py-1 flex items-center gap-2">
                    <Hash size={12} /> Channels <span className="tnum ml-auto text-[11px] font-mono text-zinc-500">{filteredChannels.length}</span>
                  </div>
                  {filteredChannels.map(ch => (
                    <button
                      key={ch.id}
                      onClick={() => {
                        setActiveChannel(ch.id);
                        onClose();
                      }}
                      className="w-full flex items-center justify-between px-3 py-3 min-h-[48px] hover:bg-zinc-900 active:bg-zinc-800 rounded-xl text-[13px] font-sans text-left transition select-none cursor-pointer group border border-transparent hover:border-zinc-800 active:scale-[0.99]"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 group-hover:border-zinc-700">
                          <Hash size={14} className="text-zinc-400 group-hover:text-indigo-400 transition" />
                        </span>
                        <span className="font-semibold text-zinc-100 truncate">{ch.name}</span>
                        {ch.description && (
                          <span className="text-zinc-500 text-[11px] truncate max-w-[160px] hidden sm:inline">{ch.description}</span>
                        )}
                      </div>
                      <ArrowRight size={14} className="text-zinc-600 group-hover:text-zinc-300 transition shrink-0" />
                    </button>
                  ))}
                </div>
              )}

              {/* Agents Section */}
              {filteredAgents.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[13px] font-medium text-zinc-400 px-2 py-1">
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
                        <span className="text-[11px] text-indigo-400 group-hover:text-indigo-300">View profile →</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Tools Section */}
              {filteredTools.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[13px] font-medium text-zinc-400 px-2 py-1">
                    Enabled Tools ({filteredTools.length})
                  </div>
                  {filteredTools.map(t => (
                    <div
                      key={t.id}
                      className="w-full flex items-center justify-between px-2.5 py-2 hover:bg-zinc-900/50 rounded-lg text-xs font-sans text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Hammer size={14} className="text-zinc-500 shrink-0" />
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
                  <div className="text-[13px] font-medium text-zinc-400 px-2 py-1">
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
