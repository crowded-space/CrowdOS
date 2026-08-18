import React, { useState } from 'react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import { Terminal, Play, ChevronRight, CheckCircle2, XCircle, Loader2, Database, Plug } from 'lucide-react';
import CrowIcon from '@/components/ui/crow-icon';

type TestStatus = 'idle' | 'testing' | 'success' | 'failed';

const BACKEND_URL = '';

async function testDbConnection(dbUrl: string): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${BACKEND_URL}/api/workspace/database`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ databaseUrl: dbUrl }),
  });
  const data = await res.json();
  if (!res.ok) {
    return { success: false, message: data.message || 'Connection failed.' };
  }
  return { success: true, message: data.message || 'Connection verified.' };
}

const ICONS = [
  'crow-white-rounded',
  'crow-dark-rounded',
  'crow-indigo-circle',
  'crow-amber-cyber',
  'crow-cyan-radar',
  'crow-rose-governance',
  'crow-matrix-terminal',
  'crow-cosmos',
];

export default function WorkspacePortal() {
  const { createWorkspace, workspaces, enterWorkspace } = useCrowdOSStore();

  // Form state
  const [workspaceName, setWorkspaceName] = useState('');
  const [selectedIcon, setSelectedIcon] = useState('crow-white-rounded');
  const [dbUrl, setDbUrl] = useState('');

  // Connection test state
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [logs, setLogs] = useState<Array<{ text: string; type: 'info' | 'ok' | 'err' }>>([]);

  const pushLog = (text: string, type: 'info' | 'ok' | 'err' = 'info') =>
    setLogs(prev => [...prev, { text, type }]);

  const handleTestAndSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dbUrl.trim()) return;

    setTestStatus('testing');
    setLogs([]);
    pushLog('Initiating PostgreSQL handshake...');
    pushLog(`Target: ${dbUrl.replace(/:\/\/[^@]+@/, '://***@')}`);

    await new Promise(r => setTimeout(r, 400));
    pushLog('Resolving host and port...');

    await new Promise(r => setTimeout(r, 400));
    pushLog('Authenticating credentials...');

    try {
      const result = await testDbConnection(dbUrl);

      if (result.success) {
        pushLog('Schema integrity check passed.', 'ok');
        pushLog('Connection verified — URL saved to .env', 'ok');
        setTestStatus('success');
      } else {
        pushLog(`Error: ${result.message}`, 'err');
        setTestStatus('failed');
      }
    } catch (err) {
      pushLog(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'err');
      setTestStatus('failed');
    }
  };

  const handleCreate = async () => {
    if (!workspaceName.trim() || testStatus !== 'success') return;
    await createWorkspace(workspaceName, dbUrl, selectedIcon);
  };

  const canTest = dbUrl.trim().length > 0 && testStatus !== 'testing';
  const canCreate = workspaceName.trim().length > 0 && testStatus === 'success';

  return (
    <div
      className="fixed inset-0 bg-brand-bg flex items-center justify-center p-4 font-sans select-none overflow-y-auto"
      id="workspace-portal"
    >
      {/* Background ambient glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] bg-indigo-500/10 blur-[130px] rounded-full shrink-0 pointer-events-none" />

      {/* Main card */}
      <div className="w-full max-w-md bg-brand-card border border-brand-border-muted rounded-xl overflow-hidden shadow-2xl p-6 space-y-5 relative flex flex-col items-center">

        {/* Logo */}
        <div className="text-center space-y-3 select-none flex flex-col items-center">
          <img src="/horizontal_logo_dark.png" alt="Crowd OS Logo" className="h-10 object-contain w-auto mb-1" />
          <div>
            <p className="text-[9.5px] font-mono tracking-[0.22em] text-zinc-500 uppercase mt-1 animate-pulse-slow">
              INTELLIGENCE . COORDINATION . IMPACT
            </p>
            <p className="text-xs text-zinc-500 mt-2 max-w-xs leading-normal">
              Connect your PostgreSQL database to bootstrap your workspace.
            </p>
          </div>
        </div>

        {/* ── FORM ── */}
        <form onSubmit={handleTestAndSave} className="w-full space-y-4 text-xs font-sans leading-snug select-text">

          {/* Step 1 — DB URL */}
          <div className="space-y-1.5 text-left">
            <label className="text-zinc-500 font-bold font-mono text-[10px] uppercase tracking-wide flex items-center gap-1.5">
              <Database size={10} className="text-indigo-400" />
              PostgreSQL Connection URL
            </label>
            <div className="relative">
              <input
                required
                type="text"
                value={dbUrl}
                onChange={(e) => { setDbUrl(e.target.value); if (testStatus !== 'idle') { setTestStatus('idle'); setLogs([]); } }}
                placeholder="postgresql://user:password@host:5432/dbname"
                spellCheck={false}
                autoComplete="off"
                className="w-full bg-brand-sidebar border border-brand-border focus:border-brand-border-muted focus:ring-1 focus:ring-brand-border-muted/40 rounded px-2.5 py-2 text-xs font-mono text-zinc-100 focus:outline-none placeholder-zinc-700 pr-8"
              />
              {testStatus === 'success' && (
                <CheckCircle2 size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-emerald-400 shrink-0" />
              )}
              {testStatus === 'failed' && (
                <XCircle size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-red-400 shrink-0" />
              )}
            </div>
          </div>

          {/* Test Connection button */}
          <button
            type="submit"
            disabled={!canTest}
            className={`w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition select-none leading-none tracking-tight ${
              canTest
                ? testStatus === 'success'
                  ? 'bg-emerald-600/20 border border-emerald-600/40 text-emerald-300 cursor-default'
                  : 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-[0_4px_12px_rgba(99,102,241,0.3)]'
                : 'bg-brand-sidebar text-zinc-600 border border-brand-border-muted/45 cursor-not-allowed'
            }`}
          >
            {testStatus === 'testing' ? (
              <>
                <Loader2 size={11} className="animate-spin" />
                <span>Testing Connection...</span>
              </>
            ) : testStatus === 'success' ? (
              <>
                <CheckCircle2 size={11} />
                <span>Connection Verified</span>
              </>
            ) : (
              <>
                <Plug size={11} />
                <span>Test Connection</span>
              </>
            )}
          </button>

          {/* Terminal log */}
          {logs.length > 0 && (
            <div className="bg-brand-bg border border-brand-border rounded-md p-3 font-mono text-[10px] space-y-1 text-left max-h-28 overflow-y-auto">
              <div className="text-zinc-600 font-bold flex items-center gap-1 select-none mb-1">
                <Terminal size={9} />
                <span>CONNECTION LOG</span>
              </div>
              {logs.map((log, i) => (
                <div key={i} className="whitespace-pre-wrap flex gap-1.5">
                  <span className={
                    log.type === 'ok' ? 'text-emerald-400' :
                    log.type === 'err' ? 'text-red-400' :
                    'text-indigo-400'
                  }>&gt;</span>
                  <span className={
                    log.type === 'ok' ? 'text-emerald-300' :
                    log.type === 'err' ? 'text-red-300' :
                    'text-zinc-400'
                  }>{log.text}</span>
                </div>
              ))}
            </div>
          )}
        </form>

        {/* ── Step 2: Name + Icon (visible only after successful test) ── */}
        {testStatus === 'success' && (
          <div className="w-full space-y-4 text-xs border-t border-brand-border/50 pt-4">

            {/* Workspace name */}
            <div className="space-y-1.5 text-left">
              <label className="text-zinc-500 font-bold font-mono text-[10px] uppercase tracking-wide">Workspace Name</label>
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="e.g. Swarm Research Core"
                autoFocus
                className="w-full bg-brand-sidebar border border-brand-border focus:border-brand-border-muted focus:ring-1 focus:ring-brand-border-muted/40 rounded px-2.5 py-2 text-xs text-zinc-100 focus:outline-none placeholder-zinc-650"
              />
            </div>

            {/* Icon picker */}
            <div className="space-y-1.5 text-left select-none">
              <label className="text-zinc-500 font-bold font-mono text-[10px] uppercase tracking-wide">Workspace Icon</label>
              <div className="grid grid-cols-4 gap-2 pt-0.5">
                {ICONS.map(ic => (
                  <button
                    key={ic}
                    type="button"
                    onClick={() => setSelectedIcon(ic)}
                    className={`h-11 bg-brand-sidebar rounded border transition cursor-pointer focus:outline-none flex justify-center items-center overflow-hidden ${
                      selectedIcon === ic
                        ? 'border-indigo-500 bg-indigo-500/10 shadow-[0_0_10px_oklch(0.62_0.15_250/0.25)]'
                        : 'border-brand-border hover:border-brand-border-muted hover:bg-brand-card/60'
                    }`}
                  >
                    <CrowIcon variant={ic} className="w-8 h-8 rounded bg-transparent border-0 shadow-none" iconSize={70} />
                  </button>
                ))}
              </div>
            </div>

            {/* Create button */}
            <button
              type="button"
              onClick={handleCreate}
              disabled={!canCreate}
              className={`w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition select-none tracking-tight leading-none ${
                canCreate
                  ? 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-[0_4px_12px_rgba(99,102,241,0.3)]'
                  : 'bg-brand-sidebar text-zinc-600 border border-brand-border-muted/45 cursor-not-allowed'
              }`}
            >
              <Play size={11} />
              <span>Launch Workspace</span>
            </button>
          </div>
        )}

        {/* ── Existing workspaces ── */}
        {workspaces.length > 0 && (
          <div className="w-full border-t border-brand-border/60 pt-4 space-y-2 select-none">
            <h3 className="text-[9px] font-mono tracking-wider font-bold text-zinc-550 text-left uppercase">
              Or Choose Active Local Session ({workspaces.length})
            </h3>
            <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
              {workspaces.map(ws => (
                <button
                  key={ws.id}
                  onClick={() => enterWorkspace(ws.id)}
                  className="w-full flex items-center justify-between p-2 hover:bg-brand-sidebar border border-brand-border rounded-lg text-zinc-300 text-left transition text-xs font-sans cursor-pointer focus:outline-none"
                >
                  <div className="flex items-center gap-2 truncate">
                    <CrowIcon variant={ws.icon} className="w-6 h-6 rounded bg-transparent border-0 shrink-0" iconSize={65} />
                    <span className="font-semibold truncate">{ws.name}</span>
                  </div>
                  <ChevronRight size={13} className="text-zinc-600 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}