/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useShallow } from 'zustand/react/shallow';
import WorkspacePortal from '@/components/portal/WorkspacePortal';
import WorkspaceSidebar from '@/components/workspace/WorkspaceSidebar';
import MainChatArea from '@/components/workspace/MainChatArea';
import RightSidebar from '@/components/workspace/RightSidebar';
import { ToastProvider } from '@/components/ui/ToastProvider';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import LockScreen from '@/components/lockscreen/LockScreen';
import OfflineBanner from '@/components/ui/OfflineBanner';
import { useScreenLockStore, SCREENLOCK_IDLE_MS } from '@/stores/screenLockStore';

// Overlay-only surfaces: kept out of the initial bundle so first paint
// downloads only what the workspace shell actually needs.
const AgentProfileModal = lazy(() => import('@/components/workspace/modals/AgentProfileModal'));
const WorkspaceSettingsModal = lazy(() => import('@/components/workspace/modals/WorkspaceSettingsModal'));
const OmniSearchModal = lazy(() => import('@/components/workspace/modals/OmniSearchModal'));

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
    dbDegraded,
    fetchWorkspaces
  } = useCrowdOSStore(useShallow(s => ({
    activeWorkspaceId: s.activeWorkspaceId,
    dbDegraded: (s.workspaces.find(w => w.id === s.activeWorkspaceId)?.database?.configured) === false,
    fetchWorkspaces: s.fetchWorkspaces,
  })));

  const [searchOpen, setSearchOpen] = useState(false);
  const locked = useScreenLockStore(s => s.locked);

  const stableFetchWorkspaces = useCallback(() => { void fetchWorkspaces(); }, [fetchWorkspaces]);
  useEffect(() => {
    stableFetchWorkspaces();
  }, [stableFetchWorkspaces]);

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
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Onboarding Portal Gate — with skeleton fallback while bootstrapping
  if (!activeWorkspaceId) {
    return (
      <ToastProvider>
        <div className="w-full h-dvh bg-[#060608] text-zinc-100 flex items-center justify-center p-4 overflow-y-auto">
          <ErrorBoundary fallback={<div className="p-6 text-sm text-zinc-400">Portal failed to load</div>}>
            <WorkspacePortal />
          </ErrorBoundary>
        </div>
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
        <OfflineBanner dbDegraded={dbDegraded} />

        {/* 3-Panel Content Area */}
        <div className="flex-1 flex overflow-hidden w-full relative isolate">

          {/* Left Sidebar Panel — always mounted (desktop-first shell) */}
          <nav aria-label="Workspace channels" className="flex shrink-0 h-full w-[clamp(240px,20vw,280px)] border-r border-zinc-900/80">
            <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Sidebar failed to load</div>}>
              <WorkspaceSidebar />
            </ErrorBoundary>
          </nav>

          {/* Center Chat Work Area */}
          <main className="flex-1 flex flex-col h-full overflow-hidden min-w-0 bg-[#121214]">
            <ErrorBoundary fallback={<div className="p-6 text-sm text-zinc-400">Chat failed to load</div>}>
              <MainChatArea onOpenSearch={() => setSearchOpen(true)} />
            </ErrorBoundary>
          </main>

          {/* Right Sidebar Panel — hidden only in very narrow windows */}
          <aside aria-label="Operations roster and telemetry" className="hidden md:flex shrink-0 h-full">
            <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Roster failed to load</div>}>
              <RightSidebar />
            </ErrorBoundary>
          </aside>

        </div>

        {/* Globally tracked status dialog modals */}
        <Suspense fallback={<SpinnerFallback />}>
          <AgentProfileModal />
          <WorkspaceSettingsModal />
          <OmniSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
        {locked && <LockScreen />}

      </div>
    </ToastProvider>
  );
}

