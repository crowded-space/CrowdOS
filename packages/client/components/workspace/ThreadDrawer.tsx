import { useEffect, useState } from 'react';
import { MessageSquare, X, Clock, Archive, Plus, Send } from 'lucide-react';
import { socket } from '@/src/config/socket';

interface Thread {
  id: string;
  channelId: string;
  title: string | null;
  isEphemeral: boolean;
  status: string;
  expiresAt: string | null;
  messageCount: number;
  lastActivityAt: string;
}

interface Props {
  channelId: string | null;
  open: boolean;
  onClose: () => void;
  onOpenThread?: (threadId: string) => void;
}

interface ThreadMessage {
  id: string;
  authorName: string;
  authorType: string;
  content: string;
  timestamp: string;
}

export default function ThreadDrawer({ channelId, open, onClose, onOpenThread }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadInput, setThreadInput] = useState('');
  const [threadSending, setThreadSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchThreads() {
    if (!channelId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${channelId}/threads`);
      if (!res.ok) throw new Error('Failed to load threads.');
      const data = await res.json();
      setThreads(data.threads ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load threads.');
    }
    setLoading(false);
  }

  useEffect(() => { if (open) fetchThreads(); }, [channelId, open]);

  useEffect(() => {
    setSelectedThread(null);
    setThreadMessages([]);
    setThreadInput('');
    setError(null);
  }, [channelId]);

  useEffect(() => {
    if (!selectedThread) return;
    const handleThreadMessage = (raw: any) => {
      const message = raw?.payload ?? raw;
      if (!message || message.threadId !== selectedThread.id) return;
      setThreadMessages(prev => prev.some(existing => existing.id === message.id)
        ? prev
        : [...prev, {
            id: message.id,
            authorName: message.authorName || 'User',
            authorType: message.authorType || 'user',
            content: message.content || '',
            timestamp: message.timestamp,
          }]);
    };
    socket.on('message:new', handleThreadMessage as any);
    return () => { socket.off('message:new', handleThreadMessage as any); };
  }, [selectedThread]);

  async function openThread(thread: Thread) {
    setSelectedThread(thread);
    setThreadLoading(true);
    setError(null);
    onOpenThread?.(thread.id);
    try { socket.emit('thread:join' as any, { threadId: thread.id }); } catch {}
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(thread.id)}/messages`);
      if (!res.ok) throw new Error('Failed to load thread messages.');
      const data = await res.json();
      setThreadMessages((data.messages ?? []).map((message: any) => ({
        id: message.id,
        authorName: message.authorName || 'User',
        authorType: message.authorType || 'user',
        content: message.content || '',
        timestamp: message.timestamp,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thread messages.');
    } finally {
      setThreadLoading(false);
    }
  }

  async function createThread() {
    if (!channelId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${channelId}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle || null, createdBy: 'local-user', isEphemeral: true, ttlHours: 24 }),
      });
      if (!res.ok) throw new Error('Failed to create thread.');
      const created = await res.json();
      setNewTitle('');
      await fetchThreads();
      if (created?.id) await openThread(created as Thread);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create thread.');
    } finally { setCreating(false); }
  }

  async function sendThreadMessage() {
    const content = threadInput.trim();
    if (!selectedThread || !content || threadSending) return;
    setThreadSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(selectedThread.id)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, authorId: 'local-user', authorName: 'User' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to send thread message.');
      }
      const message = await res.json();
      setThreadMessages(prev => prev.some(existing => existing.id === message.id)
        ? prev
        : [...prev, {
            id: message.id,
            authorName: message.authorName || 'User',
            authorType: message.authorType || 'user',
            content: message.content || content,
            timestamp: message.timestamp,
          }]);
      setThreadInput('');
      setThreads(prev => prev.map(thread => thread.id === selectedThread.id
        ? { ...thread, messageCount: thread.messageCount + 1, lastActivityAt: message.timestamp || new Date().toISOString() }
        : thread));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send thread message.');
    } finally {
      setThreadSending(false);
    }
  }

  if (!open) return null;

  return (
    <div className="w-[320px] shrink-0 border-l border-zinc-900 bg-[#0A0A0B] flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-3 border-b border-zinc-900">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <MessageSquare size={14} className="text-indigo-400" />
          {selectedThread ? (
            <button onClick={() => { setSelectedThread(null); setThreadMessages([]); setError(null); }} className="text-indigo-300 hover:text-indigo-200">Threads</button>
          ) : 'Threads'}
          <span className="text-[11px] bg-zinc-900 border border-zinc-800 rounded-full px-1.5 py-0.5 text-zinc-500">{threads.length}</span>
        </div>
        <button onClick={onClose} aria-label="Close threads" className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 hover:bg-zinc-800"><X size={12} /></button>
      </div>

      {!selectedThread ? (
        <div className="p-3 border-b border-zinc-900 space-y-2">
          <p className="text-[11px] text-zinc-500">Temporary sub-sessions under the current channel. Open a thread to read and send messages.</p>
          <div className="flex gap-2">
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New thread title (optional)" className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none" />
            <button onClick={() => void createThread()} disabled={creating || !channelId} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"><Plus size={12} /> New</button>
          </div>
        </div>
      ) : (
        <div className="p-3 border-b border-zinc-900 space-y-1">
          <div className="text-xs font-semibold text-zinc-200 truncate">{selectedThread.title || `Thread ${selectedThread.id.slice(0, 8)}`}</div>
          <div className="text-[11px] text-zinc-500">Ephemeral thread · expires {selectedThread.expiresAt ? new Date(selectedThread.expiresAt).toLocaleString() : 'never'}</div>
        </div>
      )}

      {error && <div role="alert" className="mx-3 mt-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">{error}</div>}

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {!selectedThread && loading && <div className="text-xs text-zinc-500 p-3">Loading threads…</div>}
        {!selectedThread && !loading && threads.length === 0 && <div className="text-xs text-zinc-600 p-3 text-center">No threads yet. Create one above.</div>}
        {!selectedThread && threads.map((t) => (
          <button type="button" key={t.id} onClick={() => void openThread(t)} className="w-full text-left p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition cursor-pointer">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
              <span className={`w-2 h-2 rounded-full ${t.status === 'active' ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
              <span className="truncate flex-1">{t.title || `Thread ${t.id.slice(0, 8)}`}</span>
              {t.isEphemeral && <span className="text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/20 rounded-full px-1.5 py-0.5">ephemeral</span>}
            </div>
            <div className="flex items-center gap-2 mt-1.5 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1"><MessageSquare size={10} /> {t.messageCount}</span>
              <span className="flex items-center gap-1"><Clock size={10} /> {t.expiresAt ? `expires ${new Date(t.expiresAt).toLocaleTimeString()}` : 'no expiry'}</span>
              {t.status === 'archived' && <span className="flex items-center gap-1 text-zinc-600"><Archive size={10} /> archived</span>}
            </div>
            <div className="text-[10px] text-zinc-600 truncate">{t.id}</div>
          </button>
        ))}
        {selectedThread && threadLoading && <div className="text-xs text-zinc-500 p-3">Loading messages…</div>}
        {selectedThread && !threadLoading && threadMessages.length === 0 && <div className="text-xs text-zinc-600 p-3 text-center">No messages yet. Send the first one below.</div>}
        {selectedThread && threadMessages.map(message => (
          <div key={message.id} className="p-2.5 rounded-xl border border-zinc-900 bg-zinc-950/60">
            <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
              <span className="font-medium text-zinc-300">{message.authorName}</span>
              <time dateTime={message.timestamp}>{message.timestamp ? new Date(message.timestamp).toLocaleTimeString() : ''}</time>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        ))}
      </div>

      {selectedThread && (
        <form onSubmit={e => { e.preventDefault(); void sendThreadMessage(); }} className="p-2 border-t border-zinc-900 flex gap-2">
          <input value={threadInput} onChange={e => setThreadInput(e.target.value)} placeholder="Message this thread…" aria-label="Thread message" className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50" />
          <button type="submit" disabled={!threadInput.trim() || threadSending} aria-label="Send thread message" className="w-9 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center disabled:opacity-50 cursor-pointer"><Send size={13} /></button>
        </form>
      )}
    </div>
  );
}
