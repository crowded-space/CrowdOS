/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import WorkspacePortal from '@/components/portal/WorkspacePortal';
import { ToastProvider } from '@/components/ui/ToastProvider';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import OfflineBanner from '@/components/ui/OfflineBanner';
import { CrowSigil } from '@/components/ui/CrowSigil';
import { useScreenLockStore, SCREENLOCK_IDLE_MS } from '@/stores/screenLockStore';

// Route-level + overlay code splitting: keep heavy workspace shell modules
// (syntax highlighting, diff viewer, file explorer, chat engine) out of the
// initial Portal bundle so first paint stays minimal and fast.
const WorkspaceSidebar = lazy(() => import('@/components/workspace/WorkspaceSidebar'));
const MainChatArea = lazy(() => import('@/components/workspace/MainChatArea'));
const RightSidebar = lazy(() => import('@/components/workspace/RightSidebar'));
const BottomDrawer = lazy(() => import('@/components/workspace/BottomDrawer'));
const OperationsSheet = lazy(() => import('@/components/workspace/OperationsSheet'));
const LockScreen = lazy(() => import('@/components/lockscreen/LockScreen'));
const AgentProfileModal = lazy(() => import('@/components/workspace/modals/AgentProfileModal'));
const WorkspaceSettingsModal = lazy(() => import('@/components/workspace/modals/WorkspaceSettingsModal'));
const OmniSearchModal = lazy(() => import('@/components/workspace/modals/OmniSearchModal'));
const QuickAsk = lazy(() => import('@/components/workspace/QuickAsk'));

function SpinnerFallback() {
  return (
    <div className="flex flex-col gap-2 p-4 min-w-[240px]" aria-label="Loading dialog" role="status">
      <div className="h-5 w-2/3 skeleton" />
      <div className="h-9 w-full skeleton" />
      <div className="h-9 w-full skeleton" />
    </div>
  );
}

