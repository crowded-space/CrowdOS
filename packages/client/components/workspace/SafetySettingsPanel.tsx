import { useEffect, useState } from 'react';
import { Shield, Check, Loader2, AlertTriangle } from 'lucide-react';

type Scope = 'once' | 'session' | 'channel' | 'workspace' | 'global';

interface Props {
  targetType: 'workspace' | 'channel';
  targetId: string;
}

export default function SafetySettingsPanel({ targetType, targetId }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [policy, setPolicy] = useState<{ requireApprovalFor: string[]; autoAllowPaths: string[]; blockPaths: string[] }>({ requireApprovalFor: ['delete','execute'], autoAllowPaths: [], blockPaths: [] });
  const [defaultScope, setDefaultScope] = useState<Scope>('session');
  const [error, setError] = useState<string | null>(null);

  async function fetchSettings() {
    setLoading(true);
    try {
      const url = targetType === 'workspace' ? `/api/workspaces/${targetId}/safety` : `/api/channels/${targetId}/safety`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.fsPolicy) setPolicy(data.fsPolicy);
      if (data.safetySettings?.defaultApprovalScope) setDefaultScope(data.safetySettings.defaultApprovalScope);
      if (data.approvalDefaults?.defaultScope) setDefaultScope(data.approvalDefaults.defaultScope);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { fetchSettings(); }, [targetId, targetType]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const url = targetType === 'workspace' ? `/api/workspaces/${targetId}/safety` : `/api/channels/${targetId}/safety`;
      const body = targetType === 'workspace' ? { fsPolicy: policy, approvalDefaults: { defaultScope: defaultScope, allowGlobalAlwaysAllow: false } } : { fsPolicy: policy, safetySettings: { defaultApprovalScope: defaultScope, allowInheritCategoryMount: true } };
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).message || 'Save failed');
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  }

  const toggleRequire = (op: string) => {
    setPolicy((p) => ({ ...p, requireApprovalFor: p.requireApprovalFor.includes(op) ? p.requireApprovalFor.filter((x) => x !== op) : [...p.requireApprovalFor, op] }));
  };

  if (loading) return <div className="text-xs text-zinc-500 p-3 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading safety settings…</div>;

  return (
    <div className="space-y-3 p-3 bg-zinc-900 border border-zinc-800 rounded-xl">
      <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200"><Shield size={14} className="text-amber-400" /> FS Safety — {targetType}</div>
      <p className="text-[11px] text-zinc-500">Choose which FS operations require approval before execution. Agent will show warning and wait for: <span className="text-zinc-300">Always Allow</span> / <span className="text-zinc-300">Allow on Channel</span> / <span className="text-zinc-300">Allow on Workspace</span> / <span className="text-zinc-300">Session</span>.</p>

      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-zinc-400">Require approval for</div>
        {(['write','delete','execute'] as const).map((op) => (
          <label key={op} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={policy.requireApprovalFor.includes(op)} onChange={() => toggleRequire(op)} className="rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500" />
            <span className="capitalize">{op}</span>
            <span className="text-[11px] text-zinc-500 ml-auto">{op === 'write' ? 'write_file/edit_file' : op === 'delete' ? 'delete_file' : 'execute_bash/safe'}</span>
          </label>
        ))}
      </div>

      <div className="space-y-1">
        <label className="text-[11px] text-zinc-500">Default approval scope</label>
        <select value={defaultScope} onChange={(e) => setDefaultScope(e.target.value as Scope)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-xs text-zinc-200 focus:outline-none">
          <option value="once">Allow once</option>
          <option value="session">Allow for session (1h, default)</option>
          <option value="channel">Allow on this channel (30d)</option>
          <option value="workspace">Allow on workspace (30d)</option>
          <option value="global">Always allow (global, indefinite)</option>
        </select>
        {defaultScope === 'global' && <p className="text-[11px] text-amber-400 flex items-center gap-1"><AlertTriangle size={10} /> Global always-allow is powerful — blocked unless workspace allows it.</p>}
      </div>

      <button onClick={save} disabled={saving} className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50">
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save safety policy
      </button>

      {error && <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1">{error}</div>}
    </div>
  );
}
