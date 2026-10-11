import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { User, X } from 'lucide-react';
import { useToast } from '@/components/ui/ToastProvider';
import { useOverlayFocus } from '@/components/ui/use-overlay-focus';
import {
  loadOperatorProfile,
  saveOperatorProfile,
  OPERATOR_DEFAULT_NAME,
  OPERATOR_DEFAULT_TAG,
  OPERATOR_MAX_NAME,
  OPERATOR_MAX_TAG,
  OPERATOR_MAX_PREFERENCE,
} from '../operator-profile-model';

interface OperatorProfileModalProps {
  open: boolean;
  onClose: () => void;
}

export default function OperatorProfileModal({ open, onClose }: OperatorProfileModalProps) {
  const { showSuccess } = useToast();
  const [name, setName] = useState(OPERATOR_DEFAULT_NAME);
  const [tag, setTag] = useState(OPERATOR_DEFAULT_TAG);
  const [preference, setPreference] = useState('');
  const firstInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useOverlayFocus(open, dialogRef, { initialFocusRef: firstInputRef });

  useEffect(() => {
    if (!open) return;
    const current = loadOperatorProfile();
    setName(current.name);
    setTag(current.tag);
    setPreference(current.preference ?? '');
    setTimeout(() => firstInputRef.current?.focus(), 50);
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onEsc);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onEsc);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    saveOperatorProfile({ name, tag, preference: preference.trim() ? preference : null });
    showSuccess('Profile Saved', 'Your operator identity now heads every message you send.');
    onClose();
  }

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="operator-profile-title"
          className="fixed inset-0 z-[9990] flex items-center justify-center p-4 font-sans select-none"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0.1 }}
            className="relative w-full max-w-md bg-[#0e0e11] border border-zinc-800 rounded-xl overflow-hidden shadow-2xl p-5 space-y-4 text-left"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <User size={18} className="text-amber-400" aria-hidden="true" />
                <h3 id="operator-profile-title" className="text-sm font-semibold text-zinc-100 tracking-tight">
                  User Profile
                </h3>
              </div>
              <button
                onClick={onClose}
                aria-label="Close user profile dialog"
                className="w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-300 rounded-md hover:bg-zinc-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 cursor-pointer"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-3 select-text">
              <div className="space-y-1">
                <label htmlFor="operator-profile-name" className="text-[12px] font-medium text-zinc-400">
                  Username
                </label>
                <input
                  ref={firstInputRef}
                  id="operator-profile-name"
                  type="text"
                  required
                  maxLength={OPERATOR_MAX_NAME}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={OPERATOR_DEFAULT_NAME}
                  autoComplete="off"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="operator-profile-tag" className="text-[12px] font-medium text-zinc-400">
                  User tag
                </label>
                <input
                  id="operator-profile-tag"
                  type="text"
                  required
                  maxLength={OPERATOR_MAX_TAG}
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  placeholder={OPERATOR_DEFAULT_TAG}
                  autoComplete="off"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                />
                <p className="text-[10px] font-mono text-zinc-600">Badge shown beside your name on every message.</p>
              </div>

              <div className="space-y-1">
                <label htmlFor="operator-profile-preference" className="text-[12px] font-medium text-zinc-400">
                  User preference <span className="text-zinc-600">(optional)</span>
                </label>
                <textarea
                  id="operator-profile-preference"
                  value={preference}
                  maxLength={OPERATOR_MAX_PREFERENCE}
                  onChange={(e) => setPreference(e.target.value)}
                  placeholder="e.g. Prefer concise answers with code examples."
                  rows={3}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 resize-none"
                />
                <p className="text-[10px] font-mono text-zinc-600">Injected into agent context when set; empty means nothing is injected.</p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-900 select-none">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || !tag.trim()}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 cursor-pointer shadow-sm"
                >
                  Save
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
