import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, MessageCircle, Bot, Terminal, Telescope, Network, Pin, Check, ChevronDown } from 'lucide-react';
import type { ComposerMode } from '../../types/crowdOs';

export interface ModeSelectorProps {
  value: ComposerMode;
  onChange: (mode: ComposerMode) => void;
  isPinned: boolean;
  onTogglePin: () => void;
  disabled?: boolean;
}

interface ModeOption {
  id: ComposerMode;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  accentColor: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { id: 'auto', label: 'Auto', description: 'Automatic runtime routing', icon: Sparkles, accentColor: 'text-amber-400' },
  { id: 'chat', label: 'Chat', description: 'Fast conversational', icon: MessageCircle, accentColor: 'text-sky-400' },
  { id: 'agentic', label: 'Agentic', description: 'Autonomous tool use', icon: Bot, accentColor: 'text-emerald-400' },
  { id: 'coding', label: 'Coding', description: 'Code execution and tools', icon: Terminal, accentColor: 'text-violet-400' },
  { id: 'research', label: 'Research', description: 'Deep research and analysis', icon: Telescope, accentColor: 'text-fuchsia-400' },
  // §22: Swarm is one of the five runtimes, so it is user-selectable — not
  // reachable only through the Router.
  { id: 'swarm', label: 'Swarm', description: 'Large data · L3 worker delegation', icon: Network, accentColor: 'text-rose-400' }
];

export default function ModeSelector({ value, onChange, isPinned, onTogglePin, disabled = false }: ModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentOption = MODE_OPTIONS.find((opt) => opt.id === value) || MODE_OPTIONS[0];
  const CurrentIcon = currentOption.icon;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Keyboard support: Escape closes; arrows cycle through modes
  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setIsOpen(true);
      return;
    }
    if (!isOpen) return;
    const currentIndex = MODE_OPTIONS.findIndex((opt) => opt.id === value);
    if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(MODE_OPTIONS[(currentIndex + 1) % MODE_OPTIONS.length].id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(MODE_OPTIONS[(currentIndex - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length].id);
    }
  };

  const triggerClass = [
    'flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium transition cursor-pointer select-none focus:outline-none border active:scale-[0.97]',
    isOpen ? 'bg-zinc-800 text-white border-zinc-700 shadow-sm' : 'bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 hover:text-white',
    disabled ? 'opacity-50 cursor-not-allowed' : ''
  ].filter(Boolean).join(' ');

  const pinClass = [
    'p-2.5 rounded-xl transition cursor-pointer select-none focus:outline-none border active:scale-95',
    isPinned ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/25' : 'bg-zinc-800 text-zinc-500 border-zinc-700 hover:text-zinc-300 hover:bg-zinc-700',
    disabled ? 'opacity-50 cursor-not-allowed' : ''
  ].filter(Boolean).join(' ');

  return (
    <div className="relative inline-flex items-center gap-1" ref={dropdownRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={triggerClass + ' min-h-[42px]'}
        title={'Execution mode: ' + currentOption.label}
      >
        <CurrentIcon size={15} className={currentOption.accentColor} aria-hidden="true" />
        <span className="sr-only">Execution mode: </span>
        <span>{currentOption.label}</span>
        <ChevronDown size={13} className={'text-zinc-500 transition-transform ' + (isOpen ? 'rotate-180' : '')} aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onTogglePin}
        aria-pressed={isPinned}
        className={pinClass + ' w-11 h-11 sm:w-10 sm:h-[42px] flex items-center justify-center shrink-0'}
        // §6: the pin belongs to THIS channel, not the browser.
        title={isPinned ? 'Mode pinned for this channel. Click to unpin.' : 'Pin mode for this channel'}
        aria-label={isPinned ? 'Mode pinned for this channel. Click to unpin.' : 'Pin mode for this channel'}
      >
        <Pin size={14} className={isPinned ? 'fill-indigo-400' : ''} aria-hidden="true" />
      </button>
      {isOpen && (
        <div
          className="absolute bottom-full mb-1.5 right-0 z-50 w-56 bg-[#18181b] border border-zinc-800/90 rounded-xl shadow-2xl py-1.5 px-1 animate-scale-in text-zinc-200 select-none"
          role="listbox"
          aria-label="Execution mode"
        >
          <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 border-b border-zinc-800/60 mb-1">
            Execution Mode
          </div>
          {MODE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const isSelected = opt.id === value;
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.id);
                  setIsOpen(false);
                }}
                className={
                  'w-full flex items-center justify-between px-2.5 py-2 min-h-[42px] rounded-lg text-left text-xs transition-colors cursor-pointer focus:outline-none focus-visible:bg-zinc-800/80 ' +
                  (isSelected ? 'bg-indigo-500/15 text-indigo-200 font-medium' : 'text-zinc-300 hover:bg-zinc-800/80 hover:text-white')
                }
              >
                <div className="flex items-center gap-2.5">
                  <Icon size={15} className={opt.accentColor} />
                  <div>
                    <div className="font-medium leading-none text-[12px]">{opt.label}</div>
                    <div className="text-[10px] text-zinc-400 mt-0.5">{opt.description}</div>
                  </div>
                </div>
                {isSelected && <Check size={14} className="text-indigo-400 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
