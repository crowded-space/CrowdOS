import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search, ShieldCheck, ToggleLeft, ToggleRight, Wrench } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { fetchJsonOrThrow } from '@/src/api/client';
import { useToast } from '@/components/ui/ToastProvider';

/**
 * One registry entry as returned by GET /api/tools (parameters omitted).
 * The registry is the only real source of tool ids: the old local `tools`
 * slice was demo data (`web.search`, `github.read`) that granted nothing.
 */
interface RegistryTool {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  sourceType: string;
  dangerLevel: string;
  authLevelRequired: number;
  universal?: boolean;
}

const DANGER_CLASS: Record<string, string> = {
  safe: 'text-emerald-400 border-emerald-500/25 bg-emerald-500/5',
  moderate: 'text-amber-400 border-amber-500/25 bg-amber-500/5',
  dangerous: 'text-rose-400 border-rose-500/25 bg-rose-500/5',
};

// Execution admits an agent when authorityLevel <= authLevelRequired, so the
// number is the widest level admitted (3 = every level).
function authorityLabel(level: number): string {
  return level >= 3 ? 'All levels' : `L0-L${level}`;
}

export default function ToolWhitelistTab() {
  const { toolkitModules, agents, updateToolkitModule } = useCrowdOSStore();
  const { showError } = useToast();

  const [registryTools, setRegistryTools] = useState<RegistryTool[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedModuleId, setSelectedModuleId] = useState('');
  const [enabledIds, setEnabledIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const loadTools = React.useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const tools = await fetchJsonOrThrow<RegistryTool[]>(
        '/api/tools?limit=200',
        { method: 'GET' },
        'Failed to load the tool registry.',
      );
      setRegistryTools(tools);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load the tool registry.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  // Keep a valid selection as the catalog hydrates or a module is deleted.
  useEffect(() => {
    if (toolkitModules.length === 0) {
      if (selectedModuleId) setSelectedModuleId('');
      return;
    }
    if (!toolkitModules.some((m) => m.id === selectedModuleId)) {
      setSelectedModuleId(toolkitModules[0].id);
    }
  }, [toolkitModules, selectedModuleId]);

  const selectedModule = toolkitModules.find((m) => m.id === selectedModuleId) ?? null;

  // Mirror the selected module's grants so a toggle renders immediately; the
  // server write is the truth and reverts on failure.
  useEffect(() => {
    setEnabledIds(selectedModule?.enabledToolIds ?? []);
  }, [selectedModule?.id, selectedModule?.enabledToolIds]);

  const toolsById = useMemo(() => new Map(registryTools.map((t) => [t.id, t])), [registryTools]);

  // Grants for ids the registry no longer knows (legacy demo ids or a removed
  // MCP server) are surfaced, not silently dropped from the count.
  const unknownIds = useMemo(
    () => enabledIds.filter((id) => !toolsById.has(id)),
    [enabledIds, toolsById],
  );

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = registryTools.filter((t) => {
      if (!needle) return true;
      return [t.id, t.displayName, t.description, t.category]
        .some((field) => String(field ?? '').toLowerCase().includes(needle));
    });
    const groups = new Map<string, RegistryTool[]>();
    for (const tool of matches) {
      const list = groups.get(tool.category) ?? [];
      list.push(tool);
      groups.set(tool.category, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [registryTools, query]);

  const boundAgentCount = selectedModule
    ? agents.filter((a) => a.toolkitModuleId === selectedModule.id).length
    : 0;

  const toggleTool = async (toolId: string) => {
    if (!selectedModule || saving) return;
    const previous = enabledIds;
    const next = previous.includes(toolId)
      ? previous.filter((id) => id !== toolId)
      : [...previous, toolId];
    setEnabledIds(next);
    setSaving(true);
    try {
      await updateToolkitModule(selectedModule.id, { enabledToolIds: next });
    } catch (err) {
      setEnabledIds(previous);
      showError(
        'Tool grant failed',
        err instanceof Error ? err.message : 'The toolkit module was not updated.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 text-xs font-sans">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-zinc-200">Security Tool Whitelist</h3>
          <p className="text-zinc-500">
            Grants are persisted on the toolkit module and enforced at tool execution. Universal
            tools are available to every agent and cannot be removed.
          </p>
        </div>
        <button
          onClick={() => void loadTools()}
          disabled={isLoading}
          className="px-2.5 py-1 text-[11px] font-mono text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700 bg-zinc-950 rounded transition flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw size={11} className={isLoading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="bg-zinc-950/40 border border-zinc-900 rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="toolkit-module-select" className="text-[11px] font-medium text-zinc-400">
            Toolkit module
          </label>
          <select
            id="toolkit-module-select"
            value={selectedModuleId}
            onChange={(e) => setSelectedModuleId(e.target.value)}
            disabled={toolkitModules.length === 0 || saving}
            className="min-w-[220px] bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-zinc-150 text-[11.5px] outline-none focus:border-zinc-700 disabled:opacity-50"
          >
            {toolkitModules.length === 0 && <option value="">No toolkit modules</option>}
            {toolkitModules.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>

          {selectedModule && (
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-mono text-zinc-500">
              <span className="text-teal-400">{enabledIds.length} granted</span>
              <span aria-hidden="true">/</span>
              <span>{registryTools.length} registered</span>
              <span aria-hidden="true">/</span>
              <span>{boundAgentCount} agent{boundAgentCount === 1 ? '' : 's'} bound</span>
            </div>
          )}
        </div>

        {toolkitModules.length === 0 && (
          <div className="text-zinc-500 text-[11.5px] leading-relaxed">
            No toolkit modules exist in this workspace yet. Create one under Skills Manager, then
            return here to grant its tools.
          </div>
        )}

        {selectedModule && (
          <>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by tool id, name, or category"
                aria-label="Filter tools"
                className="w-full bg-zinc-950 border border-zinc-850 rounded pl-8 pr-2.5 py-1.5 text-zinc-150 text-[11.5px] outline-none focus:border-zinc-700"
              />
            </div>

            {unknownIds.length > 0 && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 space-y-1.5">
                <div className="text-[11px] font-medium text-amber-300">
                  Grants with no registered tool
                </div>
                <p className="text-[10.5px] text-amber-200/70 leading-normal">
                  These ids no longer exist in the registry and grant nothing. Removing them keeps
                  the module honest.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {unknownIds.map((id) => (
                    <button
                      key={id}
                      onClick={() => void toggleTool(id)}
                      disabled={saving}
                      title={`Remove ${id}`}
                      className="px-1.5 py-0.5 rounded text-[9px] font-mono text-amber-300 bg-zinc-950 border border-amber-500/30 hover:border-amber-400/50 transition disabled:opacity-50"
                    >
                      {id} x
                    </button>
                  ))}
                </div>
              </div>
            )}

            {isLoading ? (
              <div className="flex items-center gap-2 py-8 justify-center text-zinc-500 text-[11.5px]">
                <Loader2 size={14} className="animate-spin" />
                <span>Loading the tool registry...</span>
              </div>
            ) : loadError ? (
              <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-[11.5px] text-rose-200">
                {loadError}
              </div>
            ) : visibleGroups.length === 0 ? (
              <div className="py-8 text-center text-zinc-500 text-[11.5px]">
                No tools match "{query}".
              </div>
            ) : (
              <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1 scrollbar-thin">
                {visibleGroups.map(([category, categoryTools]) => (
                  <section key={category} className="space-y-1.5">
                    <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                      <Wrench size={10} />
                      <span>{category}</span>
                      <span className="text-zinc-700">({categoryTools.length})</span>
                    </div>
                    <div className="space-y-1.5">
                      {categoryTools.map((tool) => {
                        const granted = enabledIds.includes(tool.id);
                        return (
                          <div
                            key={tool.id}
                            className="bg-zinc-900/35 border border-zinc-900 p-2.5 rounded-lg flex items-center justify-between gap-4"
                          >
                            <div className="space-y-1 min-w-0">
                              <div className="flex flex-wrap items-baseline gap-2">
                                <span className="font-semibold text-zinc-200 text-[11.5px]">{tool.displayName}</span>
                                <span className="font-mono text-[9.5px] text-zinc-500">{tool.id}</span>
                                <span className={`text-[8.5px] font-mono border rounded px-1 ${DANGER_CLASS[tool.dangerLevel] ?? 'text-zinc-400 border-zinc-800 bg-zinc-950'}`}>
                                  {tool.dangerLevel}
                                </span>
                                <span className="text-[8.5px] font-mono text-zinc-500 bg-zinc-950 border border-zinc-900 rounded px-1">
                                  {authorityLabel(tool.authLevelRequired)}
                                </span>
                                {tool.sourceType === 'mcp' && (
                                  <span className="text-[8.5px] font-mono text-indigo-300 bg-indigo-500/10 border border-indigo-500/25 rounded px-1">
                                    MCP
                                  </span>
                                )}
                              </div>
                              <p className="text-zinc-450 text-[10.5px] leading-normal line-clamp-2">{tool.description}</p>
                            </div>

                            <div className="shrink-0">
                              {tool.universal ? (
                                <span
                                  className="flex items-center gap-1 text-[9.5px] font-mono text-teal-400/80"
                                  title="Injected for every agent; toolkit grants add nothing"
                                >
                                  <ShieldCheck size={13} />
                                  universal
                                </span>
                              ) : (
                                <button
                                  onClick={() => void toggleTool(tool.id)}
                                  disabled={saving}
                                  role="switch"
                                  aria-checked={granted}
                                  aria-label={`${granted ? 'Revoke' : 'Grant'} ${tool.id}`}
                                  className={`p-1 rounded transition focus:outline-none disabled:opacity-50 ${
                                    granted ? 'text-teal-400' : 'text-zinc-600 hover:text-zinc-500'
                                  }`}
                                >
                                  {granted ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
