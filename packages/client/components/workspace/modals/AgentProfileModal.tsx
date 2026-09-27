import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, MessageSquare, ShieldAlert, Cpu, Hammer, FileText, 
  ArrowUp, ArrowDown, ChevronDown, ChevronRight, Plus, Trash2, Layers 
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import PresenceIndicator from '../ui/PresenceIndicator';
import StatusBadge from '../ui/StatusBadge';
import { useToast } from '@/components/ui/ToastProvider';
import AgentStudioModal from '@/components/studio/AgentStudioModal';

export default function AgentProfileModal() {
  const { 
    selectedAgentId, 
    agentProfileModalOpen, 
    closeAgentProfileModal, 
    agents,
    addMessage,
    activeChannelId,
    instructionModules,
    modelModules,
    toolkitModules,
    constraintsModules,
    capabilitiesModules,
    runtimeOverrides,
    addRuntimeOverride,
    deleteRuntimeOverride,
    toggleRuntimeOverride,
    tools
  } = useCrowdOSStore();

  const { showSuccess } = useToast();
  const [dmText, setDmText] = useState('');
  const [studioOpen, setStudioOpen] = useState(false);
  
  // Patch states
  const [patchPanelOpen, setPatchPanelOpen] = useState(false);
  const [patchType, setPatchType] = useState<'instruction' | 'model' | 'toolkit'>('instruction');
  const [patchInstructionPrompt, setPatchInstructionPrompt] = useState('');
  const [patchModelTemp, setPatchModelTemp] = useState(0.7);
  const [patchModelMaxTokens, setPatchModelMaxTokens] = useState(2048);
  const [patchToolkitTools, setPatchToolkitTools] = useState<string[]>([]);
  const [patchReason, setPatchReason] = useState('');

  const agent = agents.find(ag => ag.id === selectedAgentId);

  // Level roles styling
  const levelStyles: Record<number, { text: string; bg: string; border: string; banner: string; title: string }> = {
    0: { text: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', banner: 'from-cyan-950 to-zinc-950', title: 'L0 Surveillance Monitor' },
    1: { text: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/30', banner: 'from-rose-950 to-zinc-950', title: 'L1 Executive Admin' },
    2: { text: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/30', banner: 'from-indigo-950 to-zinc-950', title: 'L2 Operation Coordinator' },
    3: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', banner: 'from-emerald-950 to-zinc-950', title: 'L3 Autonomic Worker' }
  };

  const style = levelStyles[agent?.level ?? 3] || levelStyles[3];

  // Resolve matching modules
  const instModule = instructionModules.find(m => m.id === agent?.instructionModuleId);
  const modelModule = modelModules.find(m => m.id === agent?.modelModuleId);
  const toolModule = toolkitModules.find(m => m.id === agent?.toolkitModuleId);
  const constraintsModule = constraintsModules.find(m => m.id === agent?.constraintsModuleId);
  const capabilitiesModule = capabilitiesModules.find(m => m.id === agent?.capabilitiesModuleId);

  // Resolve hierarchy relationships
  const parentAgent = agents.find(p => p.id === agent?.parentId);
  const subDrones = agents.filter(d => d.parentId === agent?.id);

  // Active overrides for this agent
  const activeOverrides = runtimeOverrides.filter(o => o.agentId === agent?.id);

  const handleSendDM = () => {
    if (!dmText.trim() || !activeChannelId || !agent) return;

    addMessage({
      type: 'human',
      content: `@${agent.name} ${dmText}`,
      authorId: 'user-01',
      authorName: 'Juan Hamzah',
      channelId: activeChannelId
    });

    showSuccess('Message Sent', `Dispatched directive to @${agent.name}.`);
    setDmText('');
    closeAgentProfileModal();
  };

  const handleApplyPatch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agent) return;
    
    let patchObj: Record<string, any> = {};
    if (patchType === 'instruction') {
      patchObj = { systemPrompt: patchInstructionPrompt };
    } else if (patchType === 'model') {
      patchObj = { temperature: patchModelTemp, maxTokens: patchModelMaxTokens };
    } else if (patchType === 'toolkit') {
      patchObj = { enabledToolIds: patchToolkitTools };
    }

    addRuntimeOverride({
      agentId: agent.id,
      type: patchType,
      patch: patchObj,
      reason: patchReason || 'Manual developer runtime patch',
      active: true
    });

    showSuccess('Behavior Hot-Patched', `Applied temporary override to @${agent.name}.`);
    setPatchReason('');
    setPatchPanelOpen(false);
  };

  useEffect(() => {
    if (!agentProfileModalOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAgentProfileModal();
    };
    window.addEventListener('keydown', onEsc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onEsc);
      document.body.style.overflow = prev;
    };
  }, [agentProfileModalOpen, closeAgentProfileModal]);

  if (!agentProfileModalOpen || !agent) return null;

  return (
    <>
      <AnimatePresence>
        <div role="dialog" aria-modal="true" aria-label={`Agent profile for ${agent.name}`} className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Blur Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeAgentProfileModal}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm" 
          />

          {/* Modal Container */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
            className="relative w-full max-w-md bg-[#0c0c0e] border border-zinc-800 rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
          >
            {/* Top Banner Gradient */}
            <div className={`h-24 bg-gradient-to-r ${style.banner} relative p-4 flex justify-end shrink-0`}>
              <button
                onClick={closeAgentProfileModal}
                aria-label="Close agent profile"
                className="w-7 h-7 bg-zinc-950/40 hover:bg-zinc-950/80 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 cursor-pointer"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            {/* Floating Avatar cut */}
            <div className="px-6 relative -mt-10 mb-2 shrink-0 select-none">
              <div className={`relative w-20 h-20 rounded-full bg-zinc-950 border-4 border-zinc-950 flex items-center justify-center text-3xl shadow-lg`}>
                {agent.avatar || '🤖'}
                <div className="absolute bottom-0 right-0 p-0.5 bg-zinc-950 rounded-full">
                  <PresenceIndicator status={agent.status} size="md" />
                </div>
              </div>
            </div>

            {/* Content body Scroll Panel */}
            <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2 space-y-4">
              {/* Identity details */}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-zinc-100 font-sans tracking-tight">
                    {agent.name}
                  </h2>
                  <span className={`tnum text-[10px] font-mono px-1.5 py-0.2 rounded border font-medium inline-block ${style.bg} ${style.text} ${style.border}`}>
                    Level {agent.level}
                  </span>
                </div>
                <div className="text-xs font-mono text-zinc-500">
                  {style.title} • {agent.species}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <StatusBadge status={agent.status} />
                <span className="text-[10px] font-mono text-zinc-550 select-none">
                  Last active: {new Date(agent.lastActive).toLocaleTimeString()}
                </span>
              </div>

              {agent.description && (
                <p className="text-xs text-zinc-400 font-sans leading-relaxed bg-zinc-900/30 p-2.5 rounded border border-zinc-900/60 pl-3">
                  {agent.description}
                </p>
              )}

              <div className="border-t border-zinc-900 my-2 shrink-0 pointer-events-none" />

              {/* Module-based Cognitive Assembly summary cards */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-medium text-zinc-400">
                    Modular assembly
                  </h3>
                  <button
                    onClick={() => setStudioOpen(true)}
                    className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-[9.5px] font-semibold flex items-center gap-1 transition cursor-pointer"
                  >
                    <Layers size={10} />
                    <span>Open studio</span>
                  </button>
                </div>

                {/* Instruction Module */}
                <div className="bg-zinc-950 border border-zinc-900 p-2.5 rounded-lg flex items-start gap-2.5">
                  <FileText size={14} className="text-indigo-400 shrink-0 mt-0.5" />
                  <div className="text-xs w-full">
                    <div className="font-semibold text-zinc-200 font-mono tracking-tight leading-none">
                      {instModule ? instModule.name : 'Standard Directives'}
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-1 line-clamp-2">
                      {instModule ? instModule.systemPrompt : 'System guidance not bound.'}
                    </div>
                  </div>
                </div>

                {/* Model Module */}
                <div className="bg-zinc-950 border border-zinc-900 p-2.5 rounded-lg flex items-start gap-2.5">
                  <Cpu size={14} className="text-cyan-400 shrink-0 mt-0.5" />
                  <div className="text-xs w-full">
                    <div className="font-semibold text-zinc-200 font-mono tracking-tight leading-none">
                      {modelModule?.name || 'Dual Reasoner Profile'}
                    </div>
                    <div className="tnum text-[10px] text-cyan-500 font-mono mt-1">
                      {modelModule?.modelProfileId || 'Gemini-2.0-Flash'} • Temp {modelModule?.temperature || 0.7}
                    </div>
                  </div>
                </div>

                {/* Toolkit Module */}
                <div className="bg-zinc-950 border border-zinc-900 p-2.5 rounded-lg flex items-start gap-2.5">
                  <Hammer size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                  <div className="text-xs w-full">
                    <div className="font-semibold text-zinc-200 font-mono tracking-tight leading-none">
                      {toolModule?.name || 'Standard Toolkit'}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {(toolModule?.enabledToolIds || ['web.search', 'sandbox.exec']).map(tid => (
                        <span key={tid} className="text-[9px] font-mono px-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                          {tid}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Constraints Module */}
                {constraintsModule && (
                  <div className="bg-zinc-950 border border-zinc-900 p-2.5 rounded-lg flex items-start gap-2.5 animate-fade-in">
                    <ShieldAlert size={14} className="text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-xs w-full">
                      <div className="font-semibold text-zinc-200 font-mono tracking-tight leading-none">
                        {constraintsModule.name}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-1 line-clamp-2">
                        {constraintsModule.disallowedActions?.join(', ') || 'Strict invariant rules enforced.'}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* ACTIVE OVERRIDES AUDIT ROSTER */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-medium text-zinc-400">
                    Active overrides <span className="tnum text-[11px] text-zinc-500">({activeOverrides.length})</span>
                  </h3>
                  {activeOverrides.length > 0 && (
                    <span className="text-[9px] font-mono text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1 rounded">
                      Modifications active
                    </span>
                  )}
                </div>

                {activeOverrides.length === 0 ? (
                  <div className="p-2.5 bg-zinc-950/40 border border-zinc-900 rounded-lg text-center text-zinc-600 text-[10.5px] font-mono select-none">
                    No active overrides.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {activeOverrides.map(o => (
                      <div 
                        key={o.id}
                        className={`p-2 rounded-lg border text-[11px] font-mono flex items-start justify-between gap-2 ${
                          o.active 
                            ? 'bg-indigo-950/20 border-indigo-500/30 text-zinc-200' 
                            : 'bg-zinc-950 border-zinc-900 text-zinc-500 opacity-60'
                        }`}
                      >
                        <div className="space-y-0.5 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-[9px] px-1 rounded bg-zinc-900 border border-zinc-800 text-indigo-400">
                              {o.type}
                            </span>
                            <span className="text-[10px] text-zinc-400 truncate">{o.reason}</span>
                          </div>
                          <div className="text-[9.5px] text-zinc-500 font-mono line-clamp-1">
                            {JSON.stringify(o.patch)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <input 
                            type="checkbox"
                            checked={o.active}
                            onChange={() => toggleRuntimeOverride(o.id, !o.active)}
                            className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 text-indigo-500 cursor-pointer focus:ring-0"
                            title="Toggle Patch State"
                          />
                          <button 
                            onClick={() => deleteRuntimeOverride(o.id)}
                            className="text-zinc-550 hover:text-rose-400 p-0.5 hover:bg-rose-950/20 rounded cursor-pointer transition"
                            title="Revert Patch"
                          >
                            <Trash2 size={11.5} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* DYNAMIC PATCH RUNTIME COLLAPSIBLE PANEL */}
              <div className="border border-zinc-900 rounded-lg overflow-hidden bg-zinc-950/30">
                <button
                  onClick={() => {
                    setPatchPanelOpen(!patchPanelOpen);
                    if (instModule) setPatchInstructionPrompt(instModule.systemPrompt);
                    if (toolModule) setPatchToolkitTools(toolModule.enabledToolIds);
                  }}
                  className="w-full flex items-center justify-between p-2.5 text-zinc-300 font-semibold hover:bg-zinc-900/30 transition cursor-pointer select-none text-[11px] font-mono tracking-tight"
                >
                  <div className="flex items-center gap-1.5">
                    <ShieldAlert size={12} className="text-indigo-400" />
                    <span>Patch runtime</span>
                  </div>
                  {patchPanelOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>

                <AnimatePresence>
                {patchPanelOpen && (
                  <motion.form 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    onSubmit={handleApplyPatch} 
                    className="p-3 border-t border-zinc-900 bg-zinc-950/80 space-y-3 text-[10.5px] overflow-hidden"
                  >
                    <div className="space-y-1">
                      <label className="text-zinc-500 font-medium text-[11px] block">Target</label>
                      <select
                        value={patchType}
                        onChange={(e) => setPatchType(e.target.value as any)}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 focus:outline-none text-[11px] text-zinc-350 cursor-pointer"
                      >
                        <option value="instruction">Prompt (Instruction Module)</option>
                        <option value="model">Parameters (Model Module)</option>
                        <option value="toolkit">Capabilities (Toolkit Module)</option>
                      </select>
                    </div>

                    {patchType === 'instruction' && (
                      <div className="space-y-1">
                        <label className="text-zinc-500 font-medium text-[11px] block">Temporary system prompt</label>
                        <textarea
                          value={patchInstructionPrompt}
                          onChange={(e) => setPatchInstructionPrompt(e.target.value)}
                          placeholder="Write instructions to append or override for this run..."
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 focus:outline-none resize-none h-20 text-[10.5px] text-zinc-200 font-sans leading-relaxed"
                        />
                      </div>
                    )}

                    {patchType === 'model' && (
                      <div className="grid grid-cols-2 gap-3.5 leading-snug">
                        <div className="space-y-1">
                          <label className="text-zinc-500 font-bold font-mono text-[9px] block">TEMPERATURE (0 - 2.0)</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="2"
                            value={patchModelTemp}
                            onChange={(e) => setPatchModelTemp(parseFloat(e.target.value))}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 focus:outline-none text-[11px] text-zinc-200 font-mono"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-zinc-500 font-medium text-[11px] block">Max output tokens</label>
                          <input
                            type="number"
                            min="1"
                            value={patchModelMaxTokens}
                            onChange={(e) => setPatchModelMaxTokens(parseInt(e.target.value))}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 focus:outline-none text-[11px] text-zinc-200 font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {patchType === 'toolkit' && (
                      <div className="space-y-1.5">
                        <label className="text-zinc-500 font-medium text-[11px] block">Temporary tools</label>
                        <div className="grid grid-cols-1 gap-1.5 pl-1 max-h-32 overflow-y-auto select-none">
                          {tools.map(tool => (
                            <div key={tool.id} className="flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                id={`patch-tool-${tool.id}`}
                                checked={patchToolkitTools.includes(tool.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setPatchToolkitTools([...patchToolkitTools, tool.id]);
                                  } else {
                                    setPatchToolkitTools(patchToolkitTools.filter(id => id !== tool.id));
                                  }
                                }}
                                className="h-3 w-3 rounded bg-zinc-900 border-zinc-800 text-indigo-500 focus:ring-0 cursor-pointer"
                              />
                              <label htmlFor={`patch-tool-${tool.id}`} className="text-zinc-300 font-mono text-[9.5px] cursor-pointer">
                                {tool.id} <span className="text-zinc-550">({tool.name})</span>
                              </label>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-1">
                      <label className="text-zinc-500 font-medium text-[11px] block">Reason (audited)</label>
                      <input
                        type="text"
                        required
                        value={patchReason}
                        onChange={(e) => setPatchReason(e.target.value)}
                        placeholder="e.g. optimizing token budgets on worker node"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 focus:outline-none text-[11px] text-zinc-200 placeholder-zinc-650"
                      />
                    </div>

                    <div className="flex justify-end select-none pt-1">
                      <button
                        type="submit"
                        className="px-3 py-1 bg-indigo-600 text-white rounded font-semibold text-[11px] hover:bg-indigo-505 transition cursor-pointer"
                      >
                        Apply Behavior Patch
                      </button>
                    </div>
                  </motion.form>
                )}
                </AnimatePresence>
              </div>

              {/* Hierarchy Branch mapping */}
              {(parentAgent || subDrones.length > 0) && (
                <div className="space-y-2 pt-1.5 text-xs border-t border-zinc-905/40">
                  <h3 className="text-[13px] font-medium text-zinc-400">
                    Hierarchy
                  </h3>

                  {parentAgent && (
                    <div className="flex items-center gap-2 bg-zinc-900/10 p-2 rounded text-zinc-350">
                      <ArrowUp size={11.5} className="text-zinc-650" />
                      <span className="text-[10px] text-zinc-500">Supervisor:</span>
                      <span className="font-semibold text-zinc-200 font-sans">{parentAgent.name}</span>
                    </div>
                  )}

                  {subDrones.length > 0 && (
                    <div className="flex items-start gap-2 bg-zinc-900/10 p-2 rounded text-zinc-350">
                      <ArrowDown size={11.5} className="text-zinc-650 mt-0.5" />
                      <div className="space-y-1">
                        <span className="text-[10px] text-zinc-500 block">Subordinates:</span>
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {subDrones.map(sb => (
                            <span key={sb.id} className="text-[10px] bg-zinc-950 border border-zinc-900 px-2 py-0.5 rounded text-zinc-200 font-sans">
                              {sb.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* DM Composer footer area */}
            <div className="p-4 bg-zinc-950 border-t border-zinc-900 shrink-0 select-none">
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-lg p-1.5 flex gap-1.5 items-center">
                <MessageSquare size={14} className="text-zinc-500 shrink-0 ml-1.5" />
                <input 
                  type="text" 
                  value={dmText}
                  onChange={(e) => setDmText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSendDM();
                  }}
                  placeholder={`Send instruction command @${agent.name}`}
                  className="w-full bg-transparent border-none text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-0 py-1"
                />
                <button 
                  onClick={handleSendDM}
                  disabled={!dmText.trim()}
                  className="h-6 w-6 rounded bg-indigo-500 text-white flex items-center justify-center transition disabled:bg-zinc-800 disabled:text-zinc-600 focus:outline-none cursor-pointer"
                >
                  <X size={12} className="rotate-45" />
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      </AnimatePresence>

      {/* Embedded Agent Studio Modal */}
      <AgentStudioModal
        agentId={selectedAgentId}
        open={studioOpen}
        onClose={() => setStudioOpen(false)}
      />
    </>
  );
}
