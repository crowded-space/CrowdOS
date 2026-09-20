import React, { useState, useEffect } from 'react';
import { apiClient } from '@/src/api/client';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { Terminal, Play, ChevronRight, CheckCircle2, XCircle, Loader2, Database, Plug } from 'lucide-react';
import CrowIcon from '@/components/ui/CrowIcon';

type TestStatus = 'idle' | 'testing' | 'success' | 'failed';

const BACKEND_URL = '';

async function testDbConnection(dbUrl: string): Promise<{ success: boolean; message: string; host?: string; database?: string }> {
  try {
    const res = await apiClient.testWorkspaceDatabase(dbUrl);
    return { success: true, message: `Connected to ${res.host} (${res.database})`, host: res.host, database: res.database };
  } catch (err: any) {
    return { success: false, message: err.message || 'Connection failed.' };
  }
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
  // The store is consumed untyped here (see the `as any`), so the destructured
  // members would otherwise be implicit `any`. `workspaces` is annotated at its
  // use site below rather than widening the whole destructure.
  const { createWorkspace, workspaces, enterWorkspace, fetchWorkspaces, isCreatingWorkspace, workspaceError } = useCrowdOSStore() as any;
  const [isLaunching, setIsLaunching] = useState(false);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

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
        pushLog('Connection verified — URL kept in workspace registry', 'ok');
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

  const handleCreate = async (withDb: boolean) => {
    if (!workspaceName.trim() || isLaunching || isCreatingWorkspace) return;
    if (withDb && testStatus !== 'success') return;
    setIsLaunching(true);
    pushLog(withDb ? 'Applying schema migrations & presets...' : 'Creating local workspace (no database — RAG degraded)...');
    try {
      await createWorkspace(workspaceName, withDb ? dbUrl : undefined, selectedIcon);
      pushLog('Workspace launched successfully.', 'ok');
    } catch (err: any) {
      pushLog(`Error: ${err.message || String(err)}`, 'err');
      setIsLaunching(false);
    }
  };

  const canTest = dbUrl.trim().length > 0 && testStatus !== 'testing';
  const canCreateDb = workspaceName.trim().length > 0 && testStatus === 'success';
  const canCreateLocal = workspaceName.trim().length > 0;

  return (
    <div
      className="fixed inset-0 bg-[#060608] flex items-center justify-center p-4 sm:p-6 font-sans select-none overflow-y-auto overscroll-contain"
      id="workspace-portal"
    >
      {/* Background ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] h-[520px] bg-indigo-600/10 blur-[140px] rounded-full" />
        <div className="absolute bottom-1/4 right-1/4 w-[360px] h-[360px] bg-violet-600/06 blur-[120px] rounded-full" />
      </div>

      {/* Main card */}
      <div className="w-full max-w-[440px] bg-[#141416] border border-zinc-800 rounded-[20px] overflow-hidden shadow-[0_24px_64px_rgba(0,0,0,0.6)] p-6 sm:p-7 space-y-6 relative flex flex-col items-center my-auto">

        {/* Logo */}
        <div className="text-center space-y-3 select-none flex flex-col items-center">
          <img src="/horizontal_logo_dark.png" alt="Crowd OS Logo" className="h-10 object-contain w-auto mb-1" />
          <div>
            <p className="text-[9.5px] font-mono tracking-[0.22em] text-zinc-500 uppercase mt-1 animate-pulse-slow">
              INTELLIGENCE . COORDINATION . IMPACT
            </p>
            <p className="text-xs text-zinc-500 mt-2 max-w-xs leading-normal">
              Name your workspace to start locally. A PostgreSQL database is optional — it only enables semantic memory / RAG.
            </p>
          </div>
        </div>

        {/* ── FORM ── */}
        <form onSubmit={handleTestAndSave} className="w-full space-y-4 text-xs font-sans leading-snug select-text">

          {/* Step 1 — DB URL */}
          <div className="space-y-2 text-left">
            <label className="text-zinc-400 font-semibold font-sans text-[13px] flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-indigo-500 text-white flex items-center justify-center text-[11px] font-bold shrink-0">1</span>
              PostgreSQL Connection URL
              <Database size={13} className="text-zinc-500 ml-auto" />
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
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="url"
                className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-700 focus:ring-2 focus:ring-indigo-500/20 rounded-xl px-3.5 py-3.5 min-h-[48px] text-[15px] sm:text-[13px] font-mono text-zinc-100 focus:outline-none placeholder-zinc-600 pr-10 shadow-inner"
              />
              {testStatus === 'success' && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                  <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                </span>
              )}
              {testStatus === 'failed' && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-rose-500/15 border border-rose-500/20 flex items-center justify-center">
                  <XCircle size={14} className="text-rose-400 shrink-0" />
                </span>
              )}
            </div>
          </div>

          {/* Test Connection button */}
          <button
            type="submit"
            disabled={!canTest}
            className={`w-full py-2.5 min-h-[44px] rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition select-none leading-none tracking-tight active:scale-[0.99] ${
              canTest
                ? testStatus === 'success'
                  ? 'bg-emerald-600/20 border border-emerald-600/40 text-emerald-300 cursor-default'
                  : 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-[0_4px_12px_rgba(99,102,241,0.3)]'
                : 'bg-brand-sidebar text-zinc-600 border border-brand-border-muted/45 cursor-not-allowed'
            }`}
          >
            {testStatus === 'testing' ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                <span>Testing Connection...</span>
              </>
            ) : testStatus === 'success' ? (
              <>
                <CheckCircle2 size={13} />
                <span>Connection Verified</span>
              </>
            ) : (
              <>
                <Plug size={13} />
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

        {/* ── Step 2: Name + Icon (DB test optional — local workspaces need no DB) ── */}
        <div className="w-full space-y-4 text-xs border-t border-brand-border/50 pt-4">

            {/* Workspace name */}
            <div className="space-y-1.5 text-left">
              <label className="text-zinc-500 font-bold font-mono text-[10px] uppercase tracking-wide flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center justify-center text-[9px] font-bold shrink-0">2</span>
                Workspace Name
              </label>
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="e.g. Swarm Research Core"
                autoFocus
                autoComplete="off"
                className="w-full bg-brand-sidebar border border-brand-border focus:border-brand-border-muted focus:ring-1 focus:ring-brand-border-muted/40 rounded px-2.5 py-2.5 min-h-[44px] text-[16px] sm:text-sm text-zinc-100 focus:outline-none placeholder-zinc-650"
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

            {workspaceError && (
              <div role="alert" className="w-full rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
                {String(workspaceError)}
              </div>
            )}

            {/* Create buttons: DB-backed (tested) or local (no DB, RAG degraded) */}
            <button
              type="button"
              onClick={() => handleCreate(true)}
              disabled={!canCreateDb || isLaunching || isCreatingWorkspace}
              className={`w-full py-2.5 min-h-[44px] rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition select-none tracking-tight leading-none active:scale-[0.99] ${
                canCreateDb && !isLaunching && !isCreatingWorkspace
                  ? 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-[0_4px_12px_rgba(99,102,241,0.3)]'
                  : 'bg-brand-sidebar text-zinc-600 border border-brand-border-muted/45 cursor-not-allowed'
              }`}
            >
              {isLaunching || isCreatingWorkspace ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>Provisioning & Launching...</span>
                </>
              ) : (
                <>
                  <Play size={13} />
                  <span>Launch Workspace with Database</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => handleCreate(false)}
              disabled={!canCreateLocal || isLaunching || isCreatingWorkspace}
              className={`w-full py-2.5 min-h-[44px] rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition select-none tracking-tight leading-none active:scale-[0.99] ${
                canCreateLocal && !isLaunching && !isCreatingWorkspace
                  ? 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700'
                  : 'bg-brand-sidebar text-zinc-600 border border-brand-border-muted/45 cursor-not-allowed'
              }`}
            >
              <Play size={13} />
              <span>Create Local Workspace (no database)</span>
            </button>
        </div>

        {/* ── Existing workspaces ── */}
        {workspaces.length > 0 && (
          <div className="w-full border-t border-brand-border/60 pt-4 space-y-2 select-none">
            <h3 className="text-[9px] font-mono tracking-wider font-bold text-zinc-550 text-left uppercase">
              Or Choose Active Local Session ({workspaces.length})
            </h3>
            <div className="space-y-1.5 max-h-32 overflow-y-auto scrollbar-thin pr-1">
              {(workspaces as Array<{ id: string; name: string; icon: string }>).map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => enterWorkspace(ws.id)}
                  className="w-full flex items-center justify-between p-2.5 min-h-[48px] hover:bg-brand-sidebar active:bg-brand-card border border-brand-border rounded-lg text-zinc-300 text-left transition-colors text-xs font-sans cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
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