export default function App() {
  const {
    activeWorkspaceId,
    workspacesBootstrapped,
    dbDegraded,
    fetchWorkspaces,
    setSettingsModalOpen,
    setWorkspaceSettingsTab,
    queuedOutboxCount
  } = useCrowdOSStore(useShallow(s => ({
    activeWorkspaceId: s.activeWorkspaceId,
    workspacesBootstrapped: s.workspacesBootstrapped,
    dbDegraded: (s.workspaces.find(w => w.id === s.activeWorkspaceId)?.database?.configured) === false,
    fetchWorkspaces: s.fetchWorkspaces,
    setSettingsModalOpen: s.setSettingsModalOpen,
    setWorkspaceSettingsTab: s.setWorkspaceSettingsTab,
    queuedOutboxCount: s.outbox.filter(e => e.status === 'queued').length,
  })));

  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quickAskOpen, setQuickAskOpen] = useState(false);
  const locked = useScreenLockStore(s => s.locked);

  const stableFetchWorkspaces = useCallback(() => { void fetchWorkspaces(); }, [fetchWorkspaces]);
  const openDatabaseSettings = useCallback(() => {
    setWorkspaceSettingsTab('overview');
    setSettingsModalOpen(true);
  }, [setSettingsModalOpen, setWorkspaceSettingsTab]);
  useEffect(() => {
    stableFetchWorkspaces();
  }, [stableFetchWorkspaces]);
  // Phase G capture tier: palette verbs summon QuickAsk via a window event
  // so the registry (which owns no React state) can open a real UI action.
  useEffect(() => {
    const openQuickAsk = () => {
      setSearchOpen(false);
      setQuickAskOpen(true);
    };
    window.addEventListener('crowdos:quick-ask-open', openQuickAsk);
    return () => window.removeEventListener('crowdos:quick-ask-open', openQuickAsk);
  }, []);

  // ponytail: interval + focus/mouse/key wiring; per-workspace idle tracker.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const touch = () => useScreenLockStore.getState().touchActivity();
    const check = () => {
      const { lastActivity } = useScreenLockStore.getState();
      const ws = useCrowdOSStore.getState().workspaces.find(w => w.id === useCrowdOSStore.getState().activeWorkspaceId);
      if (ws?.screenLockEnabled && Date.now() - lastActivity > SCREENLOCK_IDLE_MS) {
        useScreenLockStore.getState().lock();
      }
    };
    const t = setInterval(check, 10000);
    window.addEventListener('mousemove', touch);
    window.addEventListener('keydown', touch);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(t);
      window.removeEventListener('mousemove', touch);
      window.removeEventListener('keydown', touch);
      window.removeEventListener('focus', check);
    };
  }, [activeWorkspaceId]);

  // Sync browser history (back/forward) with channel selection
  useEffect(() => {
    const handlePopState = () => {
      const hash = window.location.hash.replace(/^#\/?/, '');
      if (!hash) return;
      const parts = hash.split('/');
      const channelId = parts[parts.length - 1];
      const workspaceId = parts.length > 1 ? parts[0] : null;
      const state = useCrowdOSStore.getState();
      // If hash contains workspace and it's different, enter it
      if (workspaceId && workspaceId !== state.activeWorkspaceId) {
        const exists = state.workspaces.some(w => w.id === workspaceId);
        if (exists) {
          state.enterWorkspace(workspaceId);
          return;
        }
      }
      if (channelId && channelId !== state.activeChannelId) {
        const visibleIds = new Set([
          ...(state.workspaces.find(w => w.id === state.activeWorkspaceId)?.channels?.map(c => c.id) || []),
          ...(state.workspaces.find(w => w.id === state.activeWorkspaceId)?.categories.flatMap(cat => cat.channels.map(c => c.id)) || [])
        ]);
        if (visibleIds.has(channelId)) {
          state.setActiveChannel(channelId);
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('hashchange', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handlePopState);
    };
  }, []);

  // Keyboard shortcut listener for Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const overlayOpen = document.querySelector(
        '[role="dialog"][aria-modal="true"], [role="menu"]',
      );
      if (e.key === 'Escape' && sidebarOpen && !overlayOpen) {
        setSidebarOpen(false);
        return;
      }
      // Phase G capture tier: global summon on Ctrl/Cmd+Shift+K. Explicit
      // Shift guard so Ctrl/Cmd+K keeps opening the palette untouched.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen(false);
        setQuickAskOpen((prev) => !prev);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen]);

  // Onboarding Portal Gate — with skeleton fallback while bootstrapping.
  // Audit §1: the store restores activeWorkspaceId synchronously from
  // localStorage, so without this gate the shell could mount for one paint
  // with a deleted workspace id — every panel firing 503s against the
  // phantom workspace before fetchWorkspaces validated the registry. The
  // bootstrap skeleton holds the first paint until that probe completes.
  if (!workspacesBootstrapped) {
    return (
      <div className="w-full h-dvh bg-[#070709] flex items-center justify-center" role="status" aria-label="Loading CrowdOS">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center" aria-hidden="true">
            <CrowSigil size={24} tone="auto" detail="compact" />
          </div>
          <span className="text-[11px] font-mono text-zinc-500">Loading workspaces…</span>
        </div>
      </div>
    );
  }
  if (!activeWorkspaceId) {
    return (
      <ToastProvider>
        <ErrorBoundary fallback={<div className="p-6 text-sm text-zinc-400">Portal failed to load</div>}>
          <WorkspacePortal />
        </ErrorBoundary>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="w-full h-dvh overflow-hidden bg-[#0A0A0B] text-zinc-100 flex flex-col font-sans antialiased" id="crowd-os-root-shell">
        <a
          href="#main-chat-area"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[70] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-zinc-900 focus:text-zinc-100 focus:outline-none"
        >
          Skip to chat
        </a>
        <div className="grain-overlay" aria-hidden />
        {/* Audit §2.6 (minor #25): lock() deliberately disconnects the socket,
            so while the veil is up the "Connection lost" banner behind it
            reads like an app failure. The lock screen IS the status surface
            while locked — hide the banner until the operator unlocks. */}
        {!locked && <OfflineBanner dbDegraded={dbDegraded} onOpenDatabaseSettings={openDatabaseSettings} queuedCount={queuedOutboxCount} />}

        {/* 3-Panel Content Area */}
        <div className="flex-1 flex overflow-hidden w-full relative isolate">

          {sidebarOpen && (
            <button
              type="button"
              // Audit §2.16 (minor #21): closes the off-canvas sidebar drawer
              // (the sibling of the "Open sidebar" ☰ button), not the
              // workspace dropdown menu.
              aria-label="Close sidebar"
              onPointerDown={() => setSidebarOpen(false)}
              onClick={() => setSidebarOpen(false)}
              className="absolute inset-y-0 right-0 left-[min(86vw,300px)] z-30 bg-black/55 xl:hidden cursor-pointer"
            />
          )}

          {/* Left panel is off-canvas below xl so the chat keeps the full viewport. */}
          <nav
            aria-label="Workspace channels"
            className={`absolute inset-y-0 left-0 z-40 flex h-full w-[min(86vw,300px)] border-r border-zinc-900/80 bg-[#0c0c0f] transition-transform duration-200 xl:static xl:z-auto xl:w-[clamp(240px,20vw,280px)] xl:translate-x-0 ${
              sidebarOpen ? 'translate-x-0 visible' : '-translate-x-full invisible xl:visible'
            }`}
          >
            <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Sidebar failed to load</div>}>
              <Suspense fallback={<div className="w-full h-full bg-[#0c0c0f]" />}>
                <WorkspaceSidebar onClose={() => setSidebarOpen(false)} />
              </Suspense>
            </ErrorBoundary>
          </nav>

          {/* Center Chat Work Area */}
          <main className="flex-1 flex flex-col h-full overflow-hidden min-w-0 bg-[#121214]">
            <ErrorBoundary fallback={<div className="p-6 text-sm text-zinc-400">Chat failed to load</div>}>
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs font-mono text-zinc-500">Loading workspace…</div>}>
                <MainChatArea
                  onOpenSearch={() => setSearchOpen(true)}
                  onOpenSidebar={() => setSidebarOpen(true)}
                />
              </Suspense>
            </ErrorBoundary>
            {/* Bottom artifact drawer: stable named slot below the center chat.
                Inside the center column so the shell row keeps nav / chat /
                roster order; the dock stays default. */}
            <div data-slot="bottom-drawer" className="shrink-0 flex flex-col min-h-0">
              <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Drawer failed to load</div>}>
                <Suspense fallback={null}>
                  <BottomDrawer />
                </Suspense>
              </ErrorBoundary>
            </div>
            {/* Narrow-width ops sheet: Jobs / Approvals / Repo tabs for
                viewports where the right ops panel is hidden (below xl).
                The trigger bar always renders here, so ops are never fully
                hidden; xl:hidden keeps the desktop roster as the single ops
                surface at xl+. */}
            <div data-slot="ops-sheet" className="shrink-0 flex flex-col min-h-0 xl:hidden">
              <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Ops failed to load</div>}>
                <Suspense fallback={null}>
                  <OperationsSheet />
                </Suspense>
              </ErrorBoundary>
            </div>
          </main>

          {/* Keep narrow and tablet widths for the chat; the roster is desktop-only. */}
          <aside aria-label="Operations panel: roster, repository, jobs, and telemetry" className="hidden xl:flex shrink-0 h-full">
            <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Roster failed to load</div>}>
              <Suspense fallback={<div className="w-[260px] h-full bg-[#0c0c0e]/95 border-l border-zinc-900" />}>
                <RightSidebar />
              </Suspense>
            </ErrorBoundary>
          </aside>

        </div>

        {/* Globally tracked status dialog modals. Wrapped so one broken
            modal render (audit §2.1: AuditTab unmounted the whole shell)
            degrades to a bounded fallback with Retry instead of killing
            chat, drafts and panels. */}
        <ErrorBoundary fallback={<div className="p-6 text-sm text-zinc-400">Dialog failed to load</div>}>
          <Suspense fallback={null}>
            <AgentProfileModal />
            <WorkspaceSettingsModal />
            <OmniSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
            <QuickAsk open={quickAskOpen} onClose={() => setQuickAskOpen(false)} />
          </Suspense>
        </ErrorBoundary>
        {locked && (
          <Suspense fallback={null}>
            <LockScreen />
          </Suspense>
        )}

      </div>
    </ToastProvider>
  );
}

