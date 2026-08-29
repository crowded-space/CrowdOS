/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import { useShallow } from 'zustand/react/shallow';
import WorkspacePortal from '@/components/portal/WorkspacePortal';
import WorkspaceSidebar from '@/components/workspace/workspace-sidebar';
import MainChatArea from '@/components/workspace/main-chat-area';
import RightSidebar from '@/components/workspace/right-sidebar';
import BottomNav from '@/components/workspace/mobile/bottom-nav';
import MobileDrawer from '@/components/workspace/mobile/mobile-drawer';
import { ToastProvider } from '@/components/ui/toast-provider';
import ErrorBoundary from '@/components/ui/error-boundary';

// Overlay-only surfaces: kept out of the initial bundle so first paint
// downloads only what the workspace shell actually needs.
const AgentProfileModal = lazy(() => import('@/components/workspace/modals/agent-profile-modal'));
const WorkspaceSettingsModal = lazy(() => import('@/components/workspace/modals/workspace-settings-modal'));
const OmniSearchModal = lazy(() => import('@/components/workspace/modals/omni-search-modal'));

function SpinnerFallback() {
  return <div className="flex items-center justify-center p-6 text-zinc-500 text-xs font-mono animate-pulse">Loading…</div>;
}

export default function App() {
  const { 
    activeWorkspaceId,
    mobileDrawerLeft,
    mobileDrawerRight,
    setMobileDrawerLeft,
    setMobileDrawerRight,
    fetchWorkspaces
  } = useCrowdOSStore(useShallow(s => ({
    activeWorkspaceId: s.activeWorkspaceId,
    mobileDrawerLeft: s.mobileDrawerLeft,
    mobileDrawerRight: s.mobileDrawerRight,
    setMobileDrawerLeft: s.setMobileDrawerLeft,
    setMobileDrawerRight: s.setMobileDrawerRight,
    fetchWorkspaces: s.fetchWorkspaces,
  })));

  const [searchOpen, setSearchOpen] = useState(false);

  const stableFetchWorkspaces = useCallback(() => { void fetchWorkspaces(); }, [fetchWorkspaces]);
  useEffect(() => {
    stableFetchWorkspaces();
  }, [stableFetchWorkspaces]);

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
          <WorkspacePortal />
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="w-full h-dvh overflow-hidden bg-[#0A0A0B] text-zinc-100 flex flex-col font-sans antialiased" id="crowd-os-root-shell">
        {/* Safe-top inset for notched devices */}
        <div className="h-[env(safe-area-inset-top)] shrink-0 bg-[#0A0A0B] md:hidden" aria-hidden />
        
        {/* 3-Panel Content Area */}
        <div className="flex-1 flex overflow-hidden w-full relative isolate">
          
          {/* Left Sidebar Panel — single responsive mount (deduped, w clamp) */}
          <div className="hidden md:flex shrink-0 h-full w-[clamp(240px,20vw,280px)] border-r border-zinc-900/80">
            <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Sidebar failed to load</div>}>
              <WorkspaceSidebar />
            </ErrorBoundary>
          </div>

          {/* Center Chat Work Area - Desktop/Mobile flow */}
          <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0 bg-[#121214]">
            <ErrorBoundary fallback={<div className="p-6 text-sm text-zinc-400">Chat failed to load</div>}>
              <MainChatArea onOpenSearch={() => setSearchOpen(true)} />
            </ErrorBoundary>
          </div>

          {/* Right Sidebar Panel — single responsive mount */}
          <div className="hidden lg:flex shrink-0 h-full">
            <ErrorBoundary fallback={<div className="p-4 text-xs text-zinc-500">Roster failed to load</div>}>
              <RightSidebar />
            </ErrorBoundary>
          </div>

          {/* Left slide drawer - Mobile/Tablet */}
          <MobileDrawer 
            open={mobileDrawerLeft} 
            onClose={() => setMobileDrawerLeft(false)} 
            side="left"
          >
            <WorkspaceSidebar />
          </MobileDrawer>

          {/* Right slide drawer - Mobile/Tablet */}
          <MobileDrawer 
            open={mobileDrawerRight} 
            onClose={() => setMobileDrawerRight(false)} 
            side="right"
          >
            <RightSidebar />
          </MobileDrawer>

        </div>

        {/* Bottom Nav Panel - Mobile/Tablet only */}
        <BottomNav />

        {/* Globally tracked status dialog modals */}
        <Suspense fallback={<SpinnerFallback />}>
          <AgentProfileModal />
          <WorkspaceSettingsModal />
          <OmniSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>

      </div>
    </ToastProvider>
  );
}

