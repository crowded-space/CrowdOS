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
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    // autofocus cancel for safety on danger actions; otherwise confirm
    const t = setTimeout(() => {
      if (isDanger) cancelRef.current?.focus();
      else confirmRef.current?.focus();
    }, 0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      // focus return handled by caller via open state change
    };
  }, [open, onCancel, isDanger]);

  const handleBackdropKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      const focusable = [cancelRef.current, confirmRef.current].filter(Boolean) as HTMLElement[];
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
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div
          role={isDanger ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-description"
          onKeyDown={handleBackdropKeyDown}
          className="fixed inset-0 z-[9990] flex items-center justify-center p-4 font-sans select-none"
        >
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
                  <h3 id="confirm-dialog-title" className="text-sm font-semibold text-zinc-100 tracking-tight font-sans">
                    {title}
                  </h3>
                  <p id="confirm-dialog-description" className="text-xs text-zinc-400 mt-1 leading-normal font-sans">
                    {description}
                  </p>
                </div>
              </div>

              <button
                onClick={onCancel}
                aria-label="Close confirmation dialog"
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-md hover:bg-zinc-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 cursor-pointer shrink-0"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-900">
              <button
                ref={cancelRef}
                type="button"
                onClick={onCancel}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 cursor-pointer"
              >
                {cancelLabel}
              </button>
              <button
                ref={confirmRef}
                type="button"
                onClick={onConfirm}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e0e11] cursor-pointer shadow-sm ${
                  isDanger
                    ? 'bg-rose-600 hover:bg-rose-500 text-white focus-visible:ring-rose-500'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white focus-visible:ring-indigo-500'
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
