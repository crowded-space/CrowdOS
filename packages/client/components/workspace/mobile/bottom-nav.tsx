import { Hash, MessageSquare, Sparkles, Settings2 } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';

export default function BottomNav() {
  const { 
    setMobileDrawerLeft, 
    setMobileDrawerRight, 
    setSettingsModalOpen, 
    setWorkspaceSettingsTab,
    mobileDrawerLeft,
    mobileDrawerRight
  } = useCrowdOSStore();

  return (
    <div 
      id="bottom-nav"
      className="md:hidden pb-[env(safe-area-inset-bottom)] bg-[#09090b]/85 backdrop-blur-3xl border-t border-white/5 w-full flex items-center shrink-0 select-none z-40 sticky bottom-0"
    >
      <button
        onClick={() => setMobileDrawerLeft(true)}
        className={`flex-1 flex flex-col items-center justify-center gap-1 transition focus:outline-none cursor-pointer py-3 ${mobileDrawerLeft ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-200'}`}
        title="Channels"
      >
        <Hash size={20} strokeWidth={mobileDrawerLeft ? 2.5 : 2} />
        <span className="text-[10px] font-medium tracking-wide">Channels</span>
      </button>

      <div className="w-[1px] h-8 bg-zinc-900/50 shrink-0 pointer-events-none" />

      <button
        onClick={() => setMobileDrawerRight(true)}
        className={`flex-1 flex flex-col items-center justify-center gap-1 transition focus:outline-none cursor-pointer py-3 ${mobileDrawerRight ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-200'}`}
        title="Agent Swarm"
      >
        <Sparkles size={20} strokeWidth={mobileDrawerRight ? 2.5 : 2} />
        <span className="text-[10px] font-medium tracking-wide">Agents</span>
      </button>

      <div className="w-[1px] h-8 bg-zinc-900/50 shrink-0 pointer-events-none" />

      <button
        onClick={() => {
          setWorkspaceSettingsTab('overview');
          setSettingsModalOpen(true);
        }}
        className="flex-1 flex flex-col items-center justify-center gap-1 text-zinc-500 hover:text-zinc-200 transition focus:outline-none cursor-pointer py-3"
        title="Settings"
      >
        <Settings2 size={20} />
        <span className="text-[10px] font-medium tracking-wide">Settings</span>
      </button>
    </div>
  );
}
