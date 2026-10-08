import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient, isPostgresUrl } from '@/src/api/client';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import type { Workspace } from '@/types/crowdOs';
import { CheckCircle2, ChevronDown, Eye, EyeOff, Loader2, MoreHorizontal, Search, XCircle } from 'lucide-react';
import ThemeToggle from '@/components/ui/ThemeToggle';
import WorkspaceMark, { markToneFor } from './WorkspaceMark';
import {
  PORTAL_ICON_IDS,
  filterWorkspaces,
  hideWorkspace,
  maskDatabaseUrl,
  readHiddenWorkspaces,
  readLastOpened,
  recordLastOpened,
  relativeTime,
  sortWorkspacesByRecency,
  truncateMiddle,
  validateWorkspaceName,
  workspaceNameError,
} from './portal-support';

type dbStatus = 'idle' | 'testing' | 'connected' | 'failed';

const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#465EDB]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent';
const INPUT = 'w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-[#465EDB] focus:ring-2 focus:ring-[#465EDB]/25 rounded-md px-3 py-2.5 min-h-[44px] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none transition-colors duration-150';
const ROW = 'w-full flex items-center gap-3 px-3 py-2.5 min-h-[56px] border-b border-zinc-900/80 text-left transition-colors duration-150 cursor-pointer hover:bg-zinc-900/60 active:bg-zinc-900';

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5 select-none" aria-label="CrowdOS">
      <span className="inline-flex w-8 h-8 rounded-md bg-zinc-900 border border-zinc-800 items-center justify-center text-zinc-100" aria-hidden="true">
        <svg viewBox="0 0 120 120" width="20" height="20" fill="none" aria-hidden="true">
          <path d="M58 20 C54 18 48 19 43 23 C38 27 35 32 31 35 C28 38 22 36 17 35 C24 38 28 41 31 43 C32 48 34 54 37 59 C40 65 46 72 54 75 C58 77 62 78 66 79 C63 82 59 86 54 88 C49 90 42 92 37 94 C43 94 53 92 59 89 C64 87 67 85 71 81 C73 84 76 86 79 88 C74 90 69 91 64 92 C71 92 78 91 82 88 C85 86 88 83 91 80 L92 78 C93 80 94 83 96 85 C92 87 87 88 81 89 C85 89 91 88 95 85 C98 83 100 80 101 77 C103 70 104 61 102 51 C100 40 95 30 88 22 C81 14 74 12 66 12 C62 12 59 15 58 20 Z" fill="currentColor" />
        </svg>
      </span>
      <span className="leading-none">
        <span className="block text-[20px] font-semibold tracking-tight text-zinc-100">CrowdOS</span>
        <span className="block text-[11px] text-zinc-500 mt-1">intelligence, coordination, impact</span>
      </span>
    </div>
  );
}

function MemoryDot({ configured }: { configured: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 shrink-0" title={configured ? 'Semantic memory connected' : 'Local only, no semantic memory'}>
      <span aria-hidden="true" className={'w-1.5 h-1.5 rounded-full ' + (configured ? 'bg-emerald-400' : 'bg-zinc-600')} />
      <span>{configured ? 'Memory' : 'Local'}</span>
    </span>
  );
}

