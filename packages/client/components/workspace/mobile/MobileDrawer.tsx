import React, { useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform, PanInfo } from 'motion/react';
import { X } from 'lucide-react';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  side: 'left' | 'right';
  children: React.ReactNode;
}

export default function MobileDrawer({ open, onClose, side = 'left', children }: MobileDrawerProps) {
  const x = useMotionValue(0);
  const backdropOpacity = useTransform(x, (v) => {
    const progress = Math.abs(v) / 300;
    return 1 - Math.min(progress * 0.8, 0.8);
  });
  const drawerRef = useRef<HTMLDivElement>(null);

  const handleDragEnd = useCallback((_e: any, info: PanInfo) => {
    const threshold = 80;
    const velocityThreshold = 600;
    const shouldClose =
      (side === 'left' && (info.offset.x < -threshold || info.velocity.x < -velocityThreshold)) ||
      (side === 'right' && (info.offset.x > threshold || info.velocity.x > velocityThreshold));
    if (shouldClose) onClose();
    else x.set(0);
  }, [side, onClose, x]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onTabTrap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onEsc);
    window.addEventListener('keydown', onTabTrap);
    const prevOverflow = document.body.style.overflow;
    const prevOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    const root = document.getElementById('crowd-os-root-shell') as HTMLElement | null;
    const prevInert = root?.hasAttribute('inert');
    try { (root as any)?.setAttribute?.('inert', ''); } catch {}
    // focus first focusable
    setTimeout(() => {
      const el = drawerRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      el?.focus();
    }, 180);

    return () => {
      window.removeEventListener('keydown', onEsc);
      window.removeEventListener('keydown', onTabTrap);
      document.body.style.overflow = prevOverflow;
      document.documentElement.style.overscrollBehavior = prevOverscroll;
      if (root && !prevInert) try { (root as any)?.removeAttribute?.('inert'); } catch {}
    };
  }, [open, onClose]);

  // Reset drag position when closed
  useEffect(() => { if (!open) x.set(0); }, [open, x]);

  return (
    <AnimatePresence>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${side} navigation drawer`}
          className="fixed inset-0 z-50 flex lg:hidden isolate"
          id={`mobile-drawer-${side}`}
        >
          {/* Backdrop — tap to close with subtle blur */}
          <motion.div
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            style={{ opacity: backdropOpacity }}
            className="absolute inset-0 bg-[#040405]/72 backdrop-blur-[6px] supports-[backdrop-filter]:bg-black/55"
            aria-hidden
          />

          {/* Drawer panel — draggable to dismiss */}
          <motion.div
            ref={drawerRef}
            drag={side === 'left' ? 'x' : 'x'}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.18}
            dragMomentum={false}
            onDragEnd={handleDragEnd}
            style={{ x }}
            initial={{ x: side === 'left' ? '-100%' : '100%' }}
            animate={{ x: 0 }}
            exit={{ x: side === 'left' ? '-100%' : '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 36, mass: 0.9 }}
            className={`relative w-[min(88vw,340px)] h-[100dvh] h-dvh bg-[#0c0c0f] ${
              side === 'left' ? 'border-r' : 'border-l'
            } border-zinc-900 flex flex-col z-50 shadow-[0_0_40px_rgba(0,0,0,0.6)] will-change-transform`}
          >
            {/* Drag handle for thumb */}
            <div className="absolute top-2 left-1/2 -translate-x-1/2 w-9 h-1 rounded-full bg-white/10 lg:hidden pointer-events-none" />

            {/* Header close */}
            <div className={`absolute top-2 ${side === 'left' ? 'right-2' : 'left-2'} z-[2]`}>
              <button
                onClick={onClose}
                aria-label="Close drawer"
                className="w-11 h-11 bg-zinc-900/80 backdrop-blur hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 rounded-lg flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 cursor-pointer active:scale-[0.96] border border-white/[0.06] touch-manipulation"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="flex-1 overflow-hidden h-full pt-1">
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
