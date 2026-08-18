/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import WorkspacePortal from '@/components/portal/WorkspacePortal';
import WorkspaceSidebar from '@/components/workspace/workspace-sidebar';
import MainChatArea from '@/components/workspace/main-chat-area';
import RightSidebar from '@/components/workspace/right-sidebar';
import BottomNav from '@/components/workspace/mobile/bottom-nav';
import MobileDrawer from '@/components/workspace/mobile/mobile-drawer';
import AgentProfileModal from '@/components/workspace/modals/agent-profile-modal';
import WorkspaceSettingsModal from '@/components/workspace/modals/workspace-settings-modal';
import OmniSearchModal from '@/components/workspace/modals/omni-search-modal';
import { ToastProvider } from '@/components/ui/toast-provider';

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

  // Onboarding Portal Gate
  if (!activeWorkspaceId) {
    return (
      <ToastProvider>
        <div className="w-screen h-screen bg-[#060608] text-zinc-100 flex items-center justify-center">
          <WorkspacePortal />
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="w-screen h-screen overflow-hidden bg-[#0c0c0e] text-zinc-100 flex flex-col font-sans" id="crowd-os-root-shell">
        
        {/* 3-Panel Content Area */}
        <div className="flex-1 flex overflow-hidden w-full relative">
          
          {/* Left Sidebar Panel - Desktop */}
          <div className="hidden md:flex shrink-0 h-full w-[245px]">
            <WorkspaceSidebar />
          </div>

          {/* Center Chat Work Area - Desktop/Mobile flow */}
          <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
            <MainChatArea onOpenSearch={() => setSearchOpen(true)} />
          </div>

          {/* Right Sidebar Panel - Desktop */}
          <div className="hidden md:flex shrink-0 h-full">
            <RightSidebar />
          </div>

          {/* Left slide drawer - Mobile */}
          <MobileDrawer 
            open={mobileDrawerLeft} 
            onClose={() => setMobileDrawerLeft(false)} 
            side="left"
          >
            <WorkspaceSidebar />
          </MobileDrawer>

          {/* Right slide drawer - Mobile */}
          <MobileDrawer 
            open={mobileDrawerRight} 
            onClose={() => setMobileDrawerRight(false)} 
            side="right"
          >
            <RightSidebar />
          </MobileDrawer>

        </div>

        {/* Bottom Nav Panel - Mobile */}
        <BottomNav />

        {/* Globally tracked status dialog modals */}
        <AgentProfileModal />
        <WorkspaceSettingsModal />
        <OmniSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />

      </div>
    </ToastProvider>
  );
}

