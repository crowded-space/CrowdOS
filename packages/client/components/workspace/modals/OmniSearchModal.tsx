import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Hash, Users, Hammer, MessageSquare, X, ArrowRight } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useOverlayFocus } from '@/components/ui/use-overlay-focus';
import { buildVerbs, filterVerbs, recordVerbUse, type paletteVerb } from './palette-verbs';

interface OmniSearchModalProps {
  open: boolean;
  onClose: () => void;
}

function verbRiskClass(risk: string): string {
  if (risk === 'destructive') return 'bg-rose-500/15 text-rose-300 border-rose-500/20';
  if (risk === 'confirm') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return 'bg-zinc-800 text-zinc-300 border-zinc-700';
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
  const [tab, setTab] = useState<'search' | 'commands'>('search');
  const [activeVerbIndex, setActiveVerbIndex] = useState(0);
  // Destructive verbs arm on first press and run on the second; confirm
  // verbs run immediately. The risk badge alone enforced nothing — a single
  // Enter on "Clear channel history" wiped the channel with no second step.
  const [armedVerbId, setArmedVerbId] = useState<string | null>(null);

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

  // Dual-mode: reset to Search tab + first verb on every open so the
  // palette opens in a known state (Ctrl/Cmd+K reaches both tabs).
  useEffect(() => {
    if (open) {
      setTab('search');
      setActiveVerbIndex(0);
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

  // Commands tab: 16 palette verbs, fuzzy subsequence scored by
  // filterVerbs (subsequence scorer, no dependency) with recent-first
  // ordering from the crowdos_palette_recent mirror (cap 10). The Search
  // tab keeps its own 200ms server debounce; verbs are local-only.
  const allVerbs = useMemo(() => buildVerbs(), []);
  const filteredVerbs = useMemo(() => filterVerbs(query, allVerbs), [query, allVerbs]);
  const activeVerb = filteredVerbs.length > 0
    ? filteredVerbs[Math.min(activeVerbIndex, filteredVerbs.length - 1)]
    : null;

  // Reset the active verb when the filtered set changes (tab or query) so
  // aria-activedescendant never points at a stale row.
  useEffect(() => {
    setActiveVerbIndex(0);
  }, [query, tab]);

  // A new query, tab, or close disarms a half-armed destructive verb — an
  // armed row must never survive the list it was armed in.
  useEffect(() => {
    setArmedVerbId(null);
  }, [query, tab, open]);

  function runVerb(verb: paletteVerb | null) {
    if (!verb) return;
    // Destructive verbs need a second press on the same row: first press
    // arms ("Press again to confirm"), second press runs. Any other verb
    // (or a different row) disarms first.
    if (verb.risk === 'destructive' && armedVerbId !== verb.id) {
      setArmedVerbId(verb.id);
      return;
    }
    setArmedVerbId(null);
    recordVerbUse(verb.id);
    onClose();
    void Promise.resolve().then(() => verb.run());
  }

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
                onChange={(e) => { setQuery(e.target.value); }}
                onKeyDown={(e) => {
                  if (tab !== 'commands') return;
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActiveVerbIndex((i) => Math.min(i + 1, filteredVerbs.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveVerbIndex((i) => Math.max(i - 1, 0)); }
                  else if (e.key === 'Home') { e.preventDefault(); setActiveVerbIndex(0); }
                  else if (e.key === 'End') { e.preventDefault(); setActiveVerbIndex(filteredVerbs.length - 1); }
                  else if (e.key === 'Enter') { e.preventDefault(); runVerb(activeVerb); }
                }}
                role={tab === 'commands' ? 'combobox' : undefined}
                aria-expanded={tab === 'commands' ? true : undefined}
                aria-activedescendant={tab === 'commands' && activeVerb ? `palette-verb-${activeVerb.id}` : undefined}
                aria-controls={tab === 'commands' ? 'palette-verb-list' : undefined}
                placeholder={tab === 'commands' ? 'Type a command…' : 'Search channels, agents, history…'}
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
              {/* Dual mode: Search + Commands tabs (role=tablist). Search is
                  the existing entity/message results untouched below; Commands
                  lists the 16 palette verbs. Ctrl/Cmd+K reaches both tabs. */}
              <div role="tablist" aria-label="Palette mode" className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-xl p-1">
                <button
                  type="button"
                  role="tab"
                  id="palette-tab-search"
                  aria-selected={tab === 'search'}
                  aria-controls="palette-panel-search"
                  onClick={() => setTab('search')}
                  className={`flex-1 px-3 py-2 min-h-[36px] rounded-lg text-xs font-sans font-semibold transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 ${tab === 'search' ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  Search
                </button>
                <button
                  type="button"
                  role="tab"
                  id="palette-tab-commands"
                  aria-selected={tab === 'commands'}
                  aria-controls="palette-panel-commands"
                  onClick={() => setTab('commands')}
                  className={`flex-1 px-3 py-2 min-h-[36px] rounded-lg text-xs font-sans font-semibold transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 ${tab === 'commands' ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  Commands
                </button>
              </div>
              {/* Channels Section */}
              {tab === 'search' && (
              <div id="palette-panel-search" role="tabpanel" aria-labelledby="palette-tab-search" className="space-y-5">
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

              {query.trim() && filteredChannels.length === 0 && filteredAgents.length === 0 && filteredTools.length === 0 && filteredMessages.length === 0 && (
                <div className="text-center py-8 text-zinc-500 text-xs font-sans">
                  No matching entities or logs found for &quot;{query}&quot;.
                </div>
              )}
              </div>
              )}
              {tab === 'commands' && (
                <div id="palette-panel-commands" role="tabpanel" aria-labelledby="palette-tab-commands" className="space-y-1">
                  <div className="text-[13px] font-medium text-zinc-400 px-2 py-1">
                    Commands ({filteredVerbs.length})
                  </div>
                  {filteredVerbs.length === 0 && (
                    <div className="text-center py-8 text-zinc-500 text-xs font-sans">
                      No matching commands for &quot;{query}&quot;.
                    </div>
                  )}
                  {filteredVerbs.length > 0 && (
                    <div
                      id="palette-verb-list"
                      role="listbox"
                      aria-label="Palette commands"
                      className="space-y-1"
                    >
                      {filteredVerbs.map((verb, idx) => {
                        const optionId = `palette-verb-${verb.id}`;
                        const selected = activeVerb ? verb.id === activeVerb.id : idx === 0;
                        const armed = armedVerbId === verb.id;
                        return (
                          <button
                            key={verb.id}
                            type="button"
                            id={optionId}
                            role="option"
                            aria-selected={selected}
                            onMouseEnter={() => setActiveVerbIndex(idx)}
                            onClick={() => runVerb(verb)}
                            className={`w-full flex items-center justify-between gap-2 px-2.5 py-2.5 min-h-[44px] rounded-xl text-xs font-sans text-left transition select-none cursor-pointer focus:outline-none active:scale-[0.99] ${selected ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-300 hover:bg-zinc-800 active:bg-zinc-800'}`}
                          >
                            <span className="min-w-0">
                              <span className={`block truncate font-semibold ${selected ? 'text-white' : 'text-zinc-200'}`}>{verb.title}</span>
                              <span className={`mt-0.5 flex items-center gap-1.5 text-[10px] font-mono ${selected ? 'text-white/80' : 'text-zinc-500'}`}>
                                <span>{verb.scope}</span>
                                <span aria-hidden="true">·</span>
                                <span className={`px-1.5 py-0.5 rounded border ${verbRiskClass(verb.risk)}`}>{verb.risk}</span>
                                {armed && (
                                  <span className="px-1.5 py-0.5 rounded border border-rose-400/50 bg-rose-500/20 text-rose-200 font-semibold">press again to confirm</span>
                                )}
                                {verb.shortcut && (
                                  <span className="ml-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5">{verb.shortcut}</span>
                                )}
                              </span>
                            </span>
                            <span className={`shrink-0 text-[11px] ${selected ? 'text-white/90' : 'text-indigo-400'}`}>{armed ? 'Confirm →' : 'Run →'}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
