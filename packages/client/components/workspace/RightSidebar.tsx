import React, { lazy, Suspense } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import { JobsView } from './JobsView';
import { OperationsInbox } from './OperationsInbox';
import { RosterPanel } from './RosterPanel';
import { TelemetryPanel } from './TelemetryPanel';

const FileExplorer = lazy(() => import('./FileExplorer'));
const BrowserPanel = lazy(() => import('./BrowserPanel'));

/**
 * Desktop right panel (xl+): roster / repo / jobs / telemetry / browser views.
 * The panel content itself lives in per-view components (RosterPanel,
 * TelemetryPanel, JobsView, FileExplorer, BrowserPanel) that read the store
 * directly — OperationsSheet mounts the SAME components below xl, so every
 * panel is reachable at every viewport width (UI audit §2.16, 2026-10-22).
 * This file owns only the view address, the w-[260px] containers, and the
 * AnimatePresence/reduced-motion presentation.
 */
export default function RightSidebar() {
  const { rightPanelView } = useCrowdOSStore(useShallow(s => ({ rightPanelView: s.rightPanelView })));
  const shouldReduceMotion = useReducedMotion();

  // Respect reduced-motion: disable AnimatePresence spring when user prefers reduced motion
  if (shouldReduceMotion) {
    // Reduced-motion: no AnimatePresence spring, plain divs preserve UX quality statically
    if (rightPanelView === 'repo') {
      return (
        <div id="right-panel-repo" role="tabpanel" aria-labelledby="right-panel-tab-repo" className="w-[260px] flex flex-col h-full overflow-hidden shrink-0 border-l border-zinc-900 border-x-0">
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading repository…</div>}>
            <FileExplorer />
          </Suspense>
        </div>
      );
    }
    if (rightPanelView === 'jobs') {
      return (
        <div id="right-panel-jobs" role="tabpanel" aria-labelledby="right-panel-tab-jobs" className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0">
          <OperationsInbox />
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading jobs...</div>}>
            <JobsView />
          </Suspense>
        </div>
      );
    }
    if (rightPanelView === 'telemetry') {
      return (
        <div id="right-panel-telemetry" role="tabpanel" aria-labelledby="right-panel-tab-telemetry" className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0">
          <TelemetryPanel />
        </div>
      );
    }
    if (rightPanelView === 'browser') {
      return (
        <div id="right-panel-browser" role="tabpanel" aria-labelledby="right-panel-tab-browser" className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0">
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading browser...</div>}>
            <BrowserPanel />
          </Suspense>
        </div>
      );
    }
    return (
      <div id="right-panel-roster" role="tabpanel" aria-labelledby="right-panel-tab-roster" className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0">
        <RosterPanel />
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait">
      {rightPanelView === 'repo' ? (
        <motion.div
          key="file-explorer"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15 }}
          id="right-panel-repo"
          role="tabpanel"
          aria-labelledby="right-panel-tab-repo"
          className="w-[260px] flex flex-col h-full overflow-hidden shrink-0 border-l border-zinc-900 border-x-0"
        >
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading repository…</div>}>
            <FileExplorer />
          </Suspense>
        </motion.div>
      ) : rightPanelView === 'jobs' ? (
        <motion.div
          key="jobs-view"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15 }}
          id="right-panel-jobs"
          role="tabpanel"
          aria-labelledby="right-panel-tab-jobs"
          className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0"
        >
          <OperationsInbox />
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading jobs...</div>}>
            <JobsView />
          </Suspense>
        </motion.div>
      ) : rightPanelView === 'telemetry' ? (
        <motion.div
          key="telemetry-view"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15 }}
          id="right-panel-telemetry"
          role="tabpanel"
          aria-labelledby="right-panel-tab-telemetry"
          className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0"
        >
          <TelemetryPanel />
        </motion.div>
      ) : rightPanelView === 'browser' ? (
        <motion.div
          key="browser-panel"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15 }}
          id="right-panel-browser"
          role="tabpanel"
          aria-labelledby="right-panel-tab-browser"
          className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0"
        >
          <Suspense fallback={<div className="p-4 text-xs text-zinc-500 animate-pulse">Loading browser...</div>}>
            <BrowserPanel />
          </Suspense>
        </motion.div>
      ) : (
        <motion.div
          key="roster-view"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.15 }}
          id="right-panel-roster"
          role="tabpanel"
          aria-labelledby="right-panel-tab-roster"
          className="w-[260px] bg-[#0c0c0e]/95 border-l border-zinc-900 flex flex-col h-full overflow-hidden select-none shrink-0"
        >
          <RosterPanel />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
