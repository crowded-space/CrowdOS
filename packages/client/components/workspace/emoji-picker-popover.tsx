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
          className="absolute bottom-12 left-8 z-50 bg-[#141416] border border-zinc-800 rounded-xl shadow-2xl p-2.5 w-64 select-none"
        >
          <div className="text-[10px] font-mono font-bold text-zinc-500 mb-2 px-1 uppercase tracking-wider">
            Quick Emojis
          </div>
          <div className="grid grid-cols-6 gap-1">
            {COMMON_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  onSelect(emoji);
                  onClose();
                }}
                className="h-8 w-8 text-base rounded-md hover:bg-zinc-800 flex items-center justify-center transition cursor-pointer focus:outline-none"
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
