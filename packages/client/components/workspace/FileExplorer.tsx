import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Folder, FolderOpen, File, FileText, Image as ImageIcon, ChevronRight,
  ChevronDown, FileCode2, Package, RefreshCw, X, AlertTriangle, Loader2,
  HardDrive, Database,
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import { useToast } from '@/components/ui/ToastProvider';
import { apiClient, apiErrorStatus } from '@/src/api/client';
import type { MountRootDto } from '@/src/api/client';
import FolderMountPicker from './FolderMountPicker';
import { canPickDirectoryNative, pickDirectoryNative } from './desktop-bridge';
import {
  describeFetchFailure,
  emptyTreeMessage,
  flattenTree,
  hasL0Agent,
  mountWarning,
  sourceHint,
  sourceLabel,
  toRepoEntries,
  type mountScopeView,
  type repoEntry,
  type scopeFailure,
  type treeRow,
} from './explorer-model';

// VS Code-ish row metrics: a tight 22px line, a 16px disclosure gutter, and a
// 12px indent step. The tree reads as a file list rather than a stack of cards,
// which is what makes a deep tree scannable.
const ROW_HEIGHT = 22;
const INDENT = 12;
const CHEVRON_GUTTER = 16;

/** Icon per extension — muted, so the tree stays legible rather than colourful. */
function entryIcon(entry: repoEntry, isOpen: boolean) {
  const { ext, kind } = entry;
  if (kind === 'directory') {
    return isOpen
      ? <FolderOpen size={14} className="text-zinc-400 shrink-0" />
      : <Folder size={14} className="text-zinc-400 shrink-0" />;
  }
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return <FileCode2 size={14} className="text-blue-400/80 shrink-0" />;
    case 'json':
      return <Package size={14} className="text-yellow-500/70 shrink-0" />;
    case 'css':
      return <FileCode2 size={14} className="text-pink-400/80 shrink-0" />;
    case 'svg':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'ico':
    case 'webp':
      return <ImageIcon size={14} className="text-purple-400/80 shrink-0" />;
    case 'md':
      return <FileText size={14} className="text-zinc-500 shrink-0" />;
    default:
      return <File size={14} className="text-zinc-500 shrink-0" />;
  }
}

/** A flat, full-width selection — VS Code's active row, not a rounded pill. */
function rowClasses(selected: boolean): string {
  return [
    'group flex w-full items-center gap-1.5 pr-2 text-left cursor-pointer select-none',
    'focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-indigo-400/60',
    selected ? 'bg-indigo-500/20 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200',
  ].join(' ');
}

/** Muted, non-blocking notice used for both fetch failures and mount warnings. */
function NoticePanel({ failure, onRetry }: { failure: scopeFailure; onRetry?: () => void }) {
  return (
    <div className="m-2 rounded border border-amber-500/25 bg-amber-500/5 px-2.5 py-2">
      <div className="flex items-start gap-1.5">
        <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-amber-200">{failure.headline}</div>
          <div className="text-[11px] text-zinc-400 break-words mt-0.5">{failure.detail}</div>
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1.5 text-[11px] text-amber-300 hover:text-amber-200 cursor-pointer"
        >
          Try again
        </button>
      )}
    </div>
  );
}

interface TreeRowProps {
  row: treeRow;
  selected: boolean;
  loading: boolean;
  /** null while the directory has never been opened. */
  childCount: number | null;
  onActivate: (entry: repoEntry) => void;
  onToggle: (entry: repoEntry) => void;
  registerRef: (path: string, element: HTMLButtonElement | null) => void;
  onKeyDown: (event: React.KeyboardEvent, row: treeRow) => void;
}

