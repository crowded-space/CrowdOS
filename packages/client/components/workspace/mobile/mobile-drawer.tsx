import React from 'react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import { X } from 'lucide-react';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  side: 'left' | 'right';
  children: React.ReactNode;
}

export default function MobileDrawer({ open, onClose, side = 'left', children }: MobileDrawerProps) {
  if (!open) return null;

  const translationStyle = side === 'left' 
    ? 'left-0 translate-x-0 animate-slide-in-left' 
    : 'right-0 translate-x-0 animate-slide-in-right';

  return (
    <div className="fixed inset-0 z-50 flex md:hidden" id={`mobile-drawer-${side}`}>
      {/* Tap backdrop to close */}
      <div 
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-xs transition-opacity" 
      />

      {/* Drawer content board */}
      <div className={`relative w-[245px] h-full bg-[#0c0c0e] border-zinc-900 border-r flex flex-col z-50 transition-transform duration-300 ${translationStyle}`}>
        {/* Header option button to close */}
        <div className="absolute top-2.5 right-2 px-1 z-55">
          <button
            onClick={onClose}
            className="w-6 h-6 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100 rounded-full flex items-center justify-center transition focus:outline-none cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-hidden h-full">
          {children}
        </div>
      </div>
    </div>
  );
}
