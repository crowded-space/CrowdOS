import React, { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Hash, Users, Search, Bell, Pin,
  Trash2, Send, PlusCircle, Smile,
  Paperclip, FileText, Image as ImageIcon, X,
  ChevronDown, ChevronRight, ChevronUp,
  Clock, Terminal, FileCode2, BellOff, ArrowDown, Sparkles, Square
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import MessageRouter from './messages/message';
import MentionParser from './messages/mention-parser';
import PresenceIndicator from './ui/presence-indicator';
import { Attachment, Agent, Message, ToolExecution } from '@/types/crowd-os';
import { useToast } from '@/components/ui/toast-provider';
import ConfirmDialog from '@/components/ui/confirm-dialog';
import EmojiPickerPopover from './emoji-picker-popover';
import ModeSelector from './mode-selector';
import ApprovalCard from './messages/approval-card';
const DiffViewer = React.lazy(() => import('./diff-viewer'));

const BACKEND_URL = '';

function SandboxCodeViewer({ path, workspaceId }: { path: string; workspaceId?: string | null }) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    fetch(`${BACKEND_URL}/api/workspace/files/content?path=${encodeURIComponent(path)}&workspaceId=${workspaceId || 'default'}`)
      .then(res => res.ok ? res.json() : { content: '// File not found or unreadable' })
      .then(data => {
        setContent(data.content || '');
        setOriginalContent(data.content || '');
      })
      .catch(() => setContent('// Failed to load file'))
      .finally(() => setIsLoading(false));
  }, [path, workspaceId]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch(`${BACKEND_URL}/api/workspace/files/content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content, workspaceId: workspaceId || 'default' })
      });
      setOriginalContent(content);
    } catch (err) {
      console.error('Save failed', err);
    } finally {
      setIsSaving(false);
    }
  };

  const isDirty = content !== originalContent;

  return (
    <>
      <div className="flex-1 overflow-hidden py-3">
        {isLoading ? (
          <div className="text-zinc-500 text-xs p-4 font-mono">Loading content...</div>
        ) : (
          <textarea
            className="w-full h-full bg-transparent text-zinc-300 font-mono text-xs resize-none focus:outline-none p-2 px-4"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
          />
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-zinc-900 bg-zinc-950/50 shrink-0">
        <button
          onClick={() => setContent(originalContent)}
          disabled={!isDirty}
          className="px-3 py-1.5 min-h-[32px] text-[11px] font-medium text-zinc-400 hover:text-zinc-200 disabled:opacity-50 border border-transparent hover:bg-zinc-800 rounded transition cursor-pointer"
        >
          Revert
        </button>
        <button
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className="px-3.5 py-1.5 min-h-[32px] text-[11px] font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white rounded transition cursor-pointer shadow-sm"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </>
  );
}

interface MainChatAreaProps {
  onOpenSearch?: () => void;
}

// Touch-first devices: Enter inserts a newline (native chat feel);
// desktop keeps Enter-to-send.
const isCoarsePointer =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

export default function MainChatArea({ onOpenSearch }: MainChatAreaProps) {
  const {
    workspaces,
    activeWorkspaceId,
    activeChannelId,
    messages,
    agents,
    addMessage,
    clearChannelMessages,
    rightSidebarOpen,
    setRightSidebarOpen,
    selectedSandboxFile,
    setSelectedSandboxFile,
    openAgentProfileModal,
    setMobileDrawerLeft,
    selectedMode,
    isPinned,
    setMode,
    togglePin,
    reconnectDigest,
    clearReconnectDigest,
    cancelRun,
    cancellingByAgent,
    approvalRequests,
    artifactsByRun
  } = useCrowdOSStore();

  const { showSuccess, showInfo, showError } = useToast();
  const shouldReduceMotion = useReducedMotion();

  const MAX_MESSAGE_LEN = 4000;
  const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
  const COMPOSER_MAX_HEIGHT = 160;

  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isSandboxMinimized, setIsSandboxMinimized] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [mutedChannels, setMutedChannels] = useState<Record<string, boolean>>(() => {
    if (typeof localStorage === 'undefined') return {};
    try {
      const map: Record<string, boolean> = {};
      const json = localStorage.getItem('crowdos_muted_channels');
      if (json) {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object') Object.assign(map, parsed);
      }
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('crowdos_mute_')) {
          const ch = k.replace('crowdos_mute_', '');
          if (localStorage.getItem(k) === 'true') map[ch] = true;
        }
      }
      return map;
    } catch { return {}; }
  });

  useEffect(() => {
    if (!reconnectDigest?.visible) return;
    showInfo(reconnectDigest.message, 'Reconnected');
  }, [reconnectDigest?.message, reconnectDigest?.visible]);

  // Auto-reset unpinned mode on channel switch
  useEffect(() => {
    if (activeChannelId && !isPinned) {
      setMode('auto', activeChannelId);
    }
  }, [activeChannelId, isPinned, setMode]);

  // Attachment overlay states
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);

  // File uploading and dragging states
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedMentions, setSelectedMentions] = useState<Agent[]>([]);
  const [stickyMentionsByChannel, setStickyMentionsByChannel] = useState<Record<string, Agent[]>>({});

  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Composer auto-grow: grows with content up to the cap, shrinks on clear
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [inputText]);

  // Attachment popover click-outside auto-dismiss
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (attachmentMenuRef.current && !attachmentMenuRef.current.contains(event.target as Node)) {
        setShowAttachmentMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleAttachRecentFile = () => {
    const mockRecents = [
      { name: 'spanner_query_audit.log', type: 'text/plain', content: 'Database performance verification logs: latency 12.4ms, uptime 99.98%' },
      { name: 'swarm_dispatch_v2.json', type: 'application/json', content: '{"agents": [{"id": "cognitive_engine", "status": "active"}]}' },
      { name: 'prod_cognitive_diagram.png', type: 'image/png', content: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="100%" height="100%" fill="%23111114"/><circle cx="150" cy="100" r="40" fill="%233359ff" opacity="0.8"/><text x="150" y="105" font-family="sans-serif" font-size="12" fill="white" text-anchor="middle">Swarm Core</text></svg>' }
    ];
    const file = mockRecents[Math.floor(Math.random() * mockRecents.length)];
    const id = `attach-recent-${Date.now()}`;
    const newAttachment: Attachment = {
      id,
      name: file.name,
      type: file.type,
      url: file.type === 'image/png' ? file.content : `data:text/plain;charset=utf-8,${encodeURIComponent(file.content)}`,
      size: file.content.length
    };
    setAttachments(prev => [...prev, newAttachment]);
    setShowAttachmentMenu(false);
    showSuccess('File Attached', file.name);
  };

  // File parsing procedures
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    addFilesToArray(e.target.files);
    e.target.value = '';
  };

  const addFilesToArray = (files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        showError('File Too Large', `${file.name} exceeds 5 MB limit.`);
        return;
      }
      if (attachments.length >= 10) {
        showError('Too Many Attachments', 'Maximum 10 attachments per message.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          const newAttachment: Attachment = {
            id: `attach-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            name: file.name,
            type: file.type || 'application/octet-stream',
            url: event.target.result as string,
            size: file.size
          };
          setAttachments(prev => {
            if (prev.length >= 10) return prev;
            return [...prev, newAttachment];
          });
          showSuccess('File Added', file.name);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(att => att.id !== id));
  };

  // Drag-and-drop mechanics
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToArray(e.dataTransfer.files);
    }
  };

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [missedCount, setMissedCount] = useState(0);
  const lastMessageCountRef = useRef(0);
  const firstMsgIdRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);

  // Find active workspace & channel
  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);

  const activeChannel = useMemo(() => {
    if (!activeWS) return null;
    for (const cat of activeWS.categories) {
      const ch = cat.channels.find(c => c.id === activeChannelId);
      if (ch) return ch;
    }
    if (activeWS.channels) {
      return activeWS.channels.find(c => c.id === activeChannelId) || null;
    }
    return null;
  }, [activeWS, activeChannelId]);

  // Filter messages belonging to this channel
  const currentMessages = useMemo(
    () => messages.filter(msg => msg.channelId === activeChannelId),
    [messages, activeChannelId]
  );

  // PERF-5: upward paging state (keyset cursor from store)
  const hasOlder = useCrowdOSStore(s => !!(activeChannelId && s.channelCursors[activeChannelId]));
  const isLoadingOlder = useCrowdOSStore(s => s.isLoadingOlder);
  const stickyMentions = activeChannelId ? (stickyMentionsByChannel[activeChannelId] || []) : [];

  // Check if any agent is currently active or executing in the swarm
  const isSwarmActive = agents.some(a => a.status === 'executing' || a.status === 'thinking');

  // PERF-5: load the previous page when the user scrolls near the top,
  // anchoring the viewport so prepended history doesn't shift the view.
  const maybeLoadOlder = async () => {
    const el = scrollContainerRef.current;
    if (!el || loadingOlderRef.current || isLoadingOlder) return;
    if (!hasOlder || el.scrollTop > 160) return;
    loadingOlderRef.current = true;
    const prevHeight = el.scrollHeight;
    try {
      await useCrowdOSStore.getState().loadOlderMessages();
      el.scrollTop += el.scrollHeight - prevHeight;
    } finally {
      loadingOlderRef.current = false;
    }
  };

  // Handle scroll events — rAF-throttled + passive to avoid layout thrash
  const scrollRafRef = useRef<number | null>(null);
  const handleScroll = () => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!scrollContainerRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      setIsUserScrolledUp(distanceFromBottom > 120);
      void maybeLoadOlder();
    });
  };
  useEffect(() => () => { if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current); }, []);

  const scrollToBottom = (smooth = true) => {
    endRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    setIsUserScrolledUp(false);
    setMissedCount(0);
  };

  // Smart Auto-scroll: smooth for brand-new messages, instant during token
  // streaming (avoids fighting smooth-scroll animations dozens of times/sec).
  useEffect(() => {
    const grew = currentMessages.length !== lastMessageCountRef.current;
    const prevFirstId = firstMsgIdRef.current;
    firstMsgIdRef.current = currentMessages[0]?.id ?? null;

    // PERF-5: prepended history pages must not trigger jump-to-bottom or the
    // missed-message badge; viewport anchoring is handled by maybeLoadOlder.
    const isPrepend = grew && prevFirstId !== null && currentMessages[0]?.id !== prevFirstId;
    lastMessageCountRef.current = currentMessages.length;
    if (isPrepend) return;

    if (grew && !isUserScrolledUp) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (!grew && !isUserScrolledUp) {
      // Content update within existing messages (streaming): pin instantly
      const el = scrollContainerRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
        el.scrollTop = el.scrollHeight;
      }
    }

    // Track missed messages while the user is reading history
    if (grew && isUserScrolledUp) {
      setMissedCount(c => Math.min(c + 1, 99));
    }
  }, [currentMessages, isUserScrolledUp]);

  // Handle caret input change for mention detection
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let val = e.target.value;
    if (val.length > MAX_MESSAGE_LEN) {
      val = val.slice(0, MAX_MESSAGE_LEN);
      showError('Message Too Long', `Truncated to ${MAX_MESSAGE_LEN} characters.`);
      if (composerRef.current) composerRef.current.value = val;
    }
    setInputText(val);

    const selectionStart = e.target.selectionStart;
    const textBeforeCaret = val.slice(0, selectionStart);
    const words = textBeforeCaret.split(/\s/);
    const lastWord = words[words.length - 1];

    if (lastWord.startsWith('@')) {
      setShowMentions(true);
      setMentionFilter(lastWord.slice(1).toLowerCase());
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  };

  const filteredAgents = agents.filter(ag =>
    ag.name.toLowerCase().includes(mentionFilter)
  );

  const handleMentionKeydown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex(prev => (prev + 1) % filteredAgents.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(prev => (prev - 1 + filteredAgents.length) % filteredAgents.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredAgents[mentionIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
      }
    } else if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer) {
      // Desktop: Enter sends. Touch keyboards keep native newline behavior;
      // mobile users send via the dedicated button (thumb-zone CTA).
      e.preventDefault();
      handleSend();
    }
  };

  const insertMention = (agent: Agent) => {
    if (!composerRef.current) return;
    const text = inputText;
    const caretPos = composerRef.current.selectionStart;
    const before = text.slice(0, caretPos);
    const after = text.slice(caretPos);

    const lastIdx = before.lastIndexOf('@');
    const updated = before.slice(0, lastIdx) + after;

    setInputText(updated);
    if (!selectedMentions.find(a => a.id === agent.id)) {
      setSelectedMentions(prev => [...prev, agent]);
    }
    setShowMentions(false);
    composerRef.current.focus();
  };

  const handleSend = () => {
    if (isSending) return;
    const activeStickyMentions = activeChannelId ? (stickyMentionsByChannel[activeChannelId] || []) : [];
    if ((!inputText.trim() && attachments.length === 0 && selectedMentions.length === 0 && activeStickyMentions.length === 0) || !activeChannelId) return;

    const allMentions = [...selectedMentions, ...activeStickyMentions];

    let finalContent = inputText.trim();
    if (finalContent.length > MAX_MESSAGE_LEN) {
      finalContent = finalContent.slice(0, MAX_MESSAGE_LEN);
      showError('Message Truncated', `Content limited to ${MAX_MESSAGE_LEN} characters.`);
    }

    if (allMentions.length > 0) {
      const uniqueMentions = Array.from(new Set(allMentions.map(a => a.name)));
      const mentionsPrefix = uniqueMentions.map(name => `@${name}`).join(' ');
      finalContent = finalContent ? `${mentionsPrefix} ${finalContent}` : mentionsPrefix;
    }
    if (finalContent.length > MAX_MESSAGE_LEN) {
      finalContent = finalContent.slice(0, MAX_MESSAGE_LEN);
      showError('Message Truncated', `Content limited to ${MAX_MESSAGE_LEN} characters.`);
    }

    // Hot-reload fix: read latest mode from store at send-time (avoid stale closure from ModeSelector)
    // Ensures Research -> Chat switch propagates on the very next turn (FLAW #001)
    const currentMode = (useCrowdOSStore as any).getState?.()?.selectedMode || selectedMode;
    const effectiveMode = currentMode || selectedMode;
    setIsSending(true);
    addMessage({
      type: 'human',
      content: finalContent,
      authorId: 'user-01',
      authorName: 'Juan Hamzah',
      channelId: activeChannelId,
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions: allMentions.length > 0 ? Array.from(new Set(allMentions.map(a => a.name))) : undefined,
      mode: effectiveMode,
      runtimeMode: effectiveMode
    } as any);

    setInputText('');
    setAttachments([]);
    setSelectedMentions([]);
    setShowMentions(false);

    // Return focus to the composer so rapid follow-up messages need zero clicks
    if (!isCoarsePointer) {
      requestAnimationFrame(() => composerRef.current?.focus());
    }
    setTimeout(() => setIsSending(false), 600);
  };

  // Quick-start chips for empty channels: one tap drafts a mention
  const quickStartAgents = agents.slice(0, 3);
  const handleQuickStart = (agent: Agent) => {
    setInputText(`@${agent.name} `);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const isChannelMuted = activeChannelId ? !!mutedChannels[activeChannelId] : false;

  const toggleMuteChannel = () => {
    if (!activeChannelId) return;
    const nextState = !isChannelMuted;
    setMutedChannels(prev => {
      const next = { ...prev, [activeChannelId]: nextState };
      if (!nextState) delete (next as any)[activeChannelId];
      try {
        localStorage.setItem('crowdos_muted_channels', JSON.stringify(next));
        if (nextState) localStorage.setItem(`crowdos_mute_${activeChannelId}`, 'true');
        else localStorage.removeItem(`crowdos_mute_${activeChannelId}`);
      } catch {}
      return next;
    });
    if (nextState) {
      showInfo('Channel Muted', `Notifications silenced for #${activeChannel?.name || 'channel'}.`);
    } else {
      showSuccess('Channel Unmuted', `Notifications enabled for #${activeChannel?.name || 'channel'}.`);
    }
  };

  const canSend = !!(
    activeChannelId &&
    !isSending &&
    (inputText.trim() ||
      attachments.length > 0 ||
      selectedMentions.length > 0 ||
      stickyMentions.length > 0)
  );

  // Memoized message list with tool calls folded into parent agent bubble at very bottom.
  // Structure per spec:  @AgentID → [Internal Monologue] → [Agent Final Message] → [Tool Called]
  // Handles tools both before and after the agent final turn (stream + tool:start/complete ordering).
  const renderedMessages = useMemo(() => {
    type Folded = Message & { _attachedTools?: ToolExecution[] };
    const folded: Folded[] = [];
    const pendingByAuthor: Record<string, ToolExecution[]> = {};

    for (const m of currentMessages) {
      if (m.type === 'tool_execution' && m.toolExecution) {
        // Forward case: tool immediately after its agent — attach to that bubble
        const last = folded[folded.length - 1] as Folded | undefined;
        if (last && last.type === 'agent' && last.authorId === m.authorId) {
          if (!last._attachedTools) last._attachedTools = [];
          last._attachedTools.push(m.toolExecution);
          continue;
        }
        // Backward case: tool appeared before its agent final message — queue for next agent
        if (!pendingByAuthor[m.authorId]) pendingByAuthor[m.authorId] = [];
        pendingByAuthor[m.authorId].push(m.toolExecution);
        continue;
      }

      if (m.type === 'agent') {
        const pending = pendingByAuthor[m.authorId] || [];
        pendingByAuthor[m.authorId] = [];
        const mergedTools = pending.length > 0 ? [...pending] : undefined;
        const foldedAgent: Folded = { ...m } as Folded;
        if (mergedTools) foldedAgent._attachedTools = mergedTools;
        folded.push(foldedAgent);
        continue;
      }

      // Non-agent / non-tool: flush pending tools that were never paired (orphans) as standalone
      // Only flush if they would otherwise cross a different-author boundary
      const hasPending = Object.values(pendingByAuthor).some(arr => arr.length > 0);
      if (hasPending) {
        // Check if this message breaks contiguity for any pending author (human/governance/system etc.)
        // For safety, flush all pending before this message so they render in original order as fallback.
        for (const [authorId, arr] of Object.entries(pendingByAuthor)) {
          if (arr.length > 0) {
            for (const te of arr) {
              folded.push({
                id: `orphan-tool-${authorId}-${Date.now()}-${Math.random()}`,
                type: 'tool_execution',
                content: '',
                authorId,
                authorName: authorId,
                channelId: m.channelId,
                timestamp: m.timestamp,
                toolExecution: te,
              } as Folded);
            }
            pendingByAuthor[authorId] = [];
          }
        }
      }
      folded.push(m as Folded);
    }

    // Flush any remaining pending tools at end as orphans
    for (const [authorId, arr] of Object.entries(pendingByAuthor)) {
      if (arr.length > 0) {
        for (const te of arr) {
          folded.push({
            id: `orphan-tool-${authorId}-${Date.now()}-${Math.random()}`,
            type: 'tool_execution',
            content: '',
            authorId,
            authorName: authorId,
            channelId: currentMessages[0]?.channelId || 'unknown',
            timestamp: new Date().toISOString(),
            toolExecution: te,
          } as Folded);
        }
      }
    }

    const list: React.ReactNode[] = [];
    for (let i = 0; i < folded.length; i++) {
      const current = folded[i] as Folded;
      const prev = folded[i - 1] as Folded | undefined;

      const isGroupable =
        prev &&
        prev.authorId === current.authorId &&
        !current.id.startsWith('stream-') &&
        !current.metadata?.monologue &&
        !(current as any)._attachedTools?.length &&
        !(prev as any)._attachedTools?.length &&
        current.type !== 'system' &&
        current.type !== 'delegation' &&
        current.type !== 'tool_execution' &&
        current.type !== 'governance' &&
        prev.type !== 'system' &&
        prev.type !== 'delegation' &&
        prev.type !== 'tool_execution' &&
        prev.type !== 'governance' &&
        !current.attachments?.length &&
        !prev.attachments?.length &&
        (new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime()) < 300 * 1000;

      const matchedAgent = agents.find(ag => ag.id === current.authorId);

      if (isGroupable) {
        list.push(
          <div
            key={current.id}
            className={current.type === 'human'
              ? "pl-4 pr-4 py-1 border-l-4 border-amber-500 bg-amber-500/5 hover:bg-amber-500/[0.08] transition -mt-1"
              : "pl-[52px] pr-4 py-1 hover:bg-zinc-900/10 rounded group transition -mt-1"}
            id={`grouped-msg-${current.id}`}
          >
            <div className="text-zinc-300 text-sm font-sans leading-relaxed selection:bg-indigo-500/30">
              <MentionParser text={current.content} />
            </div>
          </div>
        );
      } else {
        list.push(
          <MessageRouter
            key={current.id}
            message={current}
            agentLevel={matchedAgent?.level ?? 3}
            toolExecutions={(current as Folded)._attachedTools}
          />
        );
      }
    }
    return list;
  }, [currentMessages, agents]);

  return (
    <div id="main-chat-area" className="flex-1 bg-[#121214] flex flex-col h-full overflow-hidden relative">
      {/* Top Channel Header Zone — thumb-friendly, safe */}
      <header className="min-h-[56px] border-b border-zinc-900/80 px-2.5 sm:px-4 flex items-center justify-between bg-[#121214]/95 backdrop-blur-xl shrink-0 select-none sticky top-0 z-10">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          {/* Mobile hamburger — opens channel drawer */}
          <button
            onClick={() => setMobileDrawerLeft(true)}
            aria-label="Open channels"
            className="lg:hidden w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition shrink-0 touch-manipulation active:scale-95"
          >
            <Hash size={16} />
          </button>
          <div className="hidden sm:flex w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 items-center justify-center shrink-0">
            <Hash size={14} className="text-zinc-500" />
          </div>
          <div className="min-w-0">
            <h1 className="font-semibold text-zinc-100 text-[15px] tracking-[-0.015em] truncate font-sans leading-none flex items-center gap-1.5">
              <span className="sm:hidden text-zinc-500">#</span>{activeChannel ? activeChannel.name : 'select-channel'}
            </h1>
            {activeChannel?.description && (
              <p className="text-[11px] text-zinc-500 truncate hidden lg:block font-sans leading-none mt-0.5">
                {activeChannel.description}
              </p>
            )}
          </div>
        </div>

        {/* Action Toolbar — 44px touch targets */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {/* Quick Search Button (Cmd+K) */}
          <button
            onClick={onOpenSearch}
            aria-label="Search"
            className="flex items-center justify-center sm:justify-start gap-2 text-zinc-400 hover:text-zinc-100 w-10 h-10 sm:w-auto sm:px-3 sm:min-h-[38px] bg-zinc-900 sm:bg-zinc-950 border border-zinc-800 sm:border-zinc-800 hover:border-zinc-700 rounded-xl transition-colors text-xs font-sans cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.97] touch-manipulation"
            title="Search (Ctrl+K)"
          >
            <Search size={16} />
            <span className="hidden lg:inline text-[11px] font-mono text-zinc-500">⌘K</span>
          </button>

          {/* Clear Channel History Trigger */}
          {activeChannelId && currentMessages.length > 0 && (
            <button
              onClick={() => setConfirmClearOpen(true)}
              aria-label="Clear channel logs"
              className="w-10 h-10 rounded-xl bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/60 hover:border-zinc-700 text-zinc-500 hover:text-rose-400 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-95 touch-manipulation"
              title="Clear Channel Audit Logs"
            >
              <Trash2 size={16} />
            </button>
          )}

          {(isSwarmActive || currentMessages.some(m => m.id.startsWith('stream-'))) && activeChannelId && (
            <button
              onClick={() => activeChannelId && cancelRun(activeChannelId)}
              disabled={activeChannelId ? Object.keys(cancellingByAgent).some(k => k.startsWith(`${activeChannelId}:`)) : false}
              aria-label="Stop generation"
              className={`hidden sm:inline-flex items-center gap-1.5 px-3 min-h-[38px] rounded-xl border text-xs font-mono font-bold transition active:scale-[0.97] ${Object.keys(cancellingByAgent).some(k => activeChannelId && k.startsWith(`${activeChannelId}:`)) ? 'bg-zinc-800 border-zinc-700 text-zinc-500 cursor-wait' : 'bg-rose-600 hover:bg-rose-500 border-rose-500/20 text-white shadow-[0_2px_10px_rgba(244,63,94,0.25)]'}`}
              title="Stop generation"
            >
              <Square size={12} className="fill-white" />
              <span>{Object.keys(cancellingByAgent).some(k => activeChannelId && k.startsWith(`${activeChannelId}:`)) ? 'Stopping...' : 'Stop'}</span>
            </button>
          )}

          {/* Mute/Unmute Notifications Bell */}
          <button
            onClick={toggleMuteChannel}
            aria-label={isChannelMuted ? 'Unmute channel' : 'Mute channel'}
            aria-pressed={!!isChannelMuted}
            className={`w-10 h-10 rounded-xl border flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer hidden sm:flex active:scale-95 touch-manipulation ${
              isChannelMuted ? 'text-rose-400 bg-rose-500/10 border-rose-500/20 hover:bg-rose-500/15' : 'text-zinc-500 hover:text-zinc-300 bg-zinc-900/60 border-zinc-800/60 hover:bg-zinc-900'
            }`}
            title={isChannelMuted ? "Unmute Channel" : "Mute Channel Notifications"}
          >
            {isChannelMuted ? <BellOff size={16} /> : <Bell size={16} />}
          </button>

          {/* Desktop Right Sidebar Selector — segmented */}
          <div className="hidden lg:flex items-center bg-zinc-900 border border-zinc-800 rounded-xl p-1 ml-1 gap-1">
            <button
              onClick={() => setRightSidebarOpen(true)}
              aria-label="Show agent roster panel"
              aria-pressed={rightSidebarOpen}
              className={`w-9 h-8 rounded-lg transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center ${rightSidebarOpen ? 'text-indigo-300 bg-indigo-500/15 border border-indigo-500/20' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent active:bg-zinc-800'}`}
              title="Agent Roster"
            >
              <Users size={14} />
            </button>
            <button
              onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
              aria-label="Toggle workspace sandbox panel"
              aria-pressed={!rightSidebarOpen}
              className={`w-9 h-8 rounded-lg transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center ${!rightSidebarOpen ? 'text-indigo-300 bg-indigo-500/15 border border-indigo-500/20' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent active:bg-zinc-800'}`}
              title={!rightSidebarOpen ? "Open Workspace Sandbox" : "Open Agent Roster"}
            >
              <Terminal size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Styled Confirm Dialog for Clearing Logs */}
      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear Channel Audit Logs?"
        description={`This action will clear all ${currentMessages.length} message logs in #${activeChannel?.name || 'this channel'}. This cannot be undone.`}
        confirmLabel="Clear Logs"
        isDanger={true}
        onConfirm={() => {
          if (activeChannelId) {
            clearChannelMessages(activeChannelId);
            showSuccess('Audit Logs Cleared', `Messages in #${activeChannel?.name} cleared.`);
          }
          setConfirmClearOpen(false);
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />

      {/* Message stream area — responsive padding, calm rhythm */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6 space-y-3 sm:space-y-4 scrollbar-thin scroll-smooth overscroll-contain contain-paint select-text selection:bg-indigo-500/30 relative"
      >
        {reconnectDigest?.visible && (
          <div className="mx-auto max-w-xl flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs font-sans text-indigo-200 shadow-sm">
            <span className="flex items-center gap-2 min-w-0">
              <Sparkles size={12} className="text-indigo-400 shrink-0" />
              <span className="truncate">{reconnectDigest.message}</span>
            </span>
            <button onClick={clearReconnectDigest} aria-label="Dismiss" className="p-1.5 rounded-lg hover:bg-indigo-500/20 text-indigo-300 shrink-0 transition">
              <X size={12} />
            </button>
          </div>
        )}
        {isLoadingOlder && (
          <div className="text-center text-[11px] font-mono text-zinc-500 py-2 select-none">
            loading earlier messages…
          </div>
        )}
        {activeChannelId && approvalRequests.filter(r => (r.channelId === activeChannelId || !r.channelId) && r.status === 'pending').map(req => (
          <ApprovalCard key={req.id} approval={req} />
        ))}
        {(() => {
          const latestRunId = (() => {
            for (let i = currentMessages.length - 1; i >= 0; i--) {
              const m = currentMessages[i];
              const rid = (m as any).metadata?.runId || (m as any).metadata?.run_id || (m as any).runId;
              if (rid) return rid as string;
            }
            return null;
          })();
          const diffArtifacts = latestRunId ? (artifactsByRun[latestRunId] || []).filter(a => a.artifactType === 'diff' || a.patch) : [];
          if (diffArtifacts.length > 0 && latestRunId) {
            return (
              <div className="mx-auto max-w-3xl w-full">
                <React.Suspense fallback={<div className="p-3 text-xs text-zinc-500 animate-pulse">Loading diffs…</div>}>
                  <DiffViewer runId={latestRunId} />
                </React.Suspense>
              </div>
            );
          }
          return null;
        })()}
        {renderedMessages.length > 0 ? (
          renderedMessages
        ) : (
          /* Empty Channel state — premium onboarding */
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6 sm:p-8 animate-fade-in-up select-none">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600 mb-4 shadow-inner">
              <Hash size={28} />
            </div>
            <h3 className="font-semibold text-zinc-100 text-[15px] sm:text-base tracking-[-0.015em]">
              Welcome to #{activeChannel ? activeChannel.name : 'crowdos'}
            </h3>
            <p className="text-[13px] sm:text-sm text-zinc-500 max-w-[320px] mt-2 leading-relaxed font-sans">
              This is the start of the channel. Mention an agent to put the swarm to work.
            </p>

            {/* One-tap dispatch chips — larger, thumb-friendly */}
            {quickStartAgents.length > 0 && (
              <div className="flex flex-wrap items-center justify-center gap-2.5 mt-6 max-w-sm">
                {quickStartAgents.map(ag => (
                  <button
                    key={ag.id}
                    onClick={() => handleQuickStart(ag)}
                    className="flex items-center gap-2.5 pl-3 pr-4 py-2.5 min-h-[44px] rounded-full bg-zinc-900 border border-zinc-800 hover:border-indigo-500/30 hover:bg-zinc-800/80 transition-all text-[13px] text-zinc-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.98] touch-manipulation shadow-sm"
                  >
                    <PresenceIndicator status={ag.status} size="sm" />
                    <span className="font-medium">@{ag.name}</span>
                    <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-zinc-950 border border-zinc-800">L{ag.level}</span>
                  </button>
                ))}
              </div>
            )}

            {isSwarmActive && (
              <div className="flex items-center gap-2 mt-6 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-mono text-emerald-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </span>
                Swarm operational — agents standing by
              </div>
            )}
          </div>
        )}
        <div ref={endRef} />

        {/* Floating Jump to Present Button */}
        {isUserScrolledUp && (
          <div className="sticky bottom-3 flex justify-center w-full pointer-events-none z-20">
            <button
              onClick={() => scrollToBottom(true)}
              className="pointer-events-auto flex items-center gap-1.5 px-3.5 py-2 min-h-[36px] rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xl shadow-black/40 transition-transform hover:scale-[1.03] active:scale-[0.97] cursor-pointer border border-indigo-400/30"
            >
              {missedCount > 0 ? (
                <span className="min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-white/20 text-[10px] font-mono font-bold">
                  {missedCount}
                </span>
              ) : (
                <ArrowDown size={14} />
              )}
              <span>Jump to present</span>
            </button>
          </div>
        )}
      </div>

      {/* Dynamic Mention Suggestion — floats above composer, thumb-reachable */}
      {showMentions && filteredAgents.length > 0 && (
        <div className="mx-3 sm:mx-4 bg-[#1A1A1E] border border-zinc-800 rounded-2xl shadow-2xl p-2 max-h-52 overflow-y-auto scrollbar-thin overscroll-contain mb-2 animate-scale-in" role="listbox" aria-label="Agent mentions">
          <div className="text-[10px] font-mono font-bold text-zinc-500 px-2.5 py-1 select-none tracking-widest">
            AGENTS — TAP TO MENTION
          </div>
          {filteredAgents.map((ag, index) => (
            <button
              key={ag.id}
              role="option"
              aria-selected={index === mentionIndex}
              onMouseEnter={() => setMentionIndex(index)}
              onClick={() => insertMention(ag)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 min-h-[46px] rounded-xl text-[13px] font-sans text-left transition-colors select-none cursor-pointer focus:outline-none touch-manipulation active:scale-[0.99] ${
                index === mentionIndex ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-300 hover:bg-zinc-800 active:bg-zinc-800'
              }`}
            >
              <PresenceIndicator status={ag.status} size="sm" />
              <span className="font-semibold">{ag.name}</span>
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${index===mentionIndex ? 'bg-white/15 border-white/20 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-500'}`}>L{ag.level}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input Composer Zone — sticky, thumb-ergonomic, safe-area aware */}
      <div className="p-3 sm:p-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-[#121214] shrink-0 relative border-t border-zinc-900/60" id="input-composer-container">

        {/* Code Preview Pane (Popup) — sheet-style, thumb-friendly */}
        {selectedSandboxFile && (
          <div className={`absolute bottom-full left-2 right-2 sm:left-3 sm:right-3 mb-3 flex flex-col bg-[#0c0c0f]/95 backdrop-blur-xl rounded-2xl border border-zinc-800 shadow-[0_-12px_40px_rgba(0,0,0,0.6)] z-20 overflow-hidden transition-all duration-300 ${isSandboxMinimized ? 'h-[44px]' : 'h-[min(56vh,320px)] animate-slide-up'}`}>
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-zinc-800 bg-zinc-950/70 shrink-0 select-none">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                  <FileCode2 size={13} className="text-zinc-400" />
                </span>
                <span className="text-[12px] font-mono font-medium text-zinc-300 tracking-tight truncate">{selectedSandboxFile}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIsSandboxMinimized(!isSandboxMinimized)}
                  aria-label={isSandboxMinimized ? 'Expand code editor' : 'Minimize code editor'}
                  className="w-9 h-9 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 transition-colors cursor-pointer flex items-center justify-center active:scale-95"
                >
                  {isSandboxMinimized ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
                <button
                  onClick={() => setSelectedSandboxFile(null)}
                  aria-label="Close code editor"
                  className="w-9 h-9 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 transition-colors cursor-pointer flex items-center justify-center active:scale-95"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            {!isSandboxMinimized && (
              <SandboxCodeViewer path={selectedSandboxFile} workspaceId={activeWorkspaceId} />
            )}
          </div>
        )}

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`bg-[#1E1E21] border transition-all duration-200 rounded-[18px] sm:rounded-[20px] flex flex-col gap-1 focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.45)] focus-within:-translate-y-[1px] focus-within:border-zinc-700/80 ${
            isDragging
              ? 'border-indigo-500 bg-indigo-500/[0.06] ring-2 ring-indigo-500/20'
              : 'border-zinc-800 focus-within:ring-1 focus-within:ring-zinc-700/30'
          }`}
        >
          {/* Active Mode Badge & Attachments row */}
          {(attachments.length > 0 || selectedMentions.length > 0 || stickyMentions.length > 0) && (
            <div className="flex justify-between items-start p-2 pb-0 border-b border-zinc-900/40 bg-zinc-950/25 rounded-t-xl mb-1 select-none max-h-32 overflow-y-auto scrollbar-thin gap-4">
              <div className="flex flex-wrap gap-2 items-center">
                <AnimatePresence>
                  {selectedMentions.map((ag) => (
                    <motion.div
                      layout={!shouldReduceMotion}
                      layoutId={`mention-${ag.id}`}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={shouldReduceMotion ? { duration: 0.12 } : { type: "spring", stiffness: 400, damping: 25 }}
                      key={ag.id}
                      className="relative flex items-center gap-2 pl-2.5 pr-[68px] py-1.5 min-h-[36px] rounded-lg bg-[#0e0e11] border border-zinc-800 text-[11px] w-fit shadow-sm group"
                    >
                      <PresenceIndicator status={ag.status} size="sm" />
                      <span className="text-zinc-200 truncate font-mono font-medium max-w-[120px]" title={ag.name}>{ag.name}</span>
                      <span className="text-[10px] text-zinc-500 font-mono">Tier L{ag.level}</span>

                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center">
                        <button
                          onClick={() => {
                            if (activeChannelId) {
                              setStickyMentionsByChannel(prev => ({
                                ...prev,
                                [activeChannelId]: [...(prev[activeChannelId] || []), ag]
                              }));
                              setSelectedMentions(prev => prev.filter(m => m.id !== ag.id));
                            }
                          }}
                          aria-label={`Pin ${ag.name}`}
                          className="p-1.5 text-zinc-500 hover:text-indigo-400 transition-colors hover:bg-zinc-900 rounded-full focus:outline-none cursor-pointer"
                          title="Pin this mention"
                        >
                          <Pin size={13} />
                        </button>
                        <button
                          onClick={() => setSelectedMentions(prev => prev.filter(m => m.id !== ag.id))}
                          aria-label={`Remove ${ag.name}`}
                          className="p-1.5 text-zinc-500 hover:text-rose-400 transition-colors hover:bg-zinc-900 rounded-full focus:outline-none cursor-pointer"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                <AnimatePresence>
                  {attachments.map((att) => (
                    <motion.div
                      layout={!shouldReduceMotion}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={shouldReduceMotion ? { duration: 0.12 } : undefined}
                      key={att.id}
                      className="relative flex items-center gap-2 pl-2.5 pr-9 py-1.5 min-h-[36px] rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] w-fit shadow-sm"
                      id={`preview-bubble-${att.id}`}
                    >
                      {att.type.startsWith('image/') ? (
                        <ImageIcon size={14} className="text-zinc-400 shrink-0" />
                      ) : (
                        <FileText size={14} className="text-zinc-400 shrink-0" />
                      )}
                      <span className="text-zinc-300 truncate font-semibold max-w-[120px]" title={att.name}>{att.name}</span>
                      <button
                        onClick={() => removeAttachment(att.id)}
                        aria-label={`Remove ${att.name}`}
                        className="absolute right-0.5 top-1/2 -translate-y-1/2 p-1.5 text-zinc-500 hover:text-rose-400 transition-colors hover:bg-zinc-900 rounded-full focus:outline-none cursor-pointer"
                      >
                        <X size={13} />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              {/* Sticky Mentions Container (Right Side) */}
              <AnimatePresence>
                {stickyMentions.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-2 shrink-0">
                    {stickyMentions.map((ag) => (
                      <motion.div
                        layout={!shouldReduceMotion}
                        layoutId={`mention-${ag.id}`}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={shouldReduceMotion ? { duration: 0.12 } : { type: "spring", stiffness: 400, damping: 25 }}
                        key={`sticky-${ag.id}`}
                        className="relative flex items-center gap-2 pl-2.5 pr-9 py-1.5 min-h-[36px] rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-[11px] w-fit shadow-sm"
                      >
                        <Pin size={10} className="text-indigo-400 shrink-0" />
                        <PresenceIndicator status={ag.status} size="sm" />
                        <span className="text-indigo-200 truncate font-mono font-medium max-w-[120px]" title={ag.name}>{ag.name}</span>
                        <button
                          onClick={() => {
                            if (activeChannelId) {
                              setStickyMentionsByChannel(prev => ({
                                ...prev,
                                [activeChannelId]: (prev[activeChannelId] || []).filter(m => m.id !== ag.id)
                              }));
                            }
                          }}
                          aria-label={`Unpin ${ag.name}`}
                          className="absolute right-0.5 top-1/2 -translate-y-1/2 p-1.5 text-indigo-400 hover:text-rose-400 transition-colors hover:bg-indigo-500/20 rounded-full focus:outline-none cursor-pointer"
                        >
                          <X size={13} />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                )}
              </AnimatePresence>
            </div>
          )}

          <textarea
            ref={composerRef}
            rows={1}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleMentionKeydown}
            maxLength={MAX_MESSAGE_LEN}
            aria-label={`Message ${activeChannel ? activeChannel.name : 'channel'}`}
            enterKeyHint={isCoarsePointer ? 'enter' : 'send'}
            placeholder={
              isDragging
                ? "Drop file(s) here — release to attach"
                : `Message #${activeChannel ? activeChannel.name : 'operational-matrix'}`
            }
            className="w-full bg-transparent border-0 text-[16px] sm:text-[14px] text-zinc-100 placeholder-zinc-500 focus:ring-0 focus:outline-none resize-none px-4 pt-4 pb-2 md:py-3.5 leading-[1.5] caret-indigo-400 select-text min-h-[52px] max-h-[160px] overflow-y-auto scrollbar-thin"
          />
          {inputText.length > 3000 && (
            <div className="px-3.5 pb-1 text-right">
              <span className={`text-[10px] font-mono ${inputText.length > 3800 ? 'text-rose-400' : inputText.length > 3200 ? 'text-amber-400' : 'text-zinc-500'}`}>
                {inputText.length}/{MAX_MESSAGE_LEN}
              </span>
            </div>
          )}

          {/* Action Bar — thumb-zone optimized, 44px min */}
          <div className="flex items-center justify-between p-2 pt-1 select-none shrink-0 gap-2">
            <div className="flex items-center gap-1 text-zinc-500 relative" ref={attachmentMenuRef}>
              <button
                onClick={() => setShowAttachmentMenu(!showAttachmentMenu)}
                aria-label="Attach files"
                aria-expanded={showAttachmentMenu}
                className={`w-11 h-11 rounded-xl border transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center active:scale-95 touch-manipulation ${
                  showAttachmentMenu ? 'text-indigo-300 bg-indigo-500/15 border-indigo-500/20' : 'bg-zinc-800 border-zinc-700/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 hover:border-zinc-600'
                }`}
                title="Attach files or triggers"
              >
                <PlusCircle size={19} />
              </button>

              {/* Advanced Attachment & Operation Portal Menu */}
              {showAttachmentMenu && (
                <div
                  className="absolute bottom-[52px] left-0 z-50 w-64 bg-[#141416] border border-zinc-800/90 rounded-2xl shadow-2xl py-2 px-1.5 animate-scale-in text-zinc-300 select-none text-left"
                  id="attachment-menu-popover"
                >
                  <button
                    onClick={() => {
                      fileInputRef.current?.click();
                      setShowAttachmentMenu(false);
                    }}
                    type="button"
                    className="w-full flex items-center gap-3 px-3 min-h-[44px] hover:bg-zinc-800/80 hover:text-white rounded-xl transition-colors text-[13px] font-medium cursor-pointer focus:outline-none focus-visible:bg-zinc-800/80"
                  >
                    <Paperclip size={16} className="text-zinc-400 shrink-0" />
                    <span>Add photos & files</span>
                  </button>

                  <button
                    onClick={handleAttachRecentFile}
                    type="button"
                    className="w-full flex items-center justify-between px-3 min-h-[44px] hover:bg-zinc-800/80 hover:text-white rounded-xl transition-colors text-[13px] font-medium cursor-pointer focus:outline-none focus-visible:bg-zinc-800/80"
                  >
                    <div className="flex items-center gap-3">
                      <Clock size={16} className="text-zinc-400 shrink-0" />
                      <span>Recent files</span>
                    </div>
                    <ChevronRight size={14} className="text-zinc-550 shrink-0" />
                  </button>
                </div>
              )}

              {/* Emoji Picker Popover */}
              <div className="relative">
                <button
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  aria-label="Insert emoji"
                  aria-expanded={showEmojiPicker}
                  className={`w-11 h-11 rounded-xl border transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center active:scale-95 touch-manipulation ${
                    showEmojiPicker ? 'text-indigo-300 bg-indigo-500/15 border-indigo-500/20' : 'bg-zinc-800 border-zinc-700/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 hover:border-zinc-600'
                  }`}
                  title="Insert emoji"
                >
                  <Smile size={19} />
                </button>

                <EmojiPickerPopover
                  open={showEmojiPicker}
                  onSelect={(emoji) => setInputText(prev => {
                    const next = prev + emoji;
                    if (next.length > MAX_MESSAGE_LEN) {
                      showError('Message Too Long', `Truncated to ${MAX_MESSAGE_LEN} characters.`);
                      return next.slice(0, MAX_MESSAGE_LEN);
                    }
                    return next;
                  })}
                  onClose={() => setShowEmojiPicker(false)}
                />
              </div>

              {/* Hidden Selector Input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden sm:flex">
                <ModeSelector
                  value={selectedMode}
                  onChange={(m) => setMode(m, activeChannelId || undefined)}
                  isPinned={isPinned}
                  onTogglePin={togglePin}
                />
              </div>
              <div className="sm:hidden">
                <ModeSelector
                  value={selectedMode}
                  onChange={(m) => setMode(m, activeChannelId || undefined)}
                  isPinned={isPinned}
                  onTogglePin={togglePin}
                />
              </div>
              <button
                onClick={handleSend}
                disabled={!canSend}
                aria-label="Send message"
                className={`min-w-[48px] min-h-[44px] sm:min-w-[56px] sm:min-h-[42px] px-3.5 sm:px-4 rounded-xl text-[14px] flex items-center justify-center gap-1.5 transition-all select-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:scale-[0.97] touch-manipulation ${
                  isSending ? 'bg-zinc-800 text-zinc-500 cursor-wait border border-zinc-700' :
                  canSend
                    ? 'bg-indigo-600 text-white font-semibold hover:bg-indigo-500 shadow-[0_4px_16px_rgba(79,70,229,0.35)] hover:shadow-[0_6px_20px_rgba(79,70,229,0.45)] border border-indigo-500/20 hover:-translate-y-px active:translate-y-0'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-800'
                }`}
              >
                <Send size={16} className={canSend ? 'sm:mr-0' : ''} />
                <span className="hidden sm:inline">Send</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
