import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Folder, Inbox, X, type LucideIcon } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import { JobsView } from './JobsView';
import { OperationsInbox } from './OperationsInbox';

const FileExplorer = React.lazy(() => import('./FileExplorer'));

/** Named ops-sheet views. A named enum, never a boolean: each tab keeps a stable address. */
export type operationsSheetView = 'jobs' | 'approvals' | 'repo';

interface operationsSheetTab {
  id: operationsSheetView;
  label: string;
  icon: LucideIcon;
}

const SHEET_TABS: ReadonlyArray<operationsSheetTab> = [
  { id: 'jobs', label: 'Jobs', icon: ClipboardList },
  { id: 'approvals', label: 'Approvals', icon: Inbox },
  { id: 'repo', label: 'Repo', icon: Folder },
];

/**
 * Narrow-width ops bottom sheet (UX_GUIDELINE section 4): Jobs / Approvals /
 * Repo tabs for viewports where the right ops panel is hidden (below xl).
 * The trigger bar always renders where mounted, so ops are never fully
 * hidden. Tabs reuse the SAME store projections the desktop panel uses
 * (jobsByRun via JobsView, inboxItems via OperationsInbox, FileExplorer) -
 * no second run/approval/repo model, no new endpoints, no invented rows;
 * empty states stay honest. Dismissal is backdrop, Escape, or channel
 * selection; tabs use roving tabindex with Arrow/Home/End keys; counts are
 * icon+text with a polite live region; the sheet is static (no motion).
 */
export function OperationsSheet(): React.JSX.Element {
  const { jobsByRun, approvalRequests, inboxDeferred, activeChannelId } = useCrowdOSStore(useShallow(s => ({
    jobsByRun: s.jobsByRun,
    approvalRequests: s.approvalRequests,
    inboxDeferred: s.inboxDeferred,
    activeChannelId: s.activeChannelId,
  })));

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<operationsSheetView>('jobs');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const prevOpenRef = useRef(false);
  const prevChannelRef = useRef(activeChannelId);

  const jobsCount = useMemo(() => Object.keys(jobsByRun ?? {}).length, [jobsByRun]);
  const pendingCount = useMemo(
    () => approvalRequests.filter(r => r.status === 'pending' && !inboxDeferred[r.id]).length,
    [approvalRequests, inboxDeferred],
  );

  const activeIndex = Math.max(0, SHEET_TABS.findIndex(t => t.id === view));
  const activeTab = SHEET_TABS[activeIndex];

  const close = useCallback(() => setOpen(false), []);

  // Focus the active tab on open; return focus to the trigger on close.
  useEffect(() => {
    const was = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !was) {
      tabRefs.current[activeIndex]?.focus();
    } else if (!open && was) {
      triggerRef.current?.focus();
    }
  }, [open, activeIndex]);

  // Escape closes while open. The shell drawer Escape handler ignores
  // keydowns while a modal dialog is present, so this owns dismissal.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Channel selection dismisses the sheet (same contract as the nav drawer).
  useEffect(() => {
    if (prevChannelRef.current !== activeChannelId) {
      prevChannelRef.current = activeChannelId;
      setOpen(false);
    }
  }, [activeChannelId]);

  const focusTab = useCallback((index: number) => {
    const clamped = (index + SHEET_TABS.length) % SHEET_TABS.length;
    const next = SHEET_TABS[clamped];
    if (!next) return;
    setView(next.id);
    tabRefs.current[clamped]?.focus();
  }, []);

  const onTabKeyDown = useCallback((e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusTab(index + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusTab(index - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(SHEET_TABS.length - 1);
    }
  }, [focusTab]);

  const triggerLabel = `Open operations sheet: ${jobsCount} jobs, ${pendingCount} pending approvals`;
  const statusText = open
    ? `Operations sheet open, ${activeTab?.label ?? 'Jobs'} view. ${jobsCount} jobs, ${pendingCount} pending approvals.`
    : 'Operations sheet closed.';

  return (
    <>
      <div data-ops-sheet="trigger" className="flex shrink-0 items-center gap-2 border-t border-zinc-900/80 bg-[#0c0c0f] px-3 py-1.5">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="ops-sheet-dialog"
          aria-label={triggerLabel}
          className="inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-[11px] font-semibold text-zinc-300 transition hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        >
          <ClipboardList size={12} aria-hidden="true" />
          Ops
          <span className="tnum rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">{jobsCount} jobs</span>
          <span className="tnum rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">{pendingCount} approvals</span>
        </button>
        <span className="font-mono text-[11px] text-zinc-600">jobs / approvals / repo</span>
      </div>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close operations sheet"
            onPointerDown={close}
            onClick={close}
            className="fixed inset-0 z-40 cursor-pointer bg-black/55 xl:hidden"
          />
          <section
            id="ops-sheet-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Operations sheet: jobs, approvals, repository"
            className="fixed inset-x-0 bottom-0 z-50 flex h-[min(72dvh,540px)] min-h-0 flex-col rounded-t-xl border-t border-zinc-800 bg-[#0c0c0e] shadow-2xl xl:hidden"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-900 px-3 py-2">
              <div role="tablist" aria-label="Operations views" className="flex items-center gap-1">
                {SHEET_TABS.map((t, i) => {
                  const Icon = t.icon;
                  const selected = view === t.id;
                  return (
                    <button
                      key={t.id}
                      ref={el => { tabRefs.current[i] = el; }}
                      role="tab"
                      id={`ops-sheet-tab-${t.id}`}
                      aria-selected={selected}
                      aria-controls="ops-sheet-panel"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setView(t.id)}
                      onKeyDown={e => onTabKeyDown(e, i)}
                      className={`inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[11px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${selected ? 'border border-zinc-700 bg-zinc-800 text-zinc-100' : 'border border-transparent text-zinc-500 hover:text-zinc-300'}`}
                    >
                      <Icon size={12} aria-hidden="true" />
                      {t.label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close operations sheet"
                className="ml-auto flex h-9 w-9 cursor-pointer items-center justify-center rounded-[4px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <div id="ops-sheet-panel" role="tabpanel" aria-labelledby={`ops-sheet-tab-${view}`} className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {view === 'jobs' && (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <JobsView />
                </div>
              )}
              {view === 'approvals' && (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <OperationsInbox />
                </div>
              )}
              {view === 'repo' && (
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <div className="absolute inset-0">
                    <Suspense fallback={<div className="p-4 text-xs text-zinc-500">Loading repository\u2026</div>}>
                      <FileExplorer />
                    </Suspense>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}
      <p className="sr-only" aria-live="polite">{statusText}</p>
    </>
  );
}

export default OperationsSheet;
