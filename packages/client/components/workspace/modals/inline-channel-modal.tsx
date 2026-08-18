import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Hash, X, Plus } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import { useToast } from '@/components/ui/toast-provider';

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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelName.trim()) return;

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
        <div className="fixed inset-0 z-[9990] flex items-center justify-center p-4 font-sans select-none">
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
                <Hash size={18} className="text-indigo-400" />
                <h3 className="text-sm font-semibold text-zinc-100 tracking-tight">
                  Create Channel
                </h3>
              </div>
              <button
                onClick={onClose}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded-md hover:bg-zinc-900 transition focus:outline-none cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-3 select-text">
              <div className="space-y-1">
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-wide">
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
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-wide">
                  Channel Name
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-xs">#</span>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder="new-channel"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-7 pr-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-wide">
                  Topic Description (Optional)
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Operation parameters and execution logs"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-900 select-none">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition focus:outline-none cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!channelName.trim()}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition focus:outline-none cursor-pointer flex items-center gap-1.5 shadow-sm"
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