const TreeRow: React.FC<TreeRowProps> = ({
  row, selected, loading, childCount, onActivate, onToggle, registerRef, onKeyDown,
}) => {
  const { entry, level, posInSet, setSize, expanded } = row;
  const isDirectory = entry.kind === 'directory';
  const showEmptyHint = isDirectory && expanded && !loading && childCount === 0;

  return (
    <button
      ref={(element) => registerRef(entry.path, element)}
      type="button"
      role="treeitem"
      aria-level={level}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={isDirectory ? undefined : selected}
      aria-expanded={isDirectory ? expanded : undefined}
      tabIndex={-1}
      onClick={() => (isDirectory ? onToggle(entry) : onActivate(entry))}
      onKeyDown={(event) => onKeyDown(event, row)}
      title={entry.path}
      style={{ height: ROW_HEIGHT, paddingLeft: 4 + (level - 1) * INDENT }}
      className={rowClasses(selected)}
    >
      <span className="flex items-center justify-center shrink-0" style={{ width: CHEVRON_GUTTER }}>
        {loading ? (
          <Loader2 size={11} className="animate-spin text-zinc-500" />
        ) : isDirectory ? (
          expanded
            ? <ChevronDown size={13} className="text-zinc-500" />
            : <ChevronRight size={13} className="text-zinc-500" />
        ) : null}
      </span>
      {entryIcon(entry, expanded)}
      <span className="truncate text-[12.5px] leading-none">{entry.name}</span>
      {showEmptyHint && (
        <span className="ml-auto pl-2 text-[10.5px] text-zinc-600 shrink-0">empty</span>
      )}
    </button>
  );
};

/**
 * One root's worth of tree state: the root listing, lazily loaded children, and
 * the keyboard-navigable flattening of the two. Both roots use it — the mounted
 * repository and the workspace sandbox are the same shape, only their labels and
 * reachability differ.
 */
function useDirectoryTree(
  root: MountRootDto,
  activeWorkspaceId: string | null,
  activeChannelId: string | null,
  enabled: boolean,
  revision: number,
) {
  const [entries, setEntries] = useState<repoEntry[]>([]);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, repoEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [failure, setFailure] = useState<scopeFailure | null>(null);
  const [scope, setScope] = useState<mountScopeView | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setFailure(null);
    try {
      // One request answers both "which folder" and "what is in it": the root
      // listing carries the whole scope, so the header and the tree can never
      // disagree about which directory is on screen.
      const data = await apiClient.getWorkspaceRoot(activeWorkspaceId || 'default', activeChannelId, root);
      setScope(data);
      setEntries(toRepoEntries(data.nodes));
      setChildrenByPath({});
      setExpanded(new Set());
    } catch (error: any) {
      setScope(null);
      setEntries([]);
      setChildrenByPath({});
      setExpanded(new Set());
      setFailure(describeFetchFailure(apiErrorStatus(error), error?.message ?? null, null));
    } finally {
      setIsLoading(false);
    }
  }, [activeWorkspaceId, activeChannelId, root]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload, revision]);

  const toggle = useCallback(
    (entry: repoEntry) => {
      const isOpen = expanded.has(entry.path);
      if (isOpen) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(entry.path);
          return next;
        });
        return;
      }
      setExpanded((prev) => new Set(prev).add(entry.path));
      // First open only: later toggles reuse the cached children, and Refresh
      // is the explicit way to re-read a directory.
      if (childrenByPath[entry.path] !== undefined) return;
      setLoadingPaths((prev) => new Set(prev).add(entry.path));
      void apiClient
        .getWorkspaceDirectory(entry.path, activeWorkspaceId || 'default', activeChannelId, root)
        .then((nodes) => setChildrenByPath((prev) => ({ ...prev, [entry.path]: toRepoEntries(nodes) })))
        .catch((error: any) => {
          // A directory that vanishes between listing and expanding is common
          // enough (build output, git operations) to report inline, not as a toast.
          setChildrenByPath((prev) => ({ ...prev, [entry.path]: [] }));
          setFailure(describeFetchFailure(apiErrorStatus(error), error?.message ?? null, entry.path));
        })
        .finally(() =>
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(entry.path);
            return next;
          }),
        );
    },
    [expanded, childrenByPath, activeWorkspaceId, activeChannelId, root],
  );

  const rows = useMemo(
    () => flattenTree(entries, childrenByPath, expanded),
    [entries, childrenByPath, expanded],
  );

  return { scope, rows, childrenByPath, expanded, loadingPaths, isLoading, failure, reload, toggle };
}

