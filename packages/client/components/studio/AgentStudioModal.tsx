import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, Cpu, Layers, Brain, Hammer, ShieldAlert, 
  Sparkles, RefreshCw, CheckCircle2, AlertCircle, Plus, 
  Trash2, Eye, Play, Sliders, FileCode, Check
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useToast } from '@/components/ui/ToastProvider';

interface AgentStudioModalProps {
  agentId: string | null;
  open: boolean;
  onClose: () => void;
}

export default function AgentStudioModal({ agentId, open, onClose }: AgentStudioModalProps) {
  const { 
    agents, 
    modelModules, 
    instructionModules, 
    toolkitModules, 
    constraintsModules 
  } = useCrowdOSStore();

  const { showSuccess, showError, showInfo } = useToast();

  const [activeTab, setActiveTab] = useState<'rack' | 'xray' | 'patch'>('rack');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Manifest State
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [selectedInstructionIds, setSelectedInstructionIds] = useState<string[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<any[]>([]);
  const [resolvedTools, setResolvedTools] = useState<any[]>([]);
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [selectedToolkitId, setSelectedToolkitId] = useState<string>('');
  const [selectedConstraintsId, setSelectedConstraintsId] = useState<string>('');

  // X-Ray Prompt Inspector State
  const [inspecting, setInspecting] = useState(false);
  const [testUserInput, setTestUserInput] = useState('Please review the current system state and suggest the next step.');
  const [inspectionResult, setInspectionResult] = useState<any>(null);

  const agent = agents.find(a => a.id === agentId);

  // Fetch complete manifest & available skills on modal open
  useEffect(() => {
    if (!open || !agentId) return;

    const loadData = async () => {
      setLoading(true);
      try {
        // 1. Fetch Agent Manifest
        const manifestRes = await fetch(`/api/studio/agents/${agentId}/manifest`);
        if (manifestRes.ok) {
          const data = await manifestRes.json();
          if (data.slots?.model) setSelectedModelId(data.slots.model.id);
          if (data.slots?.instructionStack) {
            setSelectedInstructionIds(data.slots.instructionStack.map((s: any) => s.moduleId));
          }
          if (data.slots?.skills) {
            setSelectedSkillIds(data.slots.skills.map((s: any) => s.id));
          }
          if (data.slots?.tools) setResolvedTools(data.slots.tools);
          if (data.slots?.toolkit) setSelectedToolkitId(data.slots.toolkit.id);
          if (data.slots?.constraints) setSelectedConstraintsId(data.slots.constraints.id);
        }

        // 2. Fetch All Skills Catalog
        const skillsRes = await fetch('/api/skills');
        if (skillsRes.ok) {
          const skillsData = await skillsRes.json();
          setAvailableSkills(skillsData);
        }

        // 3. Fetch MCP Servers
        const mcpRes = await fetch('/api/mcp/servers');
        if (mcpRes.ok) {
          const mcpData = await mcpRes.json();
          setMcpServers(mcpData);
        }
      } catch (err) {
        console.warn('[AgentStudio] Failed to fetch manifest:', err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [open, agentId]);

  // Run X-Ray Inspection
  const handleInspectPrompt = async () => {
    if (!agentId) return;
    setInspecting(true);
    try {
      const res = await fetch('/api/studio/inspect-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          userInput: testUserInput,
          runtimeType: 'agentic',
        }),
      });

      if (res.ok) {
        const result = await res.json();
        setInspectionResult(result);
        showSuccess('Context Assembled', `Compiled ${result.tokenEstimate || 0} estimated tokens.`);
      } else {
        const err = await res.json();
        showError('Inspection Failed', err.message || 'Error running prompt inspection.');
      }
    } catch (err: any) {
      showError('Inspection Failed', err.message);
    } finally {
      setInspecting(false);
    }
  };

  // Save Slot Manifest
  const handleSaveManifest = async () => {
    if (!agentId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/studio/agents/${agentId}/manifest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelModuleId: selectedModelId || undefined,
          instructionModuleIds: selectedInstructionIds,
          skillIds: selectedSkillIds,
          toolkitModuleId: selectedToolkitId || undefined,
          constraintsModuleId: selectedConstraintsId || undefined,
        }),
      });

      if (res.ok) {
        showSuccess('Manifest Committed', `Updated modular slot configuration for @${agent?.name}.`);
        onClose();
      } else {
        const err = await res.json();
        showError('Save Failed', err.message || 'Failed to save manifest.');
      }
    } catch (err: any) {
      showError('Save Failed', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open || !agent) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
        <motion.div 
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.15 }}
          className="bg-[#0e0e11] border border-zinc-800 w-full max-w-4xl max-h-[90vh] rounded-xl flex flex-col shadow-2xl overflow-hidden font-sans text-xs text-zinc-200"
        >
          {/* Header */}
          <div className="p-4 border-b border-zinc-800/80 bg-zinc-950 flex items-center justify-between select-none">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-sm">
                {agent.avatar || '🤖'}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-zinc-100 font-sans">
                    Agent Studio: @{agent.name}
                  </h2>
                  <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[9.5px] font-mono text-zinc-400">
                    Tier L{agent.level ?? 3}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9.5px] font-mono text-emerald-400">
                    {agent.species || 'Cognitive Node'}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mt-0.5 font-sans">
                  Modular slot-based cognitive rack. Hot-swap instructions, skills, models, and tools with zero downtime.
                </p>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex items-center gap-1.5 bg-zinc-900/80 p-1 rounded-lg border border-zinc-800">
              <button
                onClick={() => setActiveTab('rack')}
                className={`px-2.5 py-1 rounded-md text-[10.5px] font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'rack' ? 'bg-indigo-600 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Layers size={12} />
                <span>Modular Rack</span>
              </button>
              <button
                onClick={() => {
                  setActiveTab('xray');
                  if (!inspectionResult) handleInspectPrompt();
                }}
                className={`px-2.5 py-1 rounded-md text-[10.5px] font-medium transition cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'xray' ? 'bg-indigo-600 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Eye size={12} />
                <span>Context X-Ray</span>
              </button>
              <button
                onClick={onClose}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition cursor-pointer ml-1"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {activeTab === 'rack' && (
              <div className="space-y-4">
                {/* 1. MODEL SLOT */}
                <div className="p-3.5 bg-zinc-950/60 border border-zinc-850 rounded-xl space-y-2.5">
                  <div className="flex items-center justify-between pb-1.5 border-b border-zinc-900">
                    <div className="flex items-center gap-2">
                      <Cpu size={14} className="text-emerald-400" />
                      <span className="font-bold text-zinc-200 font-mono text-[10px] uppercase tracking-wider">
                        Slot 1: Cognitive Model Engine
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-500 font-mono">
                      Active: {modelModules.find(m => m.id === selectedModelId)?.name || 'Default Gemini Flash'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-400 font-mono uppercase font-bold block">Assigned Model Module</label>
                      <select
                        value={selectedModelId}
                        onChange={(e) => setSelectedModelId(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200 text-xs font-mono outline-none focus:border-zinc-700 cursor-pointer"
                      >
                        <option value="">Default (Google Gemini 2.0 Flash)</option>
                        {modelModules.map(m => (
                          <option key={m.id} value={m.id}>{m.name} ({m.provider})</option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-end">
                      <div className="text-[10.5px] text-zinc-500 leading-relaxed font-sans">
                        Configured parameters, temperature, and API credentials are bound to this model profile.
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. INSTRUCTION STACK SLOT */}
                <div className="p-3.5 bg-zinc-950/60 border border-zinc-850 rounded-xl space-y-2.5">
                  <div className="flex items-center justify-between pb-1.5 border-b border-zinc-900">
                    <div className="flex items-center gap-2">
                      <Layers size={14} className="text-indigo-400" />
                      <span className="font-bold text-zinc-200 font-mono text-[10px] uppercase tracking-wider">
                        Slot 2: Instruction Stack ({selectedInstructionIds.length} Layers)
                      </span>
                    </div>
                  </div>

                  {/* Active Layers List */}
                  <div className="space-y-1.5">
                    {selectedInstructionIds.length === 0 ? (
                      <div className="p-3 bg-zinc-900/30 border border-dashed border-zinc-800 rounded-lg text-center text-zinc-550 text-[11px]">
                        No modular instruction layers assigned. Using agent default base prompt.
                      </div>
                    ) : (
                      selectedInstructionIds.map((instId, index) => {
                        const mod = instructionModules.find(m => m.id === instId);
                        return (
                          <div 
                            key={instId}
                            className="p-2.5 bg-zinc-900/50 border border-zinc-800/80 rounded-lg flex items-center justify-between gap-2"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="w-5 h-5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-mono text-[10px] flex items-center justify-center font-bold">
                                {index + 1}
                              </span>
                              <div className="min-w-0">
                                <span className="font-semibold text-zinc-200 text-xs truncate block font-sans">
                                  {mod?.name || instId}
                                </span>
                                <span className="text-[10px] text-zinc-500 font-mono truncate block">
                                  {mod?.description || 'Custom instruction layer'}
                                </span>
                              </div>
                            </div>

                            <button
                              onClick={() => {
                                setSelectedInstructionIds(selectedInstructionIds.filter(id => id !== instId));
                              }}
                              className="p-1 text-zinc-500 hover:text-rose-400 transition cursor-pointer"
                              title="Remove Layer"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Add Layer Selector */}
                  <div className="flex items-center gap-2 pt-1">
                    <select
                      id="add-instruction-select"
                      className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 text-xs font-mono outline-none focus:border-zinc-700 cursor-pointer"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value && !selectedInstructionIds.includes(e.target.value)) {
                          setSelectedInstructionIds([...selectedInstructionIds, e.target.value]);
                          e.target.value = '';
                        }
                      }}
                    >
                      <option value="" disabled>+ Snap new instruction brick into stack...</option>
                      {instructionModules
                        .filter(m => !selectedInstructionIds.includes(m.id))
                        .map(m => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                    </select>
                  </div>
                </div>

                {/* 3. SKILLS PACK SLOT */}
                <div className="p-3.5 bg-zinc-950/60 border border-zinc-850 rounded-xl space-y-2.5">
                  <div className="flex items-center justify-between pb-1.5 border-b border-zinc-900">
                    <div className="flex items-center gap-2">
                      <Brain size={14} className="text-amber-400" />
                      <span className="font-bold text-zinc-200 font-mono text-[10px] uppercase tracking-wider">
                        Slot 3: Specialized Skills ({selectedSkillIds.length} Active)
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {availableSkills.map(skill => {
                      const isAttached = selectedSkillIds.includes(skill.id);
                      return (
                        <div
                          key={skill.id}
                          onClick={() => {
                            if (isAttached) {
                              setSelectedSkillIds(selectedSkillIds.filter(id => id !== skill.id));
                            } else {
                              setSelectedSkillIds([...selectedSkillIds, skill.id]);
                            }
                          }}
                          className={`p-2.5 rounded-lg border transition cursor-pointer select-none flex items-start gap-2.5 ${
                            isAttached 
                              ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' 
                              : 'bg-zinc-900/30 border-zinc-800/80 text-zinc-400 hover:border-zinc-700'
                          }`}
                        >
                          <span className="text-base shrink-0 mt-0.5">{skill.icon || '⚡'}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-zinc-200 text-xs font-sans truncate">
                                {skill.name}
                              </span>
                              {isAttached && <Check size={12} className="text-amber-400 shrink-0" />}
                            </div>
                            <p className="text-[10px] text-zinc-500 leading-tight mt-0.5 truncate font-sans">
                              {skill.description}
                            </p>
                            {skill.requiredToolIds?.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {skill.requiredToolIds.map((t: string) => (
                                  <span key={t} className="px-1 py-0.2 rounded bg-zinc-950 border border-zinc-800 text-[8.5px] font-mono text-zinc-400">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 4. TOOLS & MCP SERVERS SLOT */}
                <div className="p-3.5 bg-zinc-950/60 border border-zinc-850 rounded-xl space-y-2.5">
                  <div className="flex items-center justify-between pb-1.5 border-b border-zinc-900">
                    <div className="flex items-center gap-2">
                      <Hammer size={14} className="text-rose-400" />
                      <span className="font-bold text-zinc-200 font-mono text-[10px] uppercase tracking-wider">
                        Slot 4: Authorized Tools & MCP Connectors ({resolvedTools.length})
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {resolvedTools.map(t => (
                      <div key={t.id || t.name} className="p-2 bg-zinc-900/40 border border-zinc-800 rounded-md flex items-center justify-between gap-1.5">
                        <div className="min-w-0">
                          <span className="font-mono text-zinc-200 text-[11px] truncate block">
                            {t.displayName || t.name}
                          </span>
                          <span className="text-[9px] text-zinc-500 font-mono block uppercase">
                            {t.category || t.sourceType || 'native'}
                          </span>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[8.5px] font-mono shrink-0 uppercase ${
                          t.sourceType === 'mcp' ? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30' : 'bg-zinc-800 text-zinc-400'
                        }`}>
                          {t.sourceType || 'native'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* X-RAY PROMPT INSPECTOR */}
            {activeTab === 'xray' && (
              <div className="space-y-3.5">
                <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-indigo-400 uppercase text-[10px]">
                      Simulated User Prompt Input
                    </span>
                    <button
                      onClick={handleInspectPrompt}
                      disabled={inspecting}
                      className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[10.5px] font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw size={11} className={inspecting ? 'animate-spin' : ''} />
                      <span>Re-Compile Context</span>
                    </button>
                  </div>
                  <input
                    type="text"
                    value={testUserInput}
                    onChange={(e) => setTestUserInput(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-zinc-200 font-sans text-xs outline-none focus:border-zinc-700"
                    placeholder="Enter test user message..."
                  />
                </div>

                {inspectionResult && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <div className="p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg">
                        <span className="text-[9px] text-zinc-500 font-mono uppercase block">Estimated Tokens</span>
                        <span className="text-base font-bold text-indigo-400 font-mono">{inspectionResult.tokenEstimate}</span>
                      </div>
                      <div className="p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg">
                        <span className="text-[9px] text-zinc-500 font-mono uppercase block">Active Provider</span>
                        <span className="text-xs font-semibold text-emerald-400 font-mono uppercase truncate block">
                          {inspectionResult.modelConfig?.provider || 'google'}
                        </span>
                      </div>
                      <div className="p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg">
                        <span className="text-[9px] text-zinc-500 font-mono uppercase block">Compiled Tools</span>
                        <span className="text-base font-bold text-zinc-200 font-mono">{inspectionResult.tools?.length || 0}</span>
                      </div>
                      <div className="p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg">
                        <span className="text-[9px] text-zinc-500 font-mono uppercase block">History Turns</span>
                        <span className="text-base font-bold text-zinc-200 font-mono">{inspectionResult.history?.length || 0}</span>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-400 font-mono uppercase font-bold block">
                        Compiled System Prompt Sent to LLM
                      </label>
                      <pre className="p-3 bg-zinc-950 border border-zinc-850 rounded-lg text-zinc-300 font-mono text-[10.5px] leading-relaxed max-h-72 overflow-y-auto whitespace-pre-wrap select-text">
                        {inspectionResult.systemPrompt}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-3.5 bg-zinc-950 border-t border-zinc-850 flex items-center justify-between shrink-0 select-none">
            <span className="text-[10.5px] text-zinc-500 font-mono">
              Changes take effect on the next turn via WebSocket hot-swap.
            </span>

            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900 text-zinc-400 font-semibold transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveManifest}
                disabled={saving}
                className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                <span>Save & Commit Manifest</span>
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
