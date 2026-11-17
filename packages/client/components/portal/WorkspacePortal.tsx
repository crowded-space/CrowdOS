import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient, isPostgresUrl } from '@/src/api/client';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import type { Workspace } from '@/types/crowdOs';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  XCircle,
} from 'lucide-react';
import ThemeToggle from '@/components/ui/ThemeToggle';
import { CrowdOSLockup, CrowSigil } from '@/components/ui/CrowSigil';
import WorkspaceMark, { markToneFor } from './WorkspaceMark';
import {
  PORTAL_ICON_IDS,
  filterWorkspaces,
  hideWorkspace,
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

const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#465EDB]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent';
const INPUT =
  'w-full bg-zinc-950 border border-zinc-800 hover:border-zinc-700 focus:border-[#465EDB] focus:ring-2 focus:ring-[#465EDB]/20 rounded-md px-3 py-2.5 min-h-[44px] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none transition-colors duration-150';

function StorageStatus({ configured }: { configured: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 shrink-0 whitespace-nowrap"
      title={configured ? 'PostgreSQL semantic memory connected' : 'Local-first storage only'}
    >
      {configured ? (
        <Database size={11} className="text-emerald-400 shrink-0" aria-hidden="true" />
      ) : (
        <FolderOpen size={11} className="text-zinc-500 shrink-0" aria-hidden="true" />
      )}
      <span>{configured ? 'Semantic memory' : 'Local'}</span>
    </span>
  );
}

export default function WorkspacePortal() {
  const {
    createWorkspace,
    workspaces,
    enterWorkspace,
    fetchWorkspaces,
    updateWorkspace,
    isCreatingWorkspace,
    workspaceError,
  } = useCrowdOSStore() as any;

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
  const nameInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // Close row options menu on outside click or Escape
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-portal-row-menu]')) return;
      setMenuFor(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuFor]);

  const existingNames = useMemo(() => (workspaces as Workspace[]).map((w) => w.name), [workspaces]);
  const nameCheck = validateWorkspaceName(workspaceName, existingNames);
  const showNameError = workspaceName.trim().length > 0 && nameCheck.ok === false;
  const nameErrorText = nameCheck.ok === false ? workspaceNameError(nameCheck.reason) : '';

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

  const allUnarchived = useMemo(
    () => (workspaces as Workspace[]).filter((w) => !hidden.includes(w.id)),
    [workspaces, hidden],
  );

  const visible = useMemo(() => {
    return sortWorkspacesByRecency(filterWorkspaces(allUnarchived, query), lastOpened);
  }, [allUnarchived, query, lastOpened]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, visible.length]);

  const showFilter = allUnarchived.length > 3 || query.trim().length > 0;

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
    const check = validateWorkspaceName(
      renaming.value,
      existingNames.filter((n) => {
        const current = (workspaces as Workspace[]).find((w) => w.id === renaming.id);
        return n !== current?.name;
      }),
    );
    if (check.ok === false) {
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
      setNotice('Workspace ID copied to clipboard.');
    } catch {
      setNotice('Workspace ID: ' + ws.id);
    }
    setMenuFor(null);
  };

  const removeFromList = (id: string) => {
    setHidden(hideWorkspace(id));
    setMenuFor(null);
    setNotice('Removed from list. Workspace files remain on disk.');
  };

  const canCreate = nameCheck.ok && !isLaunching && !isCreatingWorkspace && !openingId;
  const totalCount = allUnarchived.length;

  const renderRow = (ws: Workspace, index: number) => {
    const opened = lastOpened[ws.id];
    const active = index === activeIndex;
    const opening = openingId === ws.id;
    const configured = Boolean(ws.database?.configured);

    return (
      <div key={ws.id} className="relative group border-b border-zinc-900/90 last:border-b-0" data-portal-row-menu>
        <button
          type="button"
          role="option"
          aria-selected={active}
          data-testid={'workspace-row-' + ws.id}
          onClick={() => void openWorkspace(ws.id)}
          onMouseEnter={() => setActiveIndex(index)}
          className={
            'w-full flex items-center gap-3.5 pl-4 pr-12 py-3.5 min-h-[64px] text-left transition-colors duration-150 cursor-pointer ' +
            FOCUS_RING +
            (active ? ' bg-zinc-900/75' : ' hover:bg-zinc-900/45 active:bg-zinc-900/80')
          }
        >
          <WorkspaceMark variant={ws.icon || 'crow-white-rounded'} size={36} />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2 min-w-0">
              <span className="text-[14px] font-semibold text-zinc-100 truncate tracking-[-0.01em]">{ws.name}</span>
            </span>
            <span className="flex items-center gap-2 mt-1 min-w-0 text-[11.5px] text-zinc-500">
              <StorageStatus configured={configured} />
              <span aria-hidden="true" className="text-zinc-700">·</span>
              <span className="tnum shrink-0 whitespace-nowrap">{relativeTime(opened ?? ws.updatedAt ?? ws.createdAt)}</span>
              <span aria-hidden="true" className="text-zinc-700 hidden sm:inline">·</span>
              <span className="font-mono text-[11px] text-zinc-600 truncate hidden sm:inline" title={'Workspace ' + ws.id}>
                {truncateMiddle(ws.id.slice(0, 12), 20)}
              </span>
            </span>
          </span>
          <span className="shrink-0 flex items-center gap-1.5 text-[12px] font-medium text-zinc-400">
            {opening ? (
              <Loader2 size={14} className="animate-spin text-[#465EDB]" aria-label="Opening workspace" />
            ) : (
              <span
                className={
                  'inline-flex items-center gap-1 whitespace-nowrap transition-opacity duration-150 ' +
                  (active ? 'opacity-100 text-zinc-200' : 'opacity-0 group-hover:opacity-100')
                }
              >
                <span>Open</span>
                <ArrowRight size={12} aria-hidden="true" />
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          aria-label={'Options for ' + ws.name}
          aria-expanded={menuFor === ws.id}
          onClick={(e) => {
            e.stopPropagation();
            setMenuFor(menuFor === ws.id ? null : ws.id);
          }}
          className={
            'absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800/80 transition-colors cursor-pointer ' +
            FOCUS_RING
          }
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>

        {menuFor === ws.id && (
          <div
            role="menu"
            aria-label={'Options for ' + ws.name}
            className="absolute right-2.5 top-[calc(100%-4px)] z-30 w-48 rounded-lg border border-zinc-800 bg-[#141418] p-1 shadow-xl"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setRenaming({ id: ws.id, value: ws.name, error: null });
                setMenuFor(null);
              }}
              className={'w-full text-left px-2.5 py-2 rounded-md text-[12px] text-zinc-200 hover:bg-zinc-800 cursor-pointer ' + FOCUS_RING}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void revealPath(ws)}
              className={'w-full text-left px-2.5 py-2 rounded-md text-[12px] text-zinc-200 hover:bg-zinc-800 cursor-pointer ' + FOCUS_RING}
            >
              Copy workspace ID
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => removeFromList(ws.id)}
              className={'w-full text-left px-2.5 py-2 rounded-md text-[12px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer ' + FOCUS_RING}
            >
              Remove from list
            </button>
          </div>
        )}

        {renaming?.id === ws.id && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitRename();
            }}
            className="px-4 py-2.5 border-t border-zinc-900 bg-zinc-950/60 flex items-center gap-2"
          >
            <input
              autoFocus
              value={renaming.value}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: null })}
              aria-label="Workspace name"
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-md px-2.5 py-1.5 text-[12.5px] text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#465EDB]/60"
            />
            <button
              type="submit"
              className={'px-3 py-1.5 rounded-md bg-[#465EDB] text-white text-[12px] font-medium hover:bg-[#5A73E6] whitespace-nowrap cursor-pointer ' + FOCUS_RING}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setRenaming(null)}
              className={'px-2.5 py-1.5 rounded-md text-[12px] text-zinc-400 hover:text-zinc-100 whitespace-nowrap cursor-pointer ' + FOCUS_RING}
            >
              Cancel
            </button>
          </form>
        )}
        {renaming?.id === ws.id && renaming.error && (
          <p role="alert" className="px-4 pb-2.5 text-[11px] text-rose-400">
            {renaming.error}
          </p>
        )}
      </div>
    );
  };

  return (
    <div
      id="workspace-portal"
      className="fixed inset-0 bg-[#070709] text-zinc-100 font-sans overflow-y-auto flex flex-col"
    >
      {/* Top Bar — clean single-row harness header */}
      <header className="w-full border-b border-zinc-900 bg-[#070709]/95 shrink-0">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 h-16 flex items-center justify-between gap-6">
          <CrowdOSLockup layout="horizontal" size="sm" tone="auto" />
          <div className="flex items-center gap-4 shrink-0">
            <span className="hidden sm:inline text-[12px] text-zinc-500 whitespace-nowrap">
              Local-first agent harness
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Split Command Hub */}
      <main className="flex-1 w-full max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 py-6 sm:py-8 lg:py-10 flex flex-col justify-center">
        <div className="grid grid-cols-1 lg:grid-cols-[1.28fr_0.92fr] gap-6 lg:gap-10 items-start">
          {/* Left Column: Workspace Command Directory */}
          <section aria-label="Your workspaces" className="min-w-0 flex flex-col">
            <div className="flex items-end justify-between gap-4 pb-3 border-b border-zinc-900">
              <div>
                <h1 className="text-[22px] sm:text-[26px] font-semibold tracking-tight text-zinc-100 leading-tight">
                  Workspaces
                </h1>
                <p className="mt-1 text-[13px] text-zinc-500">
                  Select an isolated workspace to launch channels, agents, and local mounts.
                </p>
              </div>
              <div className="text-right shrink-0">
                <span className="tnum font-mono text-[12px] text-zinc-400 whitespace-nowrap">
                  {query ? `${visible.length} / ${totalCount}` : `${totalCount} total`}
                </span>
              </div>
            </div>

            {showFilter && (
              <div className="relative mt-4">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                  aria-hidden="true"
                />
                <input
                  ref={filterRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter workspaces by name…"
                  aria-label="Filter workspaces"
                  className={INPUT + ' pl-9'}
                />
              </div>
            )}

            <div className="mt-4 rounded-lg border border-zinc-900 bg-[#101013] overflow-hidden">
              {visible.length > 0 ? (
                <div
                  ref={listRef}
                  role="listbox"
                  aria-label="Workspaces"
                  tabIndex={0}
                  onKeyDown={onListKey}
                  className={'max-h-[460px] overflow-y-auto ' + FOCUS_RING}
                >
                  {visible.map((ws, i) => renderRow(ws, i))}
                </div>
              ) : (
                <div role="status" className="px-6 py-14 text-center flex flex-col items-center">
                  <div className="w-12 h-12 rounded-xl border border-zinc-800 bg-zinc-950 flex items-center justify-center mb-4">
                    <CrowSigil size={28} tone="auto" detail="full" />
                  </div>
                  <p className="text-[14px] font-medium text-zinc-200">
                    {query ? 'No workspaces match that filter' : 'No workspaces on this machine yet'}
                  </p>
                  <p className="mt-1.5 text-[12.5px] text-zinc-500 max-w-[38ch] leading-relaxed">
                    {query
                      ? 'Clear the filter or initialize a new workspace in the panel beside this list.'
                      : 'Name a workspace in the adjacent panel to provision local channels, agent hierarchy, and storage.'}
                  </p>
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className={'mt-4 px-3 py-1.5 rounded-md border border-zinc-800 text-[12px] text-zinc-300 hover:bg-zinc-900 cursor-pointer ' + FOCUS_RING}
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              )}
            </div>

            {notice && (
              <p role="status" className="mt-3 text-[12px] text-zinc-400">
                {notice}
              </p>
            )}
          </section>

          {/* Right Column: Provision New Workspace */}
          <section
            aria-label="New workspace"
            className="min-w-0 rounded-lg border border-zinc-900 bg-[#101013] p-5 sm:p-6"
          >
            <div className="flex items-center justify-between gap-3 pb-4 border-b border-zinc-900">
              <div>
                <h2 className="text-[15px] font-semibold text-zinc-100 tracking-tight">New workspace</h2>
                <p className="mt-0.5 text-[12px] text-zinc-500">
                  Isolated roster, channels, skills, and history.
                </p>
              </div>
              <Plus size={16} className="text-zinc-500 shrink-0" aria-hidden="true" />
            </div>

            <div className="mt-5 space-y-1.5">
              <label htmlFor="portal-ws-name" className="block text-[13px] font-medium text-zinc-200">
                Workspace name
              </label>
              <input
                id="portal-ws-name"
                ref={nameInputRef}
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder="e.g. Swarm Research Core"
                autoComplete="off"
                aria-describedby="portal-ws-name-hint"
                aria-invalid={showNameError}
                className={INPUT}
              />
              <p id="portal-ws-name-hint" className="text-[11.5px] text-zinc-500">
                Stored locally as a folder with this name.
              </p>
              {showNameError && (
                <p role="alert" className="text-[11.5px] text-rose-400">
                  {nameErrorText}
                </p>
              )}
            </div>

            <fieldset className="mt-5">
              <legend className="text-[13px] font-medium text-zinc-200">Workspace mark</legend>
              <div className="grid grid-cols-4 gap-2 mt-2" role="radiogroup" aria-label="Workspace mark">
                {PORTAL_ICON_IDS.map((id) => {
                  const selected = selectedIcon === id;
                  const tone = markToneFor(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={'Mark ' + tone.label}
                      title={tone.label}
                      onClick={() => setSelectedIcon(id)}
                      className={
                        'h-12 rounded-md border flex items-center justify-center transition-colors duration-150 cursor-pointer ' +
                        FOCUS_RING +
                        (selected
                          ? ' border-[#465EDB] bg-zinc-900/90'
                          : ' border-zinc-800/90 bg-zinc-950/60 hover:border-zinc-700')
                      }
                    >
                      <WorkspaceMark variant={id} size={28} selected={selected} label={'Mark ' + tone.label} />
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Optional PostgreSQL Semantic Memory */}
            <div className="mt-5 rounded-md border border-zinc-900 bg-zinc-950/50">
              <button
                type="button"
                aria-expanded={dbOpen}
                aria-controls="portal-db-panel"
                onClick={() => setDbOpen((v) => !v)}
                className={
                  'w-full flex items-center gap-2 px-3.5 py-2.5 min-h-[42px] text-left text-[12.5px] text-zinc-300 hover:text-zinc-100 transition-colors duration-150 cursor-pointer ' +
                  FOCUS_RING
                }
              >
                <ChevronDown
                  size={14}
                  className={'shrink-0 text-zinc-500 transition-transform duration-150 ' + (dbOpen ? '' : '-rotate-90')}
                  aria-hidden="true"
                />
                <span className="font-medium">Semantic memory</span>
                <span className="text-zinc-500 text-[11.5px]">Optional</span>
                {dbVerified && (
                  <CheckCircle2 size={14} className="text-emerald-400 ml-auto shrink-0" aria-label="Database verified" />
                )}
                {dbStatus === 'failed' && (
                  <XCircle size={14} className="text-rose-400 ml-auto shrink-0" aria-label="Database failed" />
                )}
              </button>

              {dbOpen && (
                <div id="portal-db-panel" className="px-3.5 pb-3.5 pt-2 space-y-2.5 border-t border-zinc-900">
                  <p className="text-[11.5px] text-zinc-500 leading-relaxed">
                    Connect PostgreSQL with pgvector for semantic memory and RAG. Workspaces work without it.
                  </p>
                  <label htmlFor="portal-db-url" className="sr-only">
                    PostgreSQL connection URL
                  </label>
                  <div className="relative">
                    <input
                      id="portal-db-url"
                      type={dbMasked ? 'password' : 'text'}
                      value={dbUrl}
                      onChange={(e) => {
                        setDbUrl(e.target.value);
                        setDbStatus('idle');
                        setDbMessage(null);
                      }}
                      placeholder="postgresql://user:password@host:5432/dbname"
                      spellCheck={false}
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      inputMode="url"
                      className={INPUT + ' font-mono text-[12px] pr-10'}
                    />
                    <button
                      type="button"
                      onClick={() => setDbMasked((v) => !v)}
                      aria-label={dbMasked ? 'Show database URL' : 'Hide database URL'}
                      className={
                        'absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-zinc-500 hover:text-zinc-200 cursor-pointer ' +
                        FOCUS_RING
                      }
                    >
                      {dbMasked ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </div>
                  {dbShapeInvalid && (
                    <p role="alert" className="text-[11.5px] text-amber-300">
                      Use a postgresql:// URL.
                    </p>
                  )}

                  <div className="flex items-center gap-2.5 min-h-[36px]">
                    <button
                      type="button"
                      onClick={() => void runDbTest()}
                      disabled={!trimmedDb || dbShapeInvalid || dbStatus === 'testing'}
                      className={
                        'h-9 px-3.5 rounded-md border text-[12px] font-medium whitespace-nowrap shrink-0 transition-colors duration-150 ' +
                        FOCUS_RING +
                        (!trimmedDb || dbShapeInvalid || dbStatus === 'testing'
                          ? ' border-zinc-800 text-zinc-600 cursor-not-allowed'
                          : ' border-zinc-700 text-zinc-200 hover:bg-zinc-900 cursor-pointer')
                      }
                    >
                      {dbStatus === 'testing' ? 'Testing' : 'Test connection'}
                    </button>
                    <span role="status" className="text-[11.5px] text-zinc-400 truncate">
                      {dbStatus === 'testing' && 'Testing connection.'}
                      {dbStatus === 'connected' && (dbMessage ?? 'Connected.')}
                      {dbStatus === 'failed' && (dbMessage ?? 'Connection failed.')}
                    </span>
                    {dbStatus === 'testing' && (
                      <Loader2 size={13} className="animate-spin text-zinc-400 shrink-0" aria-hidden="true" />
                    )}
                  </div>
                  {dbStatus === 'failed' && (
                    <p className="text-[11.5px] text-zinc-400">
                      Connection failed. You can still create this workspace locally.
                    </p>
                  )}
                </div>
              )}
            </div>

            {dbVerified && (
              <p role="status" className="mt-3 text-[12px] text-zinc-300">
                Memory will be enabled for this workspace.
              </p>
            )}
            {createNote && (
              <p
                role={createNote.includes('created locally') ? 'status' : 'alert'}
                className="mt-3 text-[12px] text-zinc-300"
              >
                {createNote}
              </p>
            )}
            {workspaceError && (
              <p role="alert" className="mt-3 text-[12px] text-rose-400">
                {String(workspaceError)}
              </p>
            )}

            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!canCreate}
              data-testid="portal-create"
              className={
                'mt-5 w-full min-h-[44px] px-4 rounded-md text-sm font-medium flex items-center justify-center gap-2 whitespace-nowrap transition-colors duration-150 ' +
                FOCUS_RING +
                (canCreate
                  ? ' bg-[#465EDB] text-white hover:bg-[#5A73E6] cursor-pointer'
                  : ' bg-zinc-900 border border-zinc-800 text-zinc-500 cursor-not-allowed')
              }
            >
              {(isLaunching || isCreatingWorkspace) && (
                <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />
              )}
              <span>{isLaunching || isCreatingWorkspace ? 'Creating workspace…' : 'Create workspace'}</span>
            </button>
          </section>
        </div>
      </main>

      {/* Quiet Footer */}
      <footer className="w-full border-t border-zinc-900 shrink-0">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 py-3.5 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-zinc-500">
          <span>Local-first persistence. No database required.</span>
          <div className="flex items-center gap-4">
            <span className="hidden md:inline font-mono text-[11px] text-zinc-600">
              ⌘N new · / filter · ↑↓ select · Enter open
            </span>
            <span className="tnum text-[11.5px] text-zinc-400">
              {openingId ? 'Opening workspace…' : isLaunching || isCreatingWorkspace ? 'Creating workspace…' : ''}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
