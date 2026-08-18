import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDanger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  isDanger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[9990] flex items-center justify-center p-4 font-sans select-none">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />

          {/* Modal Container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
            className="relative w-full max-w-sm bg-[#0e0e11] border border-zinc-800 rounded-xl overflow-hidden shadow-2xl p-5 space-y-4 text-left"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                  isDanger ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                }`}>
                  <AlertTriangle size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100 tracking-tight font-sans">
                    {title}
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1 leading-normal font-sans">
                    {description}
                  </p>
                </div>
              </div>

              <button
                onClick={onCancel}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-md hover:bg-zinc-900 transition focus:outline-none cursor-pointer shrink-0"
              >
                <X size={14} />
              </button>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-900">
              <button
                type="button"
                onClick={onCancel}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition focus:outline-none cursor-pointer"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition focus:outline-none cursor-pointer shadow-sm ${
                  isDanger
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                }`}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
