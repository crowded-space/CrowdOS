import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, X, Pin, Eye } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import SandboxCodeViewer from './SandboxCodeViewer';
const DiffViewer = React.lazy(() => import('./DiffViewer'));

/**
 * Named bottom-drawer views. A named enum, never a boolean: each tab keeps a
 * stable address for palette verbs, deep-links, and tests.
 */
export type bottomDrawerView = 'file' | 'diff' | 'log';

const DRAWER_VIEWS: Array<{ id: bottomDrawerView; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'diff', label: 'Diff' },
  { id: 'log', label: 'Log' },
];

const MIN_H = 120;
const MAX_H = 640;
const DEFAULT_H = 280;

function heightKey(workspaceId: string | null): string {
  return `crowdos_drawer_height_${workspaceId || 'default'}`;
}

function pinKey(workspaceId: string | null): string {
  return `crowdos_drawer_pinned_file_${workspaceId || 'default'}`;
}

function previewKey(workspaceId: string | null): string {
  return `crowdos_drawer_preview_file_${workspaceId || 'default'}`;
}

function readHeight(workspaceId: string | null): number {
  if (typeof localStorage === 'undefined') return DEFAULT_H;
  try {
    const raw = localStorage.getItem(heightKey(workspaceId));
    if (!raw) return DEFAULT_H;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_H;
    return Math.max(MIN_H, Math.min(MAX_H, n));
  } catch {
    return DEFAULT_H;
  }
}

function readPinned(workspaceId: string | null): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(pinKey(workspaceId));
    return raw && raw.trim() !== '' ? raw : null;
  } catch {
    return null;
  }
}

function readPreview(workspaceId: string | null): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(previewKey(workspaceId));
    return raw && raw.trim() !== '' ? raw : null;
  } catch {
    return null;
  }
}

/** Short hash helper for the log tab: 7 chars like the diff header, '-' when absent. */
function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 7) : '-';
}

/**
 * Bottom artifact drawer (UX_GUIDELINE section 8): file/diff/log tabs under a
 * named view enum, a resizable splitter with keyboard support, per-workspace
 * height memory, and a preview-vs-pinned file distinction. The file tab
 * renders the pinned file when one is kept, otherwise the live preview
 * selection; the toggle persists per workspace. The diff tab renders the
 * latest run's DiffViewer; the log tab is a read-only channel log sourced
 * from the store's message list (no invented entries).
 */
