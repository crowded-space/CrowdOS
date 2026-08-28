/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import WorkspacePortal from '@/components/portal/WorkspacePortal';
import WorkspaceSidebar from '@/components/workspace/workspace-sidebar';
import MainChatArea from '@/components/workspace/main-chat-area';
import RightSidebar from '@/components/workspace/right-sidebar';
import BottomNav from '@/components/workspace/mobile/bottom-nav';
import MobileDrawer from '@/components/workspace/mobile/mobile-drawer';
import { ToastProvider } from '@/components/ui/toast-provider';

// Overlay-only surfaces: kept out of the initial bundle so first paint
// downloads only what the workspace shell actually needs.
const AgentProfileModal = lazy(() => import('@/components/workspace/modals/agent-profile-modal'));
const WorkspaceSettingsModal = lazy(() => import('@/components/workspace/modals/workspace-settings-modal'));
const OmniSearchModal = lazy(() => import('@/components/workspace/modals/omni-search-modal'));

export default function App() {
  const { 
    activeWorkspaceId,
    mobileDrawerLeft,
    mobileDrawerRight,
    setMobileDrawerLeft,
    setMobileDrawerRight,
    fetchWorkspaces
  } = useCrowdOSStore();

  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    fetchWorkspaces();
  }, []);

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
          
          {/* Left Sidebar Panel - Desktop (fluid 240–280) */}
          <div className="hidden lg:flex shrink-0 h-full w-[260px] xl:w-[280px] border-r border-zinc-900/80">
            <WorkspaceSidebar />
          </div>
          {/* Tablet: collapsible 240 */}
          <div className="hidden md:flex lg:hidden shrink-0 h-full w-[240px] border-r border-zinc-900/60">
            <WorkspaceSidebar />
          </div>

          {/* Center Chat Work Area - Desktop/Mobile flow */}
          <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0 bg-[#121214]">
            <MainChatArea onOpenSearch={() => setSearchOpen(true)} />
          </div>

          {/* Right Sidebar Panel - Desktop: adaptive */}
          <div className="hidden xl:flex shrink-0 h-full">
            <RightSidebar />
          </div>
          <div className="hidden lg:flex xl:hidden shrink-0 h-full">
            <RightSidebar />
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
        <Suspense fallback={null}>
          <AgentProfileModal />
          <WorkspaceSettingsModal />
          <OmniSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>

      </div>
    </ToastProvider>
  );
}

