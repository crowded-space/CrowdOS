import React from 'react';
import { motion, AnimatePresence } from 'motion/react';

const COMMON_EMOJIS = [
  '😀', '😃', '😄', '😁', '🚀', '🔥', '✨', '💡',
  '🤖', '🦅', '🦉', '🐦', '👍', '👏', '🎯', '⚡',
  '🛠️', '⚙️', '📊', '🌐', '🛡️', '🧠', '💻', '🎉'
];

interface EmojiPickerPopoverProps {
  open: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function EmojiPickerPopover({ open, onSelect, onClose }: EmojiPickerPopoverProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.15 }}
          className="absolute bottom-12 right-0 sm:left-8 z-50 bg-[#1E1E22] border border-zinc-800 rounded-2xl shadow-2xl p-3 w-[min(88vw,260px)] select-none"
        >
          <div className="text-[13px] font-medium text-zinc-400 mb-2.5 px-1 flex items-center justify-between">
            <span>Quick Emojis</span>
            <button onClick={onClose} aria-label="Close emoji picker" className="w-6 h-6 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer">✕</button>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {COMMON_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  onSelect(emoji);
                  onClose();
                }}
                className="h-10 w-10 text-[18px] rounded-xl hover:bg-zinc-800 active:bg-zinc-700 flex items-center justify-center transition cursor-pointer focus:outline-none active:scale-95 border border-transparent hover:border-zinc-700"
              >
                {emoji}
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
