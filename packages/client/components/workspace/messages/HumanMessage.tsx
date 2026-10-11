import { useState } from 'react';
import { Pencil, Check, X, History } from 'lucide-react';
import MentionParser from './MentionParser';
import AttachmentsView from './AttachmentsView';
import { Attachment } from '@/types/crowdOs';
import { useCrowdOSStore } from '@/stores/crowdOsStore';

interface HumanMessageProps {
  id?: string;
  authorName: string;
  authorTag?: string;
  content: string;
  timestamp: string;
  attachments?: Attachment[];
  mentions?: string[];
  originalMessageId?: string;
  editedFrom?: string;
  editedAt?: string;
}

export default function HumanMessage({ id, authorName, authorTag, content, timestamp, attachments, mentions, originalMessageId, editedFrom, editedAt }: HumanMessageProps) {
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const editResend = useCrowdOSStore(s => s.editResend);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  function handleSave() {
    if (!id || !draft.trim()) return;
    editResend(id, draft.trim());
    setEditing(false);
  }

  // Provenance (UX S9): edit = new turn, never a silent rewrite. Render the
  // edited-from link only when a real source id is present; otherwise render
  // nothing (honest empty, never a dead link).
  const editedSourceId = originalMessageId || editedFrom || undefined;
  const showEditedFrom = typeof editedSourceId === 'string' && editedSourceId.length > 0;

  function scrollToOriginal() {
    if (!showEditedFrom) return;
    const target = (editedSourceId as string);
    const el = document.querySelector('[data-message-id="' + target + '"]')
      || document.getElementById('grouped-msg-' + target)
      || document.getElementById('message-' + target)
      || document.getElementById(target);
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  return (
    <div 
      id={`human-message-${authorName}`}
      data-message-id={id}
      className="group relative flex gap-3 p-3.5 sm:p-4 border-l-[3px] border-amber-500/90 bg-amber-500/[0.06] rounded-2xl rounded-l-[10px] hover:bg-amber-500/[0.08] transition border-y border-r border-amber-500/10"
    >
      <div className="flex-1 space-y-1.5 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-amber-200 tracking-[-0.01em] text-[13px] sm:text-sm">
            {authorName}
          </span>
          <span className="text-[10px] font-medium bg-amber-500/15 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/20">
            {authorTag || 'Human'}
          </span>
          <span className="text-[11px] text-zinc-500 font-mono ml-auto sm:ml-0">
            {timeStr}
          </span>
          {showEditedFrom && (
            <button
              type="button"
              onClick={scrollToOriginal}
              title="Edited from an earlier message — jump to the original" 
              aria-label="Edited from an earlier message — jump to the original"
              className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400 hover:text-amber-200 underline underline-offset-2 decoration-dotted cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30 rounded"
            >
              <History size={10} aria-hidden="true" />
              <span>Edited from earlier message</span>
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="w-full min-h-[72px] bg-zinc-950 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500/40 resize-none"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button onClick={handleSave} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer">
                <Check size={12} /> Save & Resend
              </button>
              <button onClick={() => { setEditing(false); setDraft(content); }} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold flex items-center gap-1.5 border border-zinc-700 cursor-pointer">
                <X size={12} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="text-[14px] text-zinc-100 leading-[1.6] font-sans overflow-x-auto break-words">
            <MentionParser text={content} />
          </div>
        )}
        
        <AttachmentsView attachments={attachments} />
      </div>

      {!editing && id && (
        <div className="absolute -top-2 right-2 hidden group-hover:flex group-focus-within:flex focus-within:flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-[4px] shadow-lg p-1">
          <button
            onClick={() => setEditing(true)}
            className="w-7 h-7 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30"
            title="Edit and resend"
            aria-label="Edit and resend"
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