interface TreeViewProps {
  rows: treeRow[];
  childrenByPath: Record<string, repoEntry[] | undefined>;
  loadingPaths: ReadonlySet<string>;
  /** Path of the open file, or null when this root is read-only. */
  selectedPath: string | null;
  onActivate: (entry: repoEntry) => void;
  onToggle: (entry: repoEntry) => void;
  ariaLabel: string;
}

const TreeView: React.FC<TreeViewProps> = ({
  rows, childrenByPath, loadingPaths, selectedPath, onActivate, onToggle, ariaLabel,
}) => {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const registerRef = useCallback((path: string, element: HTMLButtonElement | null) => {
    if (element) rowRefs.current.set(path, element);
    else rowRefs.current.delete(path);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, row: treeRow) => {
      const index = rows.findIndex((candidate) => candidate.entry.path === row.entry.path);
      if (index < 0) return;
      const isDirectory = row.entry.kind === 'directory';
      const focusRow = (target: treeRow | undefined) => {
        if (!target) return;
        event.preventDefault();
        rowRefs.current.get(target.entry.path)?.focus();
      };

      switch (event.key) {
        case 'ArrowDown':
          return focusRow(rows[index + 1]);
        case 'ArrowUp':
          return focusRow(rows[index - 1]);
        case 'ArrowRight':
          if (!isDirectory) return;
          if (!row.expanded) {
            event.preventDefault();
            onToggle(row.entry);
          } else {
            focusRow(rows[index + 1]);
          }
          return;
        case 'ArrowLeft':
          if (isDirectory && row.expanded) {
            event.preventDefault();
            onToggle(row.entry);
            return;
          }
          // Collapsed (or a file): jump to the parent row.
          for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const candidate = rows[cursor];
            if (candidate.level < row.level && candidate.entry.kind === 'directory') {
              return focusRow(candidate);
            }
          }
          return;
        case 'Enter':
        case ' ':
          event.preventDefault();
          return isDirectory ? onToggle(row.entry) : onActivate(row.entry);
        case 'Home':
          return focusRow(rows[0]);
        case 'End':
          return focusRow(rows[rows.length - 1]);
        default:
          return;
      }
    },
    [rows, onToggle, onActivate],
  );

  return (
    <div role="tree" aria-label={ariaLabel}>
      {rows.map((row) => (
        <TreeRow
          key={row.entry.path}
          row={row}
          selected={selectedPath !== null && selectedPath === row.entry.path}
          loading={loadingPaths.has(row.entry.path)}
          childCount={childrenByPath[row.entry.path]?.length ?? null}
          onActivate={onActivate}
          onToggle={onToggle}
          registerRef={registerRef}
          onKeyDown={handleKeyDown}
        />
      ))}
    </div>
  );
};