export function BottomDrawer(): React.JSX.Element | null {
  const activeWorkspaceId = useCrowdOSStore(s => s.activeWorkspaceId);
  const activeChannelId = useCrowdOSStore(s => s.activeChannelId);
  const selectedSandboxFile = useCrowdOSStore(s => s.selectedSandboxFile);
  const setSelectedSandboxFile = useCrowdOSStore(s => s.setSelectedSandboxFile);
  const artifactsByRun = useCrowdOSStore(s => s.artifactsByRun);
  const fetchArtifacts = useCrowdOSStore(s => s.fetchArtifacts);
  const messages = useCrowdOSStore(s => s.messages);
  const [view, setView] = useState<bottomDrawerView>('file');
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(() => readHeight(activeWorkspaceId));
  const [pinnedFile, setPinnedFile] = useState<string | null>(() => readPinned(activeWorkspaceId));
  const [previewFile, setPreviewFile] = useState<string | null>(() => readPreview(activeWorkspaceId));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Reload per-workspace memory on workspace switch; never invent a path.
  useEffect(() => {
    setHeight(readHeight(activeWorkspaceId));
    setPinnedFile(readPinned(activeWorkspaceId));
    setPreviewFile(readPreview(activeWorkspaceId));
  }, [activeWorkspaceId]);

  // The live selection is the preview candidate. It follows selection changes
  // unless a pinned file is being kept.
  useEffect(() => {
    if (selectedSandboxFile) {
      setPreviewFile(selectedSandboxFile);
      try {
        localStorage.setItem(previewKey(activeWorkspaceId), selectedSandboxFile);
      } catch {
        // Persistence is best-effort; the preview still renders this session.
      }
    }
  }, [selectedSandboxFile, activeWorkspaceId]);

  const latestRunId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const rid =
        (m as unknown as { metadata?: { runId?: string; run_id?: string }; runId?: string }).metadata?.runId ||
        (m as unknown as { metadata?: { runId?: string; run_id?: string } }).metadata?.run_id ||
        (m as unknown as { runId?: string }).runId;
      if (rid) return rid;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (latestRunId) void fetchArtifacts(latestRunId);
  }, [latestRunId, fetchArtifacts]);

  const channelLog = useMemo(
    () => messages.filter(m => m.channelId === activeChannelId).slice(-100),
    [messages, activeChannelId],
  );

  const persistHeight = useCallback(
    (next: number) => {
      setHeight(next);
      try {
        localStorage.setItem(heightKey(activeWorkspaceId), String(next));
      } catch {
        // Persistence is best-effort; the height still applies this session.
      }
    },
    [activeWorkspaceId],
  );

  const onSplitterPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragRef.current = { startY: e.clientY, startH: height };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [height],
  );

  const onSplitterPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.max(MIN_H, Math.min(MAX_H, Math.round(drag.startH + (drag.startY - e.clientY))));
      persistHeight(next);
    },
    [persistHeight],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onSplitterKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        persistHeight(Math.min(MAX_H, height + 20));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        persistHeight(Math.max(MIN_H, height - 20));
      } else if (e.key === 'Home') {
        e.preventDefault();
        persistHeight(MAX_H);
      } else if (e.key === 'End') {
        e.preventDefault();
        persistHeight(MIN_H);
      }
    },
    [height, persistHeight],
  );

  const focusTab = useCallback((index: number) => {
    const clamped = (index + DRAWER_VIEWS.length) % DRAWER_VIEWS.length;
    setView(DRAWER_VIEWS[clamped].id);
    tabRefs.current[clamped]?.focus();
  }, []);

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        focusTab(index + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        focusTab(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        focusTab(DRAWER_VIEWS.length - 1);
      }
    },
    [focusTab],
  );

  const keepPreview = useCallback(() => {
    if (!previewFile) return;
    setPinnedFile(previewFile);
    try {
      localStorage.setItem(pinKey(activeWorkspaceId), previewFile);
    } catch {
      // Persistence is best-effort; the pin still applies this session.
    }
  }, [previewFile, activeWorkspaceId]);

  const unpin = useCallback(() => {
    setPinnedFile(null);
    try {
      localStorage.removeItem(pinKey(activeWorkspaceId));
    } catch {
      // Persistence is best-effort; the unpin still applies this session.
    }
  }, [activeWorkspaceId]);

  const openPreview = useCallback(() => {
    if (previewFile) setSelectedSandboxFile(previewFile);
  }, [previewFile, setSelectedSandboxFile]);

  const filePath = pinnedFile || previewFile;
  const showingPinned = pinnedFile !== null && pinnedFile === filePath;

  if (!open) {
    return (
      <div className="shrink-0 border-t border-zinc-900/80 px-3 py-1.5 flex items-center gap-2 bg-[#0c0c0f]" data-drawer-slot="bottom-drawer">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open bottom drawer"
          aria-expanded={false}
          className="px-3 py-1.5 min-h-[30px] rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] font-mono font-semibold border border-zinc-800 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        >
          Open drawer
        </button>
        <span className="text-[11px] font-mono text-zinc-600">file / diff / log</span>
      </div>
    );
  }

  return (
    <section aria-label="Bottom drawer" data-drawer-slot="bottom-drawer" className="shrink-0 border-t border-zinc-900/80 bg-[#0c0c0f] flex flex-col min-h-0">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Resize bottom drawer"
        aria-valuemin={MIN_H}
        aria-valuemax={MAX_H}
        aria-valuenow={Math.round(height)}
        onPointerDown={onSplitterPointerDown}
        onPointerMove={onSplitterPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onSplitterKeyDown}
        className="h-1.5 cursor-row-resize bg-transparent hover:bg-indigo-500/20 focus:outline-none focus-visible:bg-indigo-500/30 shrink-0"
      />
      <div className="flex items-center gap-1.5 px-3 py-1.5 shrink-0">
        <div role="tablist" aria-label="Bottom drawer views" className="flex items-center gap-1">
          {DRAWER_VIEWS.map((t, i) => (
            <button
              key={t.id}
              ref={el => { tabRefs.current[i] = el; }}
              role="tab"
              id={`drawer-tab-${t.id}`}
              aria-selected={view === t.id}
              aria-controls={`drawer-panel-${t.id}`}
              tabIndex={view === t.id ? 0 : -1}
              onClick={() => { setView(t.id); }}
              onKeyDown={e => onTabKeyDown(e, i)}
              className={`px-3 py-1.5 min-h-[30px] rounded-lg text-[11px] font-mono font-semibold transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${view === t.id ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300 border border-transparent'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {view === 'file' && !showingPinned && previewFile && (
            <button
              onClick={keepPreview}
              aria-label={`Pin file ${previewFile}`}
              title="Keep this preview file (pin it)"
              className="px-2.5 py-1.5 min-h-[30px] rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] font-mono border border-zinc-800 flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
            >
              <Pin size={12} aria-hidden="true" /> Pin
            </button>
          )}
          {view === 'file' && showingPinned && (
            <button
              onClick={unpin}
              aria-label={`Unpin file ${pinnedFile}`}
              title="Release the pinned file back to preview"
              className="px-2.5 py-1.5 min-h-[30px] rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] font-mono border border-zinc-800 flex items-center gap-1.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
            >
              <Pin size={12} aria-hidden="true" /> Unpin
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            aria-label="Close bottom drawer"
            className="w-9 h-9 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-[4px] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 transition-colors cursor-pointer flex items-center justify-center"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-h-0 overflow-hidden px-3 pb-2" style={{ height }}>
        {view === 'file' && (
          <div role="tabpanel" id="drawer-panel-file" aria-labelledby="drawer-tab-file" className="h-full flex flex-col min-h-0 border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950/40">
            {filePath ? (
              <>
                <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/50 border-b border-zinc-800 shrink-0">
                  <FileCode2 size={13} className="text-zinc-500 shrink-0" aria-hidden="true" />
                  <span className="text-[12px] font-mono text-zinc-300 truncate">{filePath}</span>
                  <span className="ml-auto shrink-0 inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
                    {showingPinned ? (<><Pin size={10} aria-hidden="true" /> pinned</> ) : (<><Eye size={10} aria-hidden="true" /> preview</>)}
                  </span>
                  {!showingPinned && previewFile && (
                    <button
                      onClick={openPreview}
                      aria-label={`Open preview file ${previewFile} in editor`}
                      className="shrink-0 text-[10px] font-mono text-indigo-300 hover:text-indigo-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 rounded"
                    >
                      Open in editor
                    </button>
                  )}
                </div>
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  <SandboxCodeViewer path={filePath} workspaceId={activeWorkspaceId} channelId={activeChannelId} />
                </div>
              </>
            ) : (
              <div className="p-4 text-[11px] font-mono text-zinc-500">No file selected. Open a file from the repository panel to preview it here.</div>
            )}
          </div>
        )}
        {view === 'diff' && (
          <div role="tabpanel" id="drawer-panel-diff" aria-labelledby="drawer-tab-diff" className="h-full overflow-y-auto">
            {latestRunId ? (
              <React.Suspense fallback={<div className="p-3 text-xs text-zinc-500 animate-pulse">Loading diffs...</div>}>
                <DiffViewer runId={latestRunId} />
              </React.Suspense>
            ) : (
              <div className="p-4 text-[11px] font-mono text-zinc-500">No run yet. Diffs for the latest run appear here.</div>
            )}
          </div>
        )}
        {view === 'log' && (
          <div role="tabpanel" id="drawer-panel-log" aria-labelledby="drawer-tab-log" className="h-full overflow-y-auto border border-zinc-800 rounded-lg bg-zinc-950/40 p-2 space-y-1">
            {channelLog.length === 0 ? (
              <div className="p-2 text-[11px] font-mono text-zinc-500">No log entries for this channel yet.</div>
            ) : (
              channelLog.map(m => (
                <div key={m.id} className="text-[11px] font-mono text-zinc-400 break-words">
                  <span className="text-zinc-600">{new Date(m.timestamp).toLocaleTimeString()} </span>
                  <span className="text-zinc-300">{m.authorName}: </span>
                  <span>{m.content.slice(0, 300)}</span>
                  {m.type === 'agent' && (m as unknown as { metadata?: { runId?: string } }).metadata?.runId && (
                    <span className="text-zinc-600"> [{shortHash((m as unknown as { metadata?: { runId?: string } }).metadata?.runId)}]</span>
                  )}
                </div>
              ))
            )}
            <p className="px-1 pt-1 text-[10px] font-mono text-zinc-600">Read-only. Latest {channelLog.length} message(s) in this channel.</p>
          </div>
        )}
      </div>
      <div className="sr-only" aria-live="polite">{view} view</div>
    </section>
  );
}

export default BottomDrawer;
