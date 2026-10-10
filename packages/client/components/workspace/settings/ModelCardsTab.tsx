import React, { useState } from 'react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { ModelModule, ProviderType } from '@/types/crowdOs';
import { Plus, Trash2, CheckCircle2, AlertCircle, RefreshCw, Cpu, RotateCcw } from 'lucide-react';
import { useToast } from '@/components/ui/ToastProvider';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { apiClient, apiErrorStatus } from '@/src/api/client';

export default function ModelCardsTab() {
  const { 
    modelModules, 
    addModelModule, 
    updateModelModule, 
    deleteModelModule 
  } = useCrowdOSStore();

  const { showSuccess, showError } = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form Fields
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState<ProviderType>('custom');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  // Numeric fields keep the raw input so clearing the box never stores NaN:
  // empty means "leave unchanged on edit, default on create".
  const [temperature, setTemperature] = useState('0.7');
  const [maxTokens, setMaxTokens] = useState('2048');
  const DEFAULT_TEMPERATURE = 0.7;
  const DEFAULT_MAX_TOKENS = 2048;
  const coerceTemperature = (raw: string, fallback: number): number | undefined => {
    if (raw.trim() === '') return undefined;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const coerceMaxTokens = (raw: string, fallback: number): number | undefined => {
    if (raw.trim() === '') return undefined;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  // UI testing state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; msg: string }>>({});

  // Confirmation dialog state
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
  }>({
    open: false,
    title: '',
    description: '',
    onConfirm: () => {}
  });

  const askConfirmation = (opts: {
    title: string;
    description: string;
    onConfirm: () => void;
  }) => {
    setConfirmModal({
      open: true,
      title: opts.title,
      description: opts.description,
      onConfirm: () => {
        opts.onConfirm();
        setConfirmModal(prev => ({ ...prev, open: false }));
      }
    });
  };

  const resetForm = () => {
    setLabel('');
    setProvider('custom');
    setModelName('');
    setApiKey('');
    setBaseUrl('');
    setTemperature(String(DEFAULT_TEMPERATURE));
    setMaxTokens(String(DEFAULT_MAX_TOKENS));
    setEditingId(null);
    setFormOpen(false);
  };

  const handleEdit = (mod: ModelModule) => {
    setEditingId(mod.id);
    setLabel(mod.name);
    setProvider(mod.provider);
    setModelName(mod.modelProfileId);
    // Never prefill the key: reads return a redacted mask, and sending that
    // mask back would overwrite the stored credential. Blank = keep existing.
    setApiKey('');
    setBaseUrl(mod.baseUrl || '');
    setTemperature(mod.temperature != null && Number.isFinite(mod.temperature) ? String(mod.temperature) : '');
    setMaxTokens(mod.maxTokens != null && Number.isFinite(mod.maxTokens) ? String(mod.maxTokens) : '');
    setFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label || !modelName) return;

    // Only send an apiKey when the user actually typed one; on edit an empty
    // field means "keep the stored key".
    const trimmedKey = apiKey.trim();
    // Empty numeric fields mean "leave unchanged" on edit; on create they
    // fall back to the defaults so the server never sees NaN or blanks.
    const tempValue = editingId
      ? coerceTemperature(temperature, DEFAULT_TEMPERATURE)
      : (coerceTemperature(temperature, DEFAULT_TEMPERATURE) ?? DEFAULT_TEMPERATURE);
    const maxValue = editingId
      ? coerceMaxTokens(maxTokens, DEFAULT_MAX_TOKENS)
      : (coerceMaxTokens(maxTokens, DEFAULT_MAX_TOKENS) ?? DEFAULT_MAX_TOKENS);
    const payload = {
      name: label,
      provider,
      modelProfileId: modelName,
      apiKey: trimmedKey || undefined,
      baseUrl,
      temperature: tempValue,
      maxTokens: maxValue
    };
    try {
      if (editingId) {
        await updateModelModule(editingId, payload);
      } else {
        await addModelModule(payload);
      }
      resetForm();
    } catch (err) {
      showError('Failed to save model', err instanceof Error ? err.message : 'Failed to save ModelModule.');
    }
  };

  const testConnection = async (mod: ModelModule) => {
    const id = mod.id;
    setTestingId(id);
    setTestResult(prev => ({ ...prev, [id]: { success: false, msg: '' } }));

    try {
      const data = await apiClient.testModelModule(id);
      setTestingId(null);
      if (data.success) {
        setTestResult(prev => ({
          ...prev,
          [id]: { success: true, msg: data.message || 'API channel verified. Handshake success.' }
        }));
      } else {
        const hint = mod.provider === 'custom'
          ? ' Custom endpoints have no live probe: saving is config-only until the first real run.'
          : '';
        const offlineNote = data.offline ? ' (offline: config shape only)' : '';
        setTestResult(prev => ({
          ...prev,
          [id]: { success: false, msg: `${data.message || 'API key is missing or invalid. Handshake failed.'}${offlineNote}${hint}` }
        }));
      }
    } catch (err) {
      setTestingId(null);
      const status = apiErrorStatus(err);
      if (status === 404) {
        setTestResult(prev => ({
          ...prev,
          [id]: { success: false, msg: 'Model not found on the server. It may have been deleted — refresh the list before retrying.' }
        }));
        return;
      }
      // A down or unreachable custom endpoint answers with a network error
      // or a 5xx, never a 404: keep those distinct so a stopped local
      // endpoint is never mistaken for a deleted model.
      const message = err instanceof Error ? err.message : 'Connection test failed. Backend unreachable.';
      const offline = /unreachable|offline|fetch failed|ENOTFOUND|ECONNREFUSED|aborted|timeout/i.test(message);
      if (offline) {
        setTestResult(prev => ({
          ...prev,
          [id]: { success: false, msg: `${message} The endpoint looks down or unreachable — the model itself is still registered.` }
        }));
        return;
      }
      const statusNote = typeof status === 'number' ? ` (HTTP ${status})` : '';
      setTestResult(prev => ({
        ...prev,
        [id]: { success: false, msg: `Connection test failed${statusNote}: ${message}` }
      }));
    }
  };

  return (
    <div id="model-cards-tab" className="space-y-4 text-xs">
      <div>
        <h3 className="text-zinc-200 font-semibold text-sm tracking-tight mb-0.5">Model Modules</h3>
        <p className="text-zinc-500 font-sans">Provision and tune LLM cognitive profiles bound to target orchestration pipelines.</p>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-zinc-900">
        <div>
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-indigo-400" />
            <h3 className="text-sm font-semibold text-zinc-200">
              Registered Model Providers
            </h3>
          </div>
          <p className="text-[11px] text-zinc-450 font-sans leading-relaxed">
            Manage computing models (Gemini, OpenAI, Anthropic, Ollama). Configure API keys, temperatures, and model endpoints.
          </p>
        </div>

        <button
          onClick={() => {
            if (formOpen) resetForm();
            else setFormOpen(true);
          }}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium flex items-center gap-1.5 shrink-0 transition select-none cursor-pointer focus:outline-none"
        >
          <Plus size={14} />
          <span>{formOpen ? 'Cancel' : 'New Model Profile'}</span>
        </button>
      </div>

      {/* Form Accordion */}
      {formOpen && (
        <form onSubmit={handleSave} className="p-4 bg-zinc-950 border border-indigo-500/20 rounded-lg space-y-3.5 shadow-xl animate-fade-in">
          <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
            <span className="font-medium text-indigo-400 text-[12px]">
              {editingId ? 'Edit model profile' : 'New model module'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 leading-snug">
            <div className="space-y-1">
              <label className="text-zinc-500 block font-medium text-[11px]">Module name</label>
              <input
                type="text"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Gemini 2.0 Flash Production"
                className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none placeholder-zinc-650"
              />
            </div>

            <div className="space-y-1">
              <label className="text-zinc-500 block font-medium text-[11px]">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderType)}
                className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none cursor-pointer"
              >
                <option value="google">Google Gemini</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama (Local / Self-Hosted)</option>
                <option value="custom">Custom OpenAI-Compatible API</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 leading-snug">
            <div className="space-y-1">
              <label className="text-zinc-500 block font-medium text-[11px]">Model</label>
              <input
                type="text"
                required
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="e.g. gemini-2.0-flash or gpt-4o"
                className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none font-mono placeholder-zinc-650"
              />
            </div>

            <div className="space-y-1">
              <label className="text-zinc-500 block font-bold font-mono text-[10px]">TEMPERATURE (0.0 - 2.0)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-zinc-500 block font-medium text-[11px]">Max output tokens</label>
              <input
                type="number"
                min="1"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none font-mono"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-zinc-500 block font-bold font-mono text-[10px]">CUSTOM BASE ENDPOINT URL (OPTIONAL)</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="e.g. http://localhost:11434 or https://my-proxy.com/v1"
              className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none font-mono placeholder-zinc-650"
            />
          </div>

          <div className="space-y-1">
              <label className="text-zinc-500 block font-medium text-[11px]">API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={editingId ? '••••••••••••••••••••' : 'Enter secret API connection token'}
              className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/40 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none placeholder-zinc-650"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1 select-none">
            <button
               type="button"
               onClick={resetForm}
               className="px-2.5 py-1.5 rounded-md border border-zinc-800 hover:bg-zinc-900 text-zinc-400 font-semibold transition select-none cursor-pointer focus:outline-none"
            >
              Cancel
            </button>
            <button
               type="submit"
               className="px-2.5 py-1.5 rounded-md bg-indigo-500 hover:bg-indigo-600 text-white font-semibold transition select-none cursor-pointer focus:outline-none"
            >
              {editingId ? 'Commit Update' : 'Initialize Register'}
            </button>
          </div>
        </form>
      )}

      {/* Profiles Roster List */}
      <div className="space-y-2">
        {modelModules.length === 0 && !formOpen && (
          <div className="p-4 bg-zinc-900/30 border border-dashed border-zinc-800 rounded-lg text-center">
            <div className="text-zinc-300 text-xs font-semibold">No model providers configured</div>
            <div className="text-zinc-500 text-[11px] font-sans mt-1">Register a provider above to enable agent orchestration. No default provider is assumed.</div>
          </div>
        )}
        {modelModules.map(mod => {
          const result = testResult[mod.id];
          const isTesting = testingId === mod.id;

          return (
            <div 
              key={mod.id} 
              className="p-3 bg-zinc-900/30 border border-zinc-900 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-sans leading-none hover:border-zinc-800 transition"
              id={`profile-card-${mod.id}`}
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-zinc-200 text-xs truncate">
                    {mod.name}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[9px] font-mono text-zinc-450">
                    {mod.provider}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                  <span className="bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-900">{mod.modelProfileId}</span>
                  <span className="text-zinc-600">•</span>
                  <span>Temp {mod.temperature ?? 0.7}</span>
                  <span className="text-zinc-600">•</span>
                  <span>Max Tokens {mod.maxTokens ?? 2048}</span>
                </div>
                {mod.baseUrl && (
                  <div className="text-[9px] font-mono text-zinc-550 italic block truncate">
                    Base: {mod.baseUrl}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 min-w-0 max-w-full select-none">
                {result && (
                  <span className={`order-first w-full text-[10px] font-mono leading-relaxed break-words whitespace-normal flex items-start gap-1 px-2 py-1 rounded ${
                    result.success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                  }`}>
                    {result.success ? <CheckCircle2 size={10} className="mt-0.5 shrink-0" /> : <AlertCircle size={10} className="mt-0.5 shrink-0" />}
                    <span className="min-w-0 flex-1">{result.msg}</span>
                  </span>
                )}

                <button
                  disabled={isTesting}
                  onClick={() => testConnection(mod)}
                  className="px-2 py-1 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100 text-[10px] rounded flex items-center gap-1 transition cursor-pointer disabled:opacity-50 focus:outline-none"
                  title={`Test connection to ${mod.name}`}
                  aria-label={`Test connection to ${mod.name}`}
                >
                  <RefreshCw size={10} className={isTesting ? 'animate-spin' : ''} aria-hidden="true" />
                  <span>{isTesting ? 'Testing...' : result && !result.success ? 'Retry' : 'Test'}</span>
                </button>

                {result && !result.success && !isTesting && (
                  <button
                    onClick={() => handleEdit(mod)}
                    className="px-2 py-1 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-zinc-100 text-[10px] rounded flex items-center gap-1 transition cursor-pointer focus:outline-none"
                    title={`Edit ${mod.name} to fix the failing config`}
                    aria-label={`Edit ${mod.name} to fix the failing config`}
                  >
                    <RotateCcw size={10} aria-hidden="true" />
                    <span>Fix</span>
                  </button>
                )}

                <button
                  onClick={() => handleEdit(mod)}
                  className="px-2 py-1 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-zinc-400 text-[10px] rounded cursor-pointer focus:outline-none"
                >
                  Edit
                </button>

                <button
                  onClick={() => {
                    askConfirmation({
                      title: `De-register Model ${mod.name}?`,
                      description: 'This computing model profile will be removed from your workspace routing. Active agents using this profile will become unassigned (no model).',
                      onConfirm: async () => {
                        try {
                          await deleteModelModule(mod.id);
                          showSuccess('Model De-registered', mod.name);
                        } catch (err) {
                          showError('De-registration Failed', err instanceof Error ? err.message : 'Failed to delete ModelModule.');
                        }
                      }
                    });
                  }}
                  className="p-1 px-1.5 bg-zinc-950 hover:bg-rose-950/40 text-rose-400 border border-zinc-800 rounded hover:border-rose-900 transition cursor-pointer focus:outline-none"
                  title={`De-register model ${mod.name}`}
                  aria-label={`De-register model ${mod.name}`}
                >
                  <Trash2 size={11.5} aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Styled Confirmation Dialog */}
      <ConfirmDialog
        open={confirmModal.open}
        title={confirmModal.title}
        description={confirmModal.description}
        confirmLabel="De-register"
        isDanger={true}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}
