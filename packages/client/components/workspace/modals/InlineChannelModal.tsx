import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Hash, X, Plus } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useToast } from '@/components/ui/ToastProvider';

interface InlineChannelModalProps {
  open: boolean;
  categoryId?: string | null;
  onClose: () => void;
}

export default function InlineChannelModal({ open, categoryId, onClose }: InlineChannelModalProps) {
  const { createChannel, workspaces, activeWorkspaceId } = useCrowdOSStore();
  const { showSuccess, showError } = useToast();

  const activeWS = workspaces.find(w => w.id === activeWorkspaceId);
  const targetCategory = activeWS?.categories.find(c => c.id === categoryId) || activeWS?.categories[0];

  const [channelName, setChannelName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedCatId, setSelectedCatId] = useState(categoryId || targetCategory?.id || '');
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSelectedCatId(categoryId || targetCategory?.id || '');
      // focus first input after animation
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [open, categoryId, targetCategory?.id]);

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

  const formattedName = channelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const isDuplicate = !!formattedName && activeWS ? (
    (activeWS.channels || []).some(c => c.name.toLowerCase() === formattedName) ||
    activeWS.categories.some(cat => cat.channels.some(c => c.name.toLowerCase() === formattedName))
  ) : false;
  const isNameTooShort = formattedName.length > 0 && formattedName.length < 2;
  const isNameTooLong = formattedName.length > 40;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelName.trim() || !formattedName || isDuplicate || isNameTooShort || isNameTooLong) return;

    try {
      const formattedName = channelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      await createChannel(selectedCatId || targetCategory?.id || '', formattedName, description);
      showSuccess('Channel Created', `#${formattedName} is ready for messages.`);
      setChannelName('');
      setDescription('');
      onClose();
    } catch (err) {
      showError('Failed to Create Channel', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="inline-channel-title"
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
            transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
            className="relative w-full max-w-md bg-[#0e0e11] border border-zinc-800 rounded-xl overflow-hidden shadow-2xl p-5 space-y-4 text-left"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Hash size={18} className="text-indigo-400" aria-hidden="true" />
                <h3 id="inline-channel-title" className="text-sm font-semibold text-zinc-100 tracking-tight">
                  Create Channel
                </h3>
              </div>
              <button
                onClick={onClose}
                aria-label="Close create channel dialog"
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-md hover:bg-zinc-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 cursor-pointer"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-3 select-text">
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-zinc-400">
                  Category Location
                </label>
                <select
                  value={selectedCatId || targetCategory?.id || ''}
                  onChange={(e) => setSelectedCatId(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                >
                  {activeWS?.categories.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[12px] font-medium text-zinc-400">
                  Channel Name
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-xs">#</span>
                  <input
                    ref={firstInputRef}
                    type="text"
                    required
                    autoFocus
                    maxLength={40}
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder="new-channel"
                    aria-describedby={isDuplicate ? "inline-channel-duplicate" : undefined}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-7 pr-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[12px] font-medium text-zinc-400">
                  Topic Description (Optional)
                </label>
                <input
                  type="text"
                  value={description}
                  maxLength={120}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Operation parameters and execution logs"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                />
              </div>

              {isDuplicate && channelName.trim() && (
                <div id="inline-channel-duplicate" className="text-[11px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2.5 py-1.5 rounded-lg">
                  A channel named "#{formattedName}" already exists in this workspace.
                </div>
              )}
              {isNameTooShort && channelName.trim() && !isDuplicate && (
                <div className="text-[11px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 rounded-lg">
                  Channel name must be at least 2 characters after formatting.
                </div>
              )}
              {isNameTooLong && (
                <div className="text-[11px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2.5 py-1.5 rounded-lg">
                  Channel name must be 40 characters or fewer.
                </div>
              )}
              {!formattedName && channelName.trim() && !isDuplicate && (
                <div className="text-[11px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2.5 py-1.5 rounded-lg">
                  Channel name must contain at least one letter or number.
                </div>
              )}

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
                  disabled={!channelName.trim() || !formattedName || isDuplicate || isNameTooShort || isNameTooLong}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 disabled:cursor-not-allowed text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 cursor-pointer flex items-center gap-1.5 shadow-sm"
                >
                  <Plus size={13} />
                  <span>Create Channel</span>
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