export default function WorkspacePortal() {
  const { createWorkspace, workspaces, enterWorkspace, fetchWorkspaces, updateWorkspace, isCreatingWorkspace, workspaceError } = useCrowdOSStore() as any;
  const [isLaunching, setIsLaunching] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<Record<string, number>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchWorkspaces();
    setLastOpened(readLastOpened());
    setHidden(readHiddenWorkspaces());
  }, [fetchWorkspaces]);

  const [workspaceName, setWorkspaceName] = useState('');
  const [selectedIcon, setSelectedIcon] = useState<string>('crow-white-rounded');
  const [dbOpen, setDbOpen] = useState(false);
  const [dbUrl, setDbUrl] = useState('');
  const [dbMasked, setDbMasked] = useState(true);
  const [dbStatus, setDbStatus] = useState<dbStatus>('idle');
  const [dbMessage, setDbMessage] = useState<string | null>(null);
  const [createNote, setCreateNote] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const existingNames = useMemo(() => (workspaces as Workspace[]).map((w) => w.name), [workspaces]);
  const nameCheck = validateWorkspaceName(workspaceName, existingNames);
  const showNameError = workspaceName.trim().length > 0 && !nameCheck.ok;

  const trimmedDb = dbUrl.trim();
  const dbShapeInvalid = trimmedDb.length > 0 && !isPostgresUrl(trimmedDb);
  const dbVerified = dbStatus === 'connected' && !dbShapeInvalid;

  const runDbTest = async () => {
    if (!trimmedDb || dbShapeInvalid || dbStatus === 'testing') return;
    setDbStatus('testing');
    setDbMessage(null);
    try {
      const res = await apiClient.testWorkspaceDatabase(trimmedDb);
      setDbStatus('connected');
      setDbMessage(res.host ? 'Connected to ' + res.host + (res.database ? '/' + res.database : '') : 'Connected.');
    } catch (err) {
      setDbStatus('failed');
      setDbMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  };

  const handleCreate = async () => {
    if (!nameCheck.ok || isLaunching || isCreatingWorkspace || openingId) return;
    setIsLaunching(true);
    setCreateNote(null);
    const useDb = Boolean(trimmedDb) && dbVerified;
    const attemptedDb = trimmedDb.length > 0;
    try {
      await createWorkspace(workspaceName.trim(), useDb ? trimmedDb : undefined, selectedIcon);
      setWorkspaceName('');
    } catch (err: any) {
      if (useDb) {
        try {
          await createWorkspace(workspaceName.trim(), undefined, selectedIcon);
          setCreateNote('Database unreachable. Workspace created locally.');
          setWorkspaceName('');
        } catch (inner: any) {
          setCreateNote(inner instanceof Error ? inner.message : 'Create failed.');
        }
      } else if (attemptedDb && !dbVerified) {
        setCreateNote('Database not verified. Workspace created locally.');
        try {
          await createWorkspace(workspaceName.trim(), undefined, selectedIcon);
          setWorkspaceName('');
        } catch (inner: any) {
          setCreateNote(inner instanceof Error ? inner.message : 'Create failed.');
        }
      } else {
        setCreateNote(err instanceof Error ? err.message : 'Create failed.');
      }
    } finally {
      setIsLaunching(false);
      try {
        setLastOpened(readLastOpened());
      } catch {}
    }
  };

  const openWorkspace = async (id: string) => {
    if (openingId || isLaunching || isCreatingWorkspace) return;
    setOpeningId(id);
    setNotice(null);
    try {
      await enterWorkspace(id);
      setLastOpened(recordLastOpened(id));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not open workspace.');
      setOpeningId(null);
    }
  };

  const visible = useMemo(() => {
    const list = (workspaces as Workspace[]).filter((w) => !hidden.includes(w.id));
    return sortWorkspacesByRecency(filterWorkspaces(list, query), lastOpened);
  }, [workspaces, hidden, query, lastOpened]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, visible.length]);

  const showFilter = (workspaces as Workspace[]).length > 6;

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (visible.length === 0) return;
      setActiveIndex((i) => (e.key === 'ArrowDown' ? Math.min(visible.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if (e.key === 'Enter') {
      const target = visible[activeIndex];
      if (target) void openWorkspace(target.id);
    }
  };

  useEffect(() => {
    const onGlobal = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        nameInputRef.current?.focus();
      } else if (((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) || (!typing && e.key === '/')) {
        if (showFilter) {
          e.preventDefault();
          filterRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', onGlobal);
    return () => window.removeEventListener('keydown', onGlobal);
  }, [showFilter]);

  const submitRename = async () => {
    if (!renaming) return;
    const check = validateWorkspaceName(renaming.value, existingNames.filter((n) => {
      const current = (workspaces as Workspace[]).find((w) => w.id === renaming.id);
      return n !== current?.name;
    }));
    if (!check.ok) {
      setRenaming({ ...renaming, error: workspaceNameError(check.reason) });
      return;
    }
    try {
      await updateWorkspace(renaming.id, { name: renaming.value.trim() });
      setRenaming(null);
      setMenuFor(null);
    } catch (err) {
      setRenaming({ ...renaming, error: err instanceof Error ? err.message : 'Rename failed.' });
    }
  };

  const revealPath = async (ws: Workspace) => {
    try {
      await navigator.clipboard.writeText(ws.id);
      setNotice('Workspace id copied.');
    } catch {
      setNotice('Workspace id: ' + ws.id);
    }
    setMenuFor(null);
  };

  const removeFromList = (id: string) => {
    setHidden(hideWorkspace(id));
    setMenuFor(null);
    setNotice('Removed from list. Workspace data is unchanged.');
  };

  const empty = (workspaces as Workspace[]).length === 0;
  const canCreate = nameCheck.ok && !isLaunching && !isCreatingWorkspace && !openingId;

  const renderRow = (ws: Workspace, index: number) => {
    const opened = lastOpened[ws.id];
    const active = index === activeIndex;
    const opening = openingId === ws.id;
    const configured = Boolean(ws.database?.configured);
    return (
      <div key={ws.id} className="relative group">
        <button
          type="button"
          role="option"
          aria-selected={active}
          data-testid={'workspace-row-' + ws.id}
          onClick={() => void openWorkspace(ws.id)}
          onMouseEnter={() => setActiveIndex(index)}
          className={ROW + ' ' + FOCUS_RING + (active ? ' bg-zinc-900/60' : '')}
        >
          <WorkspaceMark variant={ws.icon || 'crow-white-rounded'} size={32} />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-zinc-100 truncate">{ws.name}</span>
              <span className="tnum text-[11px] text-zinc-500 shrink-0">{relativeTime(opened ?? ws.updatedAt ?? ws.createdAt)}</span>
            </span>
            <span className="flex items-center gap-2 mt-0.5 min-w-0">
              <span className="font-mono text-[11px] text-zinc-500 truncate" title={'Local workspace ' + ws.id}>{truncateMiddle('local · ' + ws.id.slice(0, 8), 44)}</span>
              <MemoryDot configured={configured} />
            </span>
          </span>
          {opening ? <Loader2 size={14} className="animate-spin text-zinc-400 shrink-0" aria-label="Opening" /> : <span className="text-[12px] text-zinc-500 opacity-0 group-hover:opacity-100 shrink-0">Open</span>}
          <span role="button" tabIndex={0} aria-label={'Options for ' + ws.name} onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === ws.id ? null : ws.id); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setMenuFor(menuFor === ws.id ? null : ws.id); } }} className={'p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 ' + FOCUS_RING}>
            <MoreHorizontal size={15} />
          </span>
        </button>
        {menuFor === ws.id && (
          <div role="menu" aria-label={'Options for ' + ws.name} className="absolute right-2 top-full mt-1 z-20 w-52 rounded-md border border-zinc-800 bg-zinc-900 p-1">
            <button type="button" role="menuitem" onClick={() => { setRenaming({ id: ws.id, value: ws.name, error: null }); setMenuFor(null); }} className={'w-full text-left px-2.5 py-2 rounded text-[12px] text-zinc-200 hover:bg-zinc-800 ' + FOCUS_RING}>Rename</button>
            <button type="button" role="menuitem" onClick={() => void revealPath(ws)} className={'w-full text-left px-2.5 py-2 rounded text-[12px] text-zinc-200 hover:bg-zinc-800 ' + FOCUS_RING}>Copy workspace id</button>
            <button type="button" role="menuitem" onClick={() => removeFromList(ws.id)} className={'w-full text-left px-2.5 py-2 rounded text-[12px] text-zinc-200 hover:bg-zinc-800 ' + FOCUS_RING}>Remove from list</button>
          </div>
        )}
        {renaming?.id === ws.id && (
          <form onSubmit={(e) => { e.preventDefault(); void submitRename(); }} className="px-3 py-2 border-t border-zinc-900 flex items-center gap-2">
            <input autoFocus value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: null })} aria-label="Workspace name" className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1.5 text-[12px] text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#465EDB]/60" />
            <button type="submit" className={'px-2 py-1.5 rounded-md bg-[#465EDB] text-white text-[12px] font-medium hover:bg-[#5A73E6] ' + FOCUS_RING}>Save</button>
            <button type="button" onClick={() => setRenaming(null)} className={'px-2 py-1.5 rounded-md text-[12px] text-zinc-400 hover:text-zinc-100 ' + FOCUS_RING}>Cancel</button>
          </form>
        )}
        {renaming?.id === ws.id && renaming.error && <p role="alert" className="px-3 pb-2 text-[11px] text-rose-300">{renaming.error}</p>}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-[#060608] font-sans overflow-y-auto" id="workspace-portal">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <div className="min-h-full flex items-start sm:items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-[1000px] rounded-lg border border-zinc-900 bg-[#101012] my-auto">
          <div className="px-5 sm:px-7 pt-6 pb-5 border-b border-zinc-900 flex items-start justify-between gap-4">
            <Wordmark />
            <p className="hidden md:block text-[12px] text-zinc-500 max-w-[38ch] leading-relaxed text-right">Workspaces are stored locally. Memory is optional.</p>
          </div>
          <div className={empty ? 'px-5 sm:px-7 py-6 flex justify-center' : 'grid gap-0 md:grid-cols-[1.15fr_0.85fr]'}>
            <section aria-label="Your workspaces" className={empty ? 'hidden' : 'px-5 sm:px-7 py-6 md:border-r border-zinc-900 min-w-0'}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">Your workspaces</h2>
                <span className="tnum text-[11px] text-zinc-600">{visible.length}{query ? ' of ' + (workspaces as Workspace[]).length : ''}</span>
              </div>
              {showFilter && (
                <div className="relative mt-3">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" aria-hidden="true" />
                  <input ref={filterRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter workspaces" aria-label="Filter workspaces" className={INPUT + ' pl-8 font-sans'} />
                </div>
              )}
              <div ref={listRef} role="listbox" aria-label="Workspaces" tabIndex={0} onKeyDown={onListKey} className={'mt-3 rounded-md border border-zinc-900 overflow-y-auto max-h-[380px] ' + FOCUS_RING}>
                {visible.length === 0 && (
                  <p className="px-3 py-8 text-[12px] text-zinc-500 leading-relaxed">{query ? 'No workspaces match this filter.' : 'No workspaces yet. Create one to get started.'}</p>
                )}
                {visible.map((ws, i) => renderRow(ws, i))}
              </div>
              {notice && <p role="status" className="mt-3 text-[12px] text-zinc-400">{notice}</p>}
            </section>
            <section aria-label="New workspace" className={empty ? 'w-full max-w-[520px]' : 'px-5 sm:px-7 py-6 min-w-0'}>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">New workspace</h2>
              <div className="mt-4 space-y-1.5">
                <label htmlFor="portal-ws-name" className="block text-[13px] font-medium text-zinc-300">Workspace name</label>
                <input id="portal-ws-name" ref={nameInputRef} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="e.g. Swarm Research Core" autoComplete="off" aria-describedby="portal-ws-name-hint" aria-invalid={showNameError} className={INPUT} />
                <p id="portal-ws-name-hint" className="text-[11px] text-zinc-600">Stored locally as a folder with this name.</p>
                {showNameError && <p role="alert" className="text-[11px] text-rose-300">{workspaceNameError((validateWorkspaceName(workspaceName, existingNames) as { ok: false; reason: 'empty' | 'too-short' | 'too-long' | 'duplicate' | 'invalid-chars' }).reason)}</p>}
              </div>
              <fieldset className="mt-5">
                <legend className="text-[13px] font-medium text-zinc-300">Workspace mark</legend>
                <div className="grid grid-cols-4 gap-2 mt-2" role="radiogroup" aria-label="Workspace mark">
                  {PORTAL_ICON_IDS.map((id) => {
                    const selected = selectedIcon === id;
                    const tone = markToneFor(id);
                    return (
                      <button key={id} type="button" role="radio" aria-checked={selected} aria-label={'Mark ' + tone.label} title={tone.label} onClick={() => setSelectedIcon(id)} className={'h-12 rounded-md border flex items-center justify-center transition-colors duration-150 cursor-pointer ' + FOCUS_RING + (selected ? ' border-[#465EDB] bg-zinc-900' : ' border-zinc-800 bg-zinc-900/40 hover:border-zinc-700')}>
                        <WorkspaceMark variant={id} size={28} selected={selected} label={'Mark ' + tone.label} />
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="mt-5 rounded-md border border-zinc-900">

                <button type="button" aria-expanded={dbOpen} aria-controls="portal-db-panel" onClick={() => setDbOpen((v) => !v)} className={'w-full flex items-center gap-2 px-3 py-2.5 text-left text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors duration-150 ' + FOCUS_RING}>
                  <ChevronDown size={13} className={'shrink-0 transition-transform duration-150 ' + (dbOpen ? '' : '-rotate-90')} aria-hidden="true" />
                  <span>Semantic memory <span className="text-zinc-600">Optional</span></span>
                  {dbVerified && <CheckCircle2 size={13} className="text-emerald-400 ml-auto shrink-0" aria-label="Database verified" />}
                  {dbStatus === 'failed' && <XCircle size={13} className="text-rose-400 ml-auto shrink-0" aria-label="Database failed" />}
                </button>
                {dbOpen && (
                  <div id="portal-db-panel" className="px-3 pb-3 pt-1 space-y-2 border-t border-zinc-900">
                    <p className="text-[11px] text-zinc-600 leading-relaxed">Connect PostgreSQL for semantic memory and RAG. Workspaces work without it.</p>
                    <label htmlFor="portal-db-url" className="sr-only">PostgreSQL connection URL</label>
                    <div className="relative">
                      <input id="portal-db-url" type={dbMasked ? 'password' : 'text'} value={dbUrl} onChange={(e) => { setDbUrl(e.target.value); setDbStatus('idle'); setDbMessage(null); }} placeholder="postgresql://user:password@host:5432/dbname" spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" inputMode="url" className={INPUT + ' font-mono pr-10'} />
                      <button type="button" onClick={() => setDbMasked((v) => !v)} aria-label={dbMasked ? 'Show database URL' : 'Hide database URL'} className={'absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-zinc-500 hover:text-zinc-200 ' + FOCUS_RING}>
                        {dbMasked ? <Eye size={13} /> : <EyeOff size={13} />}
                      </button>
                    </div>
                    {dbShapeInvalid && <p role="alert" className="text-[11px] text-amber-300">Use a postgresql:// URL.</p>}

                    <div className="flex items-center gap-2 min-h-[32px]">
                      <button type="button" onClick={() => void runDbTest()} disabled={!trimmedDb || dbShapeInvalid || dbStatus === 'testing'} className={'h-8 px-3 rounded-md border text-[12px] font-medium transition-colors duration-150 ' + FOCUS_RING + ((!trimmedDb || dbShapeInvalid || dbStatus === 'testing') ? ' border-zinc-800 text-zinc-600 cursor-not-allowed' : ' border-zinc-700 text-zinc-200 hover:bg-zinc-900')}>
                        {dbStatus === 'testing' ? 'Testing' : 'Test connection'}
                      </button>
                      <span role="status" className="text-[11px] text-zinc-500 truncate">
                        {dbStatus === 'testing' && 'Testing connection.'}
                        {dbStatus === 'connected' && (dbMessage ?? 'Connected.')}
                        {dbStatus === 'failed' && (dbMessage ?? 'Connection failed.')}
                      </span>
                      {dbStatus === 'testing' && <Loader2 size={12} className="animate-spin text-zinc-500 shrink-0" aria-hidden="true" />}
                    </div>
                    {dbStatus === 'failed' && <p className="text-[11px] text-zinc-500">Connection failed. You can still create this workspace locally.</p>}

                  </div>
                )}
              </div>
              {dbVerified && <p role="status" className="mt-3 text-[12px] text-zinc-400">Memory will be enabled for this workspace.</p>}
              {createNote && <p role={createNote.includes('created locally') ? 'status' : 'alert'} className="mt-3 text-[12px] text-zinc-400">{createNote}</p>}
              {workspaceError && <p role="alert" className="mt-3 text-[12px] text-rose-300">{String(workspaceError)}</p>}
              <button type="button" onClick={() => void handleCreate()} disabled={!canCreate} data-testid="portal-create" className={'mt-4 w-full min-h-[44px] rounded-md text-sm font-medium flex items-center justify-center gap-2 transition-colors duration-150 ' + FOCUS_RING + (canCreate ? ' bg-[#465EDB] text-white hover:bg-[#5A73E6]' : ' bg-zinc-900 border border-zinc-800 text-zinc-500 cursor-not-allowed')}>
                {(isLaunching || isCreatingWorkspace) && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {(isLaunching || isCreatingWorkspace) ? 'Creating workspace' : 'Create workspace'}
              </button>
              <p className="mt-3 text-[11px] text-zinc-600">Workspaces are stored locally. Memory is optional.</p>
            </section>
          </div>
          <div className="px-5 sm:px-7 py-3 border-t border-zinc-900 flex items-center justify-between gap-3">
            <p className="text-[11px] text-zinc-600">Local-first. No database required.</p>
            <p className="tnum text-[11px] text-zinc-600">{openingId ? 'Opening workspace.' : (isLaunching || isCreatingWorkspace) ? 'Creating workspace.' : ''}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

