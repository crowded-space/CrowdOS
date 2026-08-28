import { Hash, Sparkles, Settings2 } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';

export default function BottomNav() {
  const {
    workspaces,
    activeWorkspaceId,
    setMobileDrawerLeft,
    setMobileDrawerRight,
    setSettingsModalOpen,
    setWorkspaceSettingsTab,
    mobileDrawerLeft,
    mobileDrawerRight
  } = useCrowdOSStore();

  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);
  const channels = [
    ...(activeWS?.channels || []),
    ...(activeWS?.categories.flatMap(cat => cat.channels) || [])
  ];
  const totalUnread = channels.reduce((acc, c) => acc + (c.unreadCount || 0), 0);
  const hasMention = channels.some(c => c.hasMention);

  const haptic = () => {
    try { (navigator as any)?.vibrate?.(8); } catch {}
  };

  const NavButton = ({
    active,
    onClick,
    label,
    sublabel,
    icon,
    badge,
  }: {
    active?: boolean;
    onClick: () => void;
    label: string;
    sublabel?: string;
    icon: React.ReactNode;
    badge?: React.ReactNode;
  }) => (
    <button
      onClick={() => { haptic(); onClick(); }}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[62px] transition-all active:scale-[0.97] focus:outline-none select-none touch-manipulation ${
        active
          ? 'text-indigo-400'
          : 'text-zinc-500 active:text-zinc-300 hover:text-zinc-300'
      }`}
    >
      {active && (
        <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2.5px] rounded-full bg-indigo-400 shadow-[0_2px_8px_rgba(99,102,241,0.6)]" />
      )}
      <span className={`relative flex items-center justify-center w-9 h-7 rounded-xl transition-colors ${active ? 'bg-indigo-500/12' : 'bg-transparent'}`}>
        {icon}
        {badge}
      </span>
      <span className={`text-[10px] tracking-[0.02em] leading-none ${active ? 'font-semibold' : 'font-medium'}`}>{sublabel || label}</span>
    </button>
  );

  return (
    <nav
      id="bottom-nav"
      aria-label="Primary"
      className="lg:hidden pb-[env(safe-area-inset-bottom)] bg-[#0A0A0B]/92 backdrop-blur-2xl border-t border-white/[0.07] w-full flex items-stretch shrink-0 select-none z-40 supports-[backdrop-filter]:bg-[#08080a]/80 shadow-[0_-8px_24px_rgba(0,0,0,0.35)]"
    >
      <NavButton
        active={mobileDrawerLeft}
        onClick={() => setMobileDrawerLeft(true)}
        label={`Channels${totalUnread > 0 ? `, ${totalUnread} unread` : ''}${hasMention ? ', mentions' : ''}`}
        sublabel="Channels"
        icon={<Hash size={20} strokeWidth={mobileDrawerLeft ? 2.5 : 2} />}
        badge={
          (hasMention || totalUnread > 0) ? (
            <span
              className={`absolute -top-0.5 -right-1 rounded-full flex items-center justify-center font-mono font-bold text-white shadow-md border border-[#0A0A0B] ${
                hasMention
                  ? 'w-[10px] h-[10px] bg-rose-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]'
                  : 'min-w-[16px] h-[16px] px-0.5 bg-rose-500 text-[9px]'
              }`}
            >
              {!hasMention && totalUnread > 99 ? '99+' : !hasMention && totalUnread > 0 ? String(Math.min(totalUnread, 99)) : ''}
            </span>
          ) : undefined
        }
      />

      <NavButton
        active={mobileDrawerRight}
        onClick={() => setMobileDrawerRight(true)}
        label="Agent roster"
        sublabel="Agents"
        icon={<Sparkles size={20} strokeWidth={mobileDrawerRight ? 2.5 : 2} />}
      />

      <NavButton
        onClick={() => {
          setWorkspaceSettingsTab('overview');
          setSettingsModalOpen(true);
        }}
        label="Settings"
        sublabel="Settings"
        icon={<Settings2 size={20} strokeWidth={2} />}
      />
    </nav>
  );
}
