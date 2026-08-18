import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, Settings, Plus, Copy, LogOut, Layers, Hash } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import CrowIcon from '@/components/ui/crow-icon';
import { useToast } from '@/components/ui/toast-provider';

export default function WorkspaceDropdown() {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { showSuccess } = useToast();
  
  const { 
    workspaces, 
    activeWorkspaceId, 
    setSettingsModalOpen, 
    setWorkspaceSettingsTab,
    leaveWorkspace 
  } = useCrowdOSStore();

  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!activeWS) return null;

  return (
    <div className="relative" ref={dropdownRef} id="workspace-dropdown">
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="w-full flex items-center justify-between p-3.5 hover:bg-zinc-900/60 border-b border-zinc-900 transition text-left cursor-pointer focus:outline-none"
      >
        <div className="flex items-center gap-2 truncate">
          <CrowIcon variant={activeWS.icon} className="w-7 h-7 rounded bg-transparent border-0" iconSize={65} />
          <span className="font-semibold text-zinc-100 text-[13.5px] truncate tracking-tight font-sans">
            {activeWS.name}
          </span>
        </div>
        <ChevronDown size={14} className="text-zinc-400 shrink-0" />
      </button>

      {/* Accordion dropdown menu option */}
      <AnimatePresence>
      {dropdownOpen && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: -10 }} 
          animate={{ opacity: 1, scale: 1, y: 0 }} 
          exit={{ opacity: 0, scale: 0.95, y: -10 }} 
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="absolute top-full left-2 right-2 mt-1 bg-zinc-950 border border-zinc-900 rounded-lg shadow-xl z-50 p-1.5 space-y-0.5 origin-top"
        >
          <button
            onClick={() => {
              setDropdownOpen(false);
              setWorkspaceSettingsTab('overview');
              setSettingsModalOpen(true);
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-[13px] sm:text-xs text-zinc-300 hover:bg-indigo-500/20 hover:text-indigo-200 rounded-md transition text-left cursor-pointer"
          >
            <Settings size={15} className="shrink-0" />
            <span>Workspace Settings</span>
          </button>

          <button
            onClick={() => {
              setDropdownOpen(false);
              setWorkspaceSettingsTab('channels');
              setSettingsModalOpen(true);
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-[13px] sm:text-xs text-zinc-300 hover:bg-indigo-500/20 hover:text-indigo-200 rounded-md transition text-left cursor-pointer"
          >
            <Layers size={15} className="shrink-0" />
            <span>Create Category</span>
          </button>

          <button
            onClick={() => {
              setDropdownOpen(false);
              navigator.clipboard.writeText(activeWS.id || '');
              showSuccess('Workspace ID Copied', 'ID copied to clipboard.');
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-[13px] sm:text-xs text-[#a1a1aa] hover:bg-zinc-900 rounded-md transition text-left cursor-pointer"
          >
            <Copy size={15} className="shrink-0" />
            <span>Copy Workspace ID</span>
          </button>

          <div className="border-t border-zinc-900 my-1 pointer-events-none" />

          <button
            onClick={() => {
              setDropdownOpen(false);
              leaveWorkspace();
            }}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-[13px] sm:text-xs text-rose-400 hover:bg-rose-500/10 rounded-md transition text-left cursor-pointer"
          >
            <LogOut size={15} className="shrink-0" />
            <span>Leave Space Portal</span>
          </button>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

