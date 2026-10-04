/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent as ReactChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Maximize2, Sparkles, X } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { useOverlayFocus } from '@/components/ui/use-overlay-focus';
import { useToast } from '@/components/ui/ToastProvider';
import { shortPath } from './composer-preflight-model';
import { loadOperatorProfile } from './operator-profile-model';
import { sourceHint, sourceLabel } from './explorer-model';
interface quickAskProps {
  open: boolean;
  onClose: () => void;
}
const MAX_MESSAGE_LEN = 4000;
export default function QuickAsk({ open, onClose }: quickAskProps) {
  const { workspaces, activeWorkspaceId, activeChannelId, agents, selectedMode, draftByChannel, addMessage, queueSend, setDraft } = useCrowdOSStore();
  const { showInfo, showError } = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [shown, setShown] = useState(false);
  useOverlayFocus(open, dialogRef, { initialFocusRef: inputRef, fallbackFocusSelector: 'textarea[aria-label^="Message"]' });
  useEffect(() => {
    if (!open) { setShown(false); return; }
    setShown(false);
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)); });
    return () => { cancelAnimationFrame(first); if (second) cancelAnimationFrame(second); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const allChannels = [...(ws?.channels || []), ...(ws?.categories.flatMap((cat) => cat.channels) || [])];
  const activeChannel = allChannels.find((c) => c.id === activeChannelId) || null;
  const l0Agent = agents.find((a) => a.level === 0) || null;
  const mountSnapshot = activeChannelId ? draftByChannel[activeChannelId]?.mountSnapshot || null : null;
  const mountShort = shortPath(mountSnapshot?.path);
  const mountText = mountShort ? mountShort + ' (' + sourceLabel(mountSnapshot?.source) + ')' : '—';
  const scopeLine = activeChannel ? 'Answers land in #' + activeChannel.name : 'No active channel';
  const focusMainComposer = () => {
    requestAnimationFrame(() => {
      const el = document.querySelector('textarea[aria-label^="Message"]') as HTMLTextAreaElement | null;
      if (el) el.focus();
    });
  };
  const handleExpand = () => {
    if (activeChannelId && text.trim()) { try { setDraft(activeChannelId, { text: text.slice(0, MAX_MESSAGE_LEN) }); } catch { /* best-effort */ } }
    onClose();
    focusMainComposer();
  };
  const handleAsk = () => {
    if (sending || !activeChannelId) return;
    const body = text.trim();
    if (!body && !l0Agent) return;
    let finalContent = body;
    if (finalContent.length > MAX_MESSAGE_LEN) { finalContent = finalContent.slice(0, MAX_MESSAGE_LEN); showError('Message Truncated', 'Content limited to ' + MAX_MESSAGE_LEN + ' characters.'); }
    if (l0Agent) { const prefix = '@' + l0Agent.name; finalContent = finalContent ? prefix + ' ' + finalContent : prefix; }
    if (finalContent.length > MAX_MESSAGE_LEN) { finalContent = finalContent.slice(0, MAX_MESSAGE_LEN); showError('Message Truncated', 'Content limited to ' + MAX_MESSAGE_LEN + ' characters.'); }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      queueSend({ channelId: activeChannelId, content: finalContent, mentionIds: l0Agent ? [l0Agent.id] : [], runtimeMode: selectedMode });
      showInfo('Queued offline', 'Will send on reconnect.');
      return;
    }
    setSending(true);
    addMessage({ type: 'human', content: finalContent, authorId: 'local-operator', authorName: loadOperatorProfile().name || 'Local operator', channelId: activeChannelId, mentions: l0Agent ? [l0Agent.name] : undefined, mode: selectedMode, runtimeMode: selectedMode } as any);
    setText('');
    onClose();
    setTimeout(() => setSending(false), 600);
  };
  const handleChange = (e: ReactChangeEvent<HTMLTextAreaElement>) => {
    let val = e.target.value;
    if (val.length > MAX_MESSAGE_LEN) { val = val.slice(0, MAX_MESSAGE_LEN); showError('Message Too Long', 'Truncated to ' + MAX_MESSAGE_LEN + ' characters.'); }
    setText(val);
  };
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); handleExpand(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  if (!open) return null;
  const canAsk = !!activeChannelId && !sending && (!!text.trim() || !!l0Agent);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Quick ask" className={'fixed bottom-4 right-4 left-4 sm:left-auto sm:w-[380px] z-[9980] font-sans select-none transition-opacity duration-150 motion-reduce:transition-none ' + (shown ? 'opacity-100' : 'opacity-0')}>
      <div className="rounded-xl border border-zinc-800 bg-[#141416] shadow-[0_24px_64px_rgba(10,14,32,0.6)] flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800 bg-zinc-950/60">
          <span className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
            <Sparkles size={16} className="text-indigo-300" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-zinc-100 truncate">Quick ask</p>
            <p className="text-[11px] font-mono text-zinc-500 truncate">{scopeLine} · {selectedMode}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close quick ask" className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 flex items-center justify-center transition focus:outline-none cursor-pointer shrink-0 active:scale-95">
            <X size={15} />
          </button>
        </div>
        <div className="px-3 pt-2.5 space-y-1.5">
          <p className="text-[11px] font-mono text-zinc-500" title={sourceHint(mountSnapshot?.source)}>Via {l0Agent ? '@' + l0Agent.name : 'no L0 agent — posts without a mention'} · Can touch: mount {mountText}</p>
          {!activeChannelId && (<p role="status" className="text-xs text-amber-300">Open a channel first — quick ask has nowhere to land.</p>)}
        </div>
        <div className="p-3">
          <textarea ref={inputRef} rows={3} value={text} onChange={handleChange} onKeyDown={handleKeyDown} maxLength={MAX_MESSAGE_LEN} disabled={!activeChannelId} aria-label="Quick ask message" placeholder={l0Agent ? 'Ask @' + l0Agent.name + '...' : 'Ask in this channel...'} className="w-full bg-zinc-950/60 border border-zinc-800 rounded-xl text-[14px] text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/40 resize-none px-3 py-2.5 leading-[1.5] min-h-[76px] max-h-[160px] overflow-y-auto scrollbar-thin select-text disabled:cursor-not-allowed disabled:opacity-50" />
          {text.length > 3000 && (<div className="pt-1 text-right"><span className={'text-[10px] font-mono ' + (text.length > 3800 ? 'text-rose-400' : text.length > 3200 ? 'text-amber-400' : 'text-zinc-500')}>{text.length}/{MAX_MESSAGE_LEN}</span></div>)}
          <div className="flex items-center gap-2 pt-2">
            <button type="button" onClick={handleAsk} disabled={!canAsk} className="flex-1 min-h-[44px] px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-white text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99] cursor-pointer">{sending ? 'Asking...' : 'Ask in place'}</button>
            <button type="button" onClick={handleExpand} disabled={!activeChannelId} title="Open the full composer" aria-label="Expand to full window" className="min-h-[44px] px-3 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.99] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-1.5"><Maximize2 size={14} /> Full</button>
          </div>
          <p className="pt-2 text-[10px] font-mono text-zinc-600">Enter asks in place · Shift+Enter opens the full window</p>
        </div>
      </div>
    </div>
  );
}