export default function FileExplorer() {
  const {
    activeWorkspaceId, activeChannelId, agents,
    selectedSandboxFile, setSelectedSandboxFile, filesystemRevision,
    incrementFilesystemRevision,
  } = useCrowdOSStore(useShallow((s) => ({
    activeWorkspaceId: s.activeWorkspaceId,
    activeChannelId: s.activeChannelId,
    agents: s.agents,
    selectedSandboxFile: s.selectedSandboxFile,
    setSelectedSandboxFile: s.setSelectedSandboxFile,
    filesystemRevision: s.filesystemRevision,
    incrementFilesystemRevision: s.incrementFilesystemRevision,
  })));

  const { showSuccess, showError } = useToast();

  // The workspace sandbox is shown as its own labelled root, and only where an
  // L0 agent exists to reach it (§7 requirement 3). It is never merged into the
  // repository tree, because the two are different zones with different owners.
  const l0Available = useMemo(() => hasL0Agent(agents), [agents]);

  const repo = useDirectoryTree('effective', activeWorkspaceId, activeChannelId, true, filesystemRevision);
  const local = useDirectoryTree('workspace-local', activeWorkspaceId, activeChannelId, l0Available, filesystemRevision);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [isPickingNative, setIsPickingNative] = useState(false);

  const warning = mountWarning(repo.scope);
  const mounted = repo.scope?.zone === 'mounted';
  const canMount = Boolean(activeChannelId);
  // The desktop shell injects `window.crowdos` before React renders, so reading
  // it once per render is enough — there is no late-binding case to watch for.
  const nativePickerAvailable = canPickDirectoryNative();

  const handleMountSaved = useCallback((path: string | null) => {
    // The server owns the mount; bump the revision so this panel and every other
    // reader re-resolves instead of trusting an optimistic local copy.
    incrementFilesystemRevision();
    showSuccess(
      path ? 'Repository mounted' : 'Mount cleared',
      path ?? 'This channel now inherits its category or workspace mount.',
    );
  }, [incrementFilesystemRevision, showSuccess]);

  // OPEN FOLDER goes straight to the OS dialog when the desktop bridge is there,
  // and to the in-app navigator when it is not. A browser tab cannot open a
  // native dialog at all, so it must not be offered as if it could.
  const openFolder = useCallback(async () => {
    if (!activeChannelId) return;
    if (!nativePickerAvailable) {
      setPickerOpen((open) => !open);
      return;
    }
    setIsPickingNative(true);
    try {
      const outcome = await pickDirectoryNative(repo.scope?.path ?? null);
      if (outcome.canceled || !outcome.path) return;
      const picked = outcome.path;
      // The server validates the path against the mount jail; a rejected path
      // surfaces its own message rather than being silently ignored.
      await apiClient.setMount('channel', activeChannelId, picked);
      handleMountSaved(picked);
    } catch (error: any) {
      showError('Could not mount that folder', error?.message);
    } finally {
      setIsPickingNative(false);
    }
  }, [activeChannelId, nativePickerAvailable, repo.scope?.path, handleMountSaved, showError]);

  return (
    <div className="flex flex-col h-full bg-[#0c0c0f]">
      {/* Header — which folder this panel is showing, and why. */}
      <div className="shrink-0 border-b border-zinc-900">
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-[0.07em] text-zinc-400 truncate">
            Repository
          </h2>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={() => { void repo.reload(); }}
              className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60"
              title="Refresh"
              aria-label="Refresh repository tree"
            >
              <RefreshCw size={13} />
            </button>
            <button
              onClick={() => useCrowdOSStore.getState().setRightSidebarOpen(true)}
              className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60"
              title="Close (back to agent roster)"
              aria-label="Close repository panel"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="px-2.5 pb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[12.5px] font-medium text-zinc-200 truncate" title={repo.scope?.displayName}>
              {repo.isLoading && !repo.scope ? 'Loading…' : repo.scope?.displayName || 'No repository'}
            </span>
            <span
              className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-mono ${
                mounted
                  ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-500'
              }`}
              title={sourceHint(repo.scope?.source)}
            >
              {sourceLabel(repo.scope?.source)}
            </span>
          </div>
          {repo.scope?.path && (
            <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-mono text-zinc-500 min-w-0" title={repo.scope.path}>
              <HardDrive size={10} className="shrink-0" />
              <span className="truncate">{repo.scope.path}</span>
            </div>
          )}
        </div>

        {/* OPEN FOLDER — the mount entry point. Native OS dialog first, with the
            in-app navigator as the fallback when there is no desktop bridge. */}
        <div className="flex items-center gap-1.5 px-2.5 pb-2">
          <button
            onClick={() => { void openFolder(); }}
            disabled={!canMount || isPickingNative}
            aria-expanded={nativePickerAvailable ? undefined : pickerOpen}
            title={
              !canMount
                ? 'Select a channel to mount a repository'
                : nativePickerAvailable
                  ? 'Choose this channel\u2019s folder in the system dialog'
                  : 'Choose this channel\u2019s folder'
            }
            className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-[11px] font-medium text-zinc-200 transition hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60"
          >
            {isPickingNative ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
            OPEN FOLDER
          </button>
          {nativePickerAvailable && (
            <button
              onClick={() => setPickerOpen((open) => !open)}
              aria-expanded={pickerOpen}
              className="rounded border border-transparent px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-300 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60"
              title="Type a path by hand, or browse inside the app"
            >
              Manual…
            </button>
          )}
          {mounted && (
            <button
              onClick={async () => {
                if (!activeChannelId) return;
                try {
                  await apiClient.setMount('channel', activeChannelId, null);
                  handleMountSaved(null);
                } catch (error: any) {
                  showError('Could not clear the mount', error?.message);
                }
              }}
              className="rounded border border-transparent px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-300 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60"
              title="Stop using this folder; inherit the category or workspace mount instead"
            >
              Clear
            </button>
          )}
        </div>

        {pickerOpen && canMount && activeChannelId && (
          <div className="px-2.5 pb-2.5 animate-fade-in">
            <FolderMountPicker
              targetType="channel"
              targetId={activeChannelId}
              initialPath={mounted ? repo.scope?.path ?? null : null}
              onSaved={handleMountSaved}
              onClose={() => setPickerOpen(false)}
            />
          </div>
        )}
        {pickerOpen && !canMount && (
          <div className="px-2.5 pb-2.5 text-[11px] text-zinc-500">
            Select a channel to mount a repository for it.
          </div>
        )}
      </div>

      {warning && <NoticePanel failure={warning} onRetry={() => { void repo.reload(); }} />}

      {/* Repository tree (Zone B when mounted, otherwise the workspace sandbox). */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin">
        {repo.isLoading ? (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
            Loading…
          </div>
        ) : repo.failure ? (
          <NoticePanel failure={repo.failure} onRetry={() => { void repo.reload(); }} />
        ) : repo.rows.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-zinc-500 leading-relaxed">
            {emptyTreeMessage(repo.scope)}
          </div>
        ) : (
          <TreeView
            rows={repo.rows}
            childrenByPath={repo.childrenByPath}
            loadingPaths={repo.loadingPaths}
            selectedPath={selectedSandboxFile}
            onActivate={(entry) => setSelectedSandboxFile(entry.path)}
            onToggle={repo.toggle}
            ariaLabel="Repository files"
          />
        )}
      </div>

      {/* Zone A as a separate, labelled root — never folded into the tree above.
          Read-only here: opening a file from it would need the viewer to carry
          which root the path belongs to, and this panel only reports the zone. */}
      {l0Available && (
        <div className="shrink-0 border-t border-zinc-900">
          <button
            onClick={() => setLocalOpen((open) => !open)}
            aria-expanded={localOpen}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left cursor-pointer hover:bg-zinc-800/40 transition focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
            title="The workspace's own directory — configuration and workspace state"
          >
            {localOpen
              ? <ChevronDown size={13} className="text-zinc-500 shrink-0" />
              : <ChevronRight size={13} className="text-zinc-500 shrink-0" />}
            <Database size={12} className="text-zinc-500 shrink-0" />
            <span className="text-[11.5px] text-zinc-300">Workspace Local</span>
            <span
              className="ml-auto shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500"
              title="Reachable only by Level 0 (Omniscient) agents"
            >
              L0
            </span>
          </button>
          {localOpen && (
            <div className="max-h-60 overflow-y-auto scrollbar-thin pb-1">
              {local.isLoading ? (
                <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500">
                  <Loader2 size={12} className="animate-spin" />
                  Loading…
                </div>
              ) : local.failure ? (
                <NoticePanel failure={local.failure} onRetry={() => { void local.reload(); }} />
              ) : local.rows.length === 0 ? (
                <div className="px-3 py-1.5 text-[11px] text-zinc-500">{emptyTreeMessage(local.scope)}</div>
              ) : (
                <TreeView
                  rows={local.rows}
                  childrenByPath={local.childrenByPath}
                  loadingPaths={local.loadingPaths}
                  selectedPath={null}
                  onActivate={() => {}}
                  onToggle={local.toggle}
                  ariaLabel="Workspace local files"
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}