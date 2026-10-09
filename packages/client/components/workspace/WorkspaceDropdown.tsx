import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, Settings, Plus, Copy, LogOut, Layers, Hash } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import CrowIcon from '@/components/ui/CrowIcon';
import { useToast } from '@/components/ui/ToastProvider';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useOverlayFocus } from '@/components/ui/use-overlay-focus';

export default function WorkspaceDropdown() {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { showSuccess } = useToast();

  useOverlayFocus(dropdownOpen, menuRef, {
    fallbackFocusSelector: '[aria-label="Open workspace menu"]',
  });
  
  const { 
    workspaces, 
    activeWorkspaceId, 
    setSettingsModalOpen, 
    setWorkspaceSettingsTab,
    leaveWorkspace 
  } = useCrowdOSStore();

  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);

  // Close when clicking outside or pressing Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setDropdownOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, []);

  if (!activeWS) return null;

  return (
    <div className="relative" ref={dropdownRef} id="workspace-dropdown">
      <button
        ref={triggerRef}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        aria-haspopup="menu"
        aria-expanded={dropdownOpen}
        aria-controls="workspace-dropdown-menu"
        aria-label="Open workspace menu"
        className="w-full flex items-center justify-between px-3.5 py-3.5 hover:bg-zinc-900/50 border-b border-zinc-900/80 transition text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:bg-zinc-900/70"
      >
        <div className="flex items-center gap-3 min-w-0">
          <CrowIcon variant={activeWS.icon} className="w-8 h-8 rounded-xl bg-transparent border-0 shadow-sm" iconSize={64} />
          <span className="font-semibold text-zinc-100 text-[14px] truncate tracking-[-0.015em] font-sans">
            {activeWS.name}
          </span>
        </div>
        <span className={`w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center transition ${dropdownOpen ? 'bg-zinc-800 border-zinc-700' : ''}`}>
          <ChevronDown size={14} className={`text-zinc-400 shrink-0 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {/* Accordion dropdown menu option */}
      <AnimatePresence>
      {dropdownOpen && (
        <motion.div 
          ref={menuRef}
          id="workspace-dropdown-menu"
          role="menu"
          initial={{ opacity: 0, scale: 0.95, y: -10 }} 
          animate={{ opacity: 1, scale: 1, y: 0 }} 
          exit={{ opacity: 0, scale: 0.95, y: -10 }} 
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="absolute top-full left-2 right-2 mt-2 bg-[#141416] border border-zinc-800 rounded-lg shadow-2xl z-50 p-2 space-y-1 origin-top"
        >
          <button
            role="menuitem"
            onClick={() => {
              setDropdownOpen(false);
              setWorkspaceSettingsTab('overview');
              setSettingsModalOpen(true);
            }}
            className="w-full flex items-center gap-3 px-3 py-3 min-h-[44px] text-[13px] text-zinc-200 hover:bg-zinc-900 hover:text-white rounded-xl transition text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:bg-zinc-800"
          >
            <span className="w-8 h-8 rounded-lg bg-indigo-500/12 border border-indigo-500/20 flex items-center justify-center shrink-0 text-indigo-400">
              <Settings size={15} aria-hidden="true" />
            </span>
            <span className="font-medium">Workspace Settings</span>
          </button>

          <button
            role="menuitem"
            onClick={() => {
              setDropdownOpen(false);
              setWorkspaceSettingsTab('channels');
              setSettingsModalOpen(true);
            }}
            className="w-full flex items-center gap-3 px-3 py-3 min-h-[44px] text-[13px] text-zinc-200 hover:bg-zinc-900 hover:text-white rounded-xl transition text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:bg-zinc-800"
          >
            <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 text-zinc-400">
              <Layers size={15} aria-hidden="true" />
            </span>
            <span className="font-medium">Create Category</span>
          </button>

          <button
            role="menuitem"
            onClick={() => {
              setDropdownOpen(false);
              navigator.clipboard.writeText(activeWS.id || '');
              showSuccess('Workspace ID Copied', 'ID copied to clipboard.');
            }}
            className="w-full flex items-center gap-3 px-3 py-3 min-h-[44px] text-[13px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 rounded-xl transition text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 active:bg-zinc-800"
          >
            <span className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
              <Copy size={15} aria-hidden="true" />
            </span>
            <span className="font-medium">Copy Workspace ID</span>
          </button>

          <div className="h-px bg-zinc-900 my-1.5 mx-1" />

          <button
            role="menuitem"
            onClick={() => {
              setDropdownOpen(false);
              setLeaveConfirmOpen(true);
            }}
            className="w-full flex items-center gap-3 px-3 py-3 min-h-[44px] text-[13px] text-rose-300 hover:bg-rose-500/10 hover:text-rose-200 rounded-xl transition text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 active:bg-rose-500/15"
          >
            <span className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center shrink-0">
              <LogOut size={15} aria-hidden="true" />
            </span>
            <span className="font-medium">Leave Portal</span>
          </button>
        </motion.div>
      )}
      </AnimatePresence>

      <ConfirmDialog
        open={leaveConfirmOpen}
        title="Leave Workspace?"
        description={`Leave "${activeWS.name}" and return to portal? Your drafts and queued sends stay on this device and are there when you re-enter.`}
        confirmLabel="Leave"
        cancelLabel="Cancel"
        isDanger={true}
        onCancel={() => setLeaveConfirmOpen(false)}
        onConfirm={() => {
          setLeaveConfirmOpen(false);
          leaveWorkspace();
        }}
      />
    </div>
  );
}

