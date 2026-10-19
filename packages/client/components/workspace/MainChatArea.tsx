import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Hash, Users, Search, Bell, Pin,
  Trash2, Send, PlusCircle, Smile,
  Paperclip, FileText, Image as ImageIcon, X,
  ChevronDown, ChevronUp,
  Terminal, FileCode2, ClipboardList, BarChart3, ArrowDown, Sparkles, Square, Menu,
  Maximize2, Minimize2, FolderOpen, Telescope, CalendarDays
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import MessageRouter from './messages/MessageRouter';
import MentionParser from './messages/MentionParser';
import { useStickToBottom } from './messages/use-stick-to-bottom';
import PresenceIndicator from './ui/PresenceIndicator';
import { Attachment, Agent, Message, ToolExecution } from '@/types/crowdOs';
import { useToast } from '@/components/ui/ToastProvider';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import EmojiPickerPopover from './EmojiPickerPopover';
import ModeSelector from './ModeSelector';
import { overflowState, projectedSendLength, shortPath } from './composer-preflight-model';
import { sourceHint, sourceLabel } from './explorer-model';
import { StatusStrip } from './StatusStrip';
import { loadOperatorProfile } from './operator-profile-model';
import { apiClient } from '@/src/api/client';
import ApprovalCard from './messages/ApprovalCard';
import { RunCard } from './RunCard';
import { RunHeader } from './RunHeader';
import SandboxCodeViewer from './SandboxCodeViewer';
import ThreadDrawer from './ThreadDrawer';
import NotificationCenter, { useNotificationCenterBadge } from '@/components/ui/NotificationCenter';
const DiffViewer = React.lazy(() => import('./DiffViewer'));
const CheckpointRow = React.lazy(() => import('./CheckpointRow'));

function dayKeyForTimestamp(ts: string | undefined | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function formatDayDivider(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function DateDivider({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 px-2 pt-2 select-none">
      <span aria-hidden="true" className="h-px flex-1 bg-zinc-800/80" />
      <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
        <CalendarDays size={11} aria-hidden="true" />
        <span>{label}</span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-zinc-800/80" />
    </div>
  );
}

// Deliberately not rendered: the store keeps no honest unread anchor —
// setActiveChannel zeroes unreadCount with no last-read message id, and
// unreadCount is only a count, never a position. Rendering UnreadDivider
// here would fabricate a marker, so date dividers are wired alone until a
// real anchor exists.
function UnreadDivider() {
  return (
    <div role="separator" aria-label="New messages" className="flex items-center gap-2 px-2 select-none">
      <span aria-hidden="true" className="h-px flex-1 bg-indigo-500/40" />
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/30 text-[10px] font-mono font-semibold text-indigo-300">
        <Bell size={11} aria-hidden="true" />
        <span>New messages</span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-rose-500/40" />
    </div>
  );
}

interface MainChatAreaProps {
  onOpenSearch?: () => void;
  onOpenSidebar?: () => void;
}

export default function MainChatArea({ onOpenSearch, onOpenSidebar }: MainChatAreaProps) {
  const {
    workspaces,
    activeWorkspaceId,
    activeChannelId,
    messages,
    agents,
    addMessage,
    clearChannelMessages,
    rightPanelView,
    setRightPanelView,
    selectedSandboxFile,
    setSelectedSandboxFile,
    openAgentProfileModal,
    selectedMode,
    isPinned,
    setMode,
    togglePin,
    reconnectDigest,
    clearReconnectDigest,
    cancelRun,
    cancellingByAgent,
    approvalRequests,
    artifactsByRun,
    jobsByRun,
    draftByChannel,
    setDraft,
    clearDraft,
    outbox,
    queueSend,
    appliesTo,
    setAppliesTo
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
  // Code viewer height: min (44px bar), dock (30% sheet), full (100% fill).
  // One chevron toggles min ⇄ dock (never reaches full — that's the maximize
  // button's job). Every step tweens an explicit px height (single driver).
  const [sandboxView, setSandboxView] = useState<'min' | 'dock' | 'full'>('dock');
  // A newly opened file always starts docked.
  useEffect(() => {
    if (selectedSandboxFile) setSandboxView('dock');
  }, [selectedSandboxFile]);
  const [sandboxDockH, setSandboxDockH] = useState(240);
  const [sandboxFullH, setSandboxFullH] = useState(480);
  // Collapsed bar = header (h-11) + panel border (2px), so the panel bottom
  // edge lands exactly on the header edge instead of clipping it.
  const SANDBOX_MIN_H = 46;
  // Full height = whatever space is left between the header and the composer.
  // Measured from the live DOM (siblings, not assumptions) so composer growth,
  // the mention popup, and viewport changes can never leave a gap. The panel
  // tweens to it like any other height — one driver, no snap.
  const chatRootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const computeFullH = () => {
    const root = chatRootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return null;
    // Skip the panel itself AND the stream: at full the stream collapses to
    // zero (its padding is tweened out with the view), so everything else is
    // what the panel has to leave behind. Margins count too — offsetHeight
    // excludes them and an uncounted margin overflows the column.
    const stream = scrollContainerRef.current;
    let used = 8; // panel's own mb-2
    for (const child of Array.from(root.children)) {
      if (child === panel || child === stream) continue;
      const el = child as HTMLElement;
      used += el.offsetHeight + (parseFloat(getComputedStyle(el).marginBottom) || 0);
    }
    return Math.max(240, Math.round(root.clientHeight - used));
  };
  // Measure the live space between header and composer: full = all of it,
  // dock = 30% of it. Layout effect so the first paint already carries the
  // measured heights (no 240px flash), kept fresh by observer + resizes,
  // so composer growth or viewport changes can never leave a gap.
  useLayoutEffect(() => {
    const compute = () => {
      const next = computeFullH();
      if (next === null) return;
      setSandboxFullH(next);
      setSandboxDockH(Math.max(160, Math.round(next * 0.3)));
    };
    compute();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(compute);
    if (ro) {
      if (chatRootRef.current) ro.observe(chatRootRef.current);
      if (composerBoxRef.current) ro.observe(composerBoxRef.current);
    }
    window.addEventListener('resize', compute);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [sandboxView, showMentions, selectedSandboxFile]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [confirmOverflowOpen, setConfirmOverflowOpen] = useState(false);
  const [openRunThreadId, setOpenRunThreadId] = useState<string | null>(null);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [mountScope, setMountScope] = useState<{ path: string | null; source: string | null }>({ path: null, source: null });
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
    showInfo('Connection update', reconnectDigest.message);
  }, [reconnectDigest?.message, reconnectDigest?.visible]);

  // Attachment overlay states
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);

  // File uploading and dragging states
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedMentions, setSelectedMentions] = useState<Agent[]>([]);
  const [stickyMentionsByChannel, setStickyMentionsByChannel] = useState<Record<string, Agent[]>>({});

  // Phase E: per-channel drafts. Load on channel switch; debounced save on
  // change. Store is source; missing draft means empty composer (never a
  // fabricated restore). Attachments stay local (data-URL bulk quota
  // hazard); mount snapshot is display-only from Phase B mountScope.
  const draftLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeChannelId) return;
    const draft = draftByChannel[activeChannelId];
    draftLoadedRef.current = activeChannelId;
    setInputText(draft?.text ?? '');
    if (draft?.mentionIds && draft.mentionIds.length > 0) {
      const restored = agents.filter(a => draft.mentionIds!.includes(a.id));
      setSelectedMentions(restored);
    } else {
      setSelectedMentions([]);
    }
    if (draft?.runtime === 'chat' || draft?.runtime === 'agentic' || draft?.runtime === 'coding' || draft?.runtime === 'research' || draft?.runtime === 'swarm' || draft?.runtime === 'auto') {
      setMode(draft.runtime as any, activeChannelId);
    }
  }, [activeChannelId]);
  useEffect(() => {
    if (!activeChannelId || draftLoadedRef.current !== activeChannelId) return;
    const timer = setTimeout(() => {
      setDraft(activeChannelId, {
        text: inputText,
        mentionIds: selectedMentions.map(a => a.id),
        runtime: selectedMode,
        mountSnapshot: { path: mountScope.path, source: mountScope.source },
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [inputText, selectedMentions, selectedMode, activeChannelId]);

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

  // Follow-scroll owns the scroll container: wheel/touch intent (never the
  // `scroll` event, which also fires for our own pins) decides follow mode.
  const { containerRef: scrollContainerRef, followStream, resume, isAtBottom, scrollHandlers } =
    useStickToBottom<HTMLDivElement>();
  const isUserScrolledUp = !isAtBottom;
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

  // Phase E: active run per channel = latest non-terminal jobsByRun row in
  // the active channel (SAME source as JobsView, never a second run model).
  // Null hides the header: no active run means no header, never a forced one.
  const activeRunId = useMemo(() => {
    if (!activeChannelId) return null;
    let latest: { runId: string; updatedAt: string } | null = null;
    for (const job of Object.values(jobsByRun)) {
      if (job.channelId !== activeChannelId) continue;
      const st = String(job.status).toLowerCase();
      if (st === 'completed' || st === 'failed' || st === 'cancelled') continue;
      if (!latest || job.updatedAt > latest.updatedAt) latest = job;
    }
    return latest ? latest.runId : null;
  }, [jobsByRun, activeChannelId]);

  // PERF-5: upward paging state (keyset cursor from store)
  const hasOlder = useCrowdOSStore(s => !!(activeChannelId && s.channelCursors[activeChannelId]));
  // Phase B preflight: effective mount for the active channel. Read failures
  // resolve to honest empty so the preflight hides the chip instead of
  // inventing a path or blocking Send on a read error.
  useEffect(() => {
    let cancelled = false;
    if (!activeChannelId) {
      setMountScope({ path: null, source: null });
      return;
    }
    setMountScope({ path: null, source: null });
    void apiClient
      .getWorkspaceRoot(activeWorkspaceId || 'default', activeChannelId, 'effective')
      .then((scope) => {
        if (!cancelled) setMountScope({ path: scope?.path ?? null, source: scope?.source ?? null });
      })
      .catch(() => {
        if (!cancelled) setMountScope({ path: null, source: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, activeChannelId]);
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

  // Scroll listener serves upward paging only. Follow-mode intent comes from
  // wheel/touch handlers (the `scroll` event also fires for programmatic
  // pins and must never cancel follow mode). rAF-throttled + passive-safe.
  const scrollRafRef = useRef<number | null>(null);
  const handleScroll = () => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      void maybeLoadOlder();
    });
  };
  // Follow-scroll: new rows and token updates share one path — an instant
  // container pin while following, so smooth-scroll animations never stack at
  // token rate. Scrolled-up users keep their position and collect a missed
  // count instead of being yanked. User-triggered jumps use resume() (smooth).
  useEffect(() => {
    const grew = currentMessages.length !== lastMessageCountRef.current;
    const prevFirstId = firstMsgIdRef.current;
    firstMsgIdRef.current = currentMessages[0]?.id ?? null;

    // PERF-5: prepended history pages must not trigger jump-to-bottom or the
    // missed-message badge; viewport anchoring is handled by maybeLoadOlder.
    const isPrepend = grew && prevFirstId !== null && currentMessages[0]?.id !== prevFirstId;
    lastMessageCountRef.current = currentMessages.length;
    if (isPrepend) return;

    if (!isUserScrolledUp) {
      followStream();
    } else if (grew) {
      setMissedCount(c => Math.min(c + 1, 99));
    }
  }, [currentMessages, isUserScrolledUp, followStream]);

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
    } else if (e.key === 'Enter' && !e.shiftKey) {
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
    // Phase E: offline queue. No connection means queue with will-send copy
    // (flushOutbox emits after gap replay on reconnect); the composer keeps
    // its text so nothing is silently lost.
    if (typeof navigator !== 'undefined' && navigator.onLine === false && activeChannelId) {
      queueSend({
        channelId: activeChannelId,
        content: inputText,
        mentionIds: [...selectedMentions, ...((activeChannelId && stickyMentionsByChannel[activeChannelId]) || [])].map(a => a.id),
        runtimeMode: selectedMode,
      });
      showInfo('Queued offline', 'Will send on reconnect.');
      return;
    }
    // Overflow guard reads the PROJECTED send length (draft + mention prefix),
    // not the raw draft: the textarea enforces maxLength while typing, so the
    // prefix expansion is the only path past the cap. Confirm once via the
    // existing ConfirmDialog, then send truncated like the legacy path.
    const guardSticky = activeChannelId ? (stickyMentionsByChannel[activeChannelId] || []) : [];
    const guardNames = [...selectedMentions, ...guardSticky].map((a) => a.name);
    if (overflowState(projectedSendLength(inputText, guardNames), MAX_MESSAGE_LEN) === 'over' && !confirmOverflowOpen) {
      setConfirmOverflowOpen(true);
      return;
    }
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
      authorId: 'local-operator',
      authorName: loadOperatorProfile().name || 'Local operator',
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

    // Phase E: a sent composer clears its persisted draft (store is source;
    // the mirror write-through follows inside clearDraft).
    if (activeChannelId) clearDraft(activeChannelId);

    // The user acted in this channel: resume follow so their message lands
    // in view (user-triggered, smooth is fine here).
    setMissedCount(0);
    resume();

    // Return focus to the composer so rapid follow-up messages need zero clicks
    requestAnimationFrame(() => composerRef.current?.focus());
    setTimeout(() => setIsSending(false), 600);
  };

  // Quick-start chips for empty channels: one tap drafts a mention
  const quickStartAgents = agents.slice(0, 3);
  const handleQuickStart = (agent: Agent) => {
    setInputText(`@${agent.name} `);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  // Empty-hero capture cards: one-click deep-links to existing actions only.
  // No new endpoints, no mock data; each card reuses a handler the chrome
  // already owns (mention draft, mode switch, repo panel).
  const l0Agent = agents.find(a => a.level === 0);
  const handleAskL0 = () => {
    if (l0Agent) handleQuickStart(l0Agent);
  };
  const handleRunResearch = () => {
    if (activeChannelId) setMode('research', activeChannelId);
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  const handleReviewDiff = () => setRightPanelView('repo');
  const handleMountFolder = () => setRightPanelView('repo');
  const captureCardClass = 'flex items-start gap-2.5 p-3 min-h-[64px] rounded-xl bg-zinc-900 border border-zinc-800 hover:border-indigo-500/30 hover:bg-zinc-800/80 transition-colors duration-200 text-left text-zinc-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.98] shadow-sm disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:transform-none';

  const isChannelMuted = activeChannelId ? !!mutedChannels[activeChannelId] : false;

  // Phase G: header badge over the persisted history journal (DND-gated).
  const notificationBadge = useNotificationCenterBadge();
  const unreadForBadge = notificationBadge.unreadCount;
  const badgeLabel = notificationBadge.dndActive
    ? notificationBadge.dndLabel + ', badge paused'
    : unreadForBadge > 0
      ? unreadForBadge > 99
        ? '99+ unread notifications'
        : unreadForBadge + ' unread notifications'
      : 'No unread notifications';

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
    // canSend intentionally does NOT include the overflow state: an over-limit
    // draft must stay clickable so the guard can open the explicit confirm
    // dialog. Blocking the button would hide the guard with no visible copy.
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
    let lastDividerDayKey: string | null = null;
    for (let i = 0; i < folded.length; i++) {
      const current = folded[i] as Folded;
      const prev = folded[i - 1] as Folded | undefined;

      // Date divider on honest day change only: derived from the real
      // message.timestamp via dayKeyForTimestamp/formatDayDivider.
      // Orphan tool rows carry a fabricated client timestamp (flush at
      // end stamps new Date()), so they never open a divider. No
      // UnreadDivider here (no honest anchor — see note above it).
      const isOrphanToolRow = current.id.startsWith('orphan-tool-');
      const dayKey = dayKeyForTimestamp(current.timestamp);
      if (!isOrphanToolRow && dayKey && dayKey !== lastDividerDayKey) {
        lastDividerDayKey = dayKey;
        const dividerLabel = formatDayDivider(current.timestamp);
        if (dividerLabel) {
          list.push(<DateDivider key={`day-${dayKey}`} label={dividerLabel} />);
        }
      }
      const prevDayKey = prev ? dayKeyForTimestamp(prev.timestamp) : null;
      const crossesDay = !!prev && !!dayKey && !!prevDayKey && dayKey !== prevDayKey;

      const isGroupable =
        prev &&
        !crossesDay &&
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

  useEffect(() => {
    setOpenRunThreadId(null);
    // Fresh channel starts followed at the latest message.
    setMissedCount(0);
    resume();
  }, [activeChannelId]);

  return (
    <div className="flex-1 flex h-full overflow-hidden min-w-0">
    <div id="main-chat-area" ref={chatRootRef} className="flex-1 bg-[#121214] flex flex-col h-full overflow-hidden relative min-w-0">
      {/* Top Channel Header Zone — thumb-friendly, safe */}
      <header className="min-h-[56px] border-b border-zinc-900/80 px-2.5 sm:px-4 flex items-center justify-between bg-[#121214]/95 backdrop-blur-xl shrink-0 select-none sticky top-0 z-10">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
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
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label="Open workspace menu"
            className="xl:hidden w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 flex items-center justify-center transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.97]"
            title="Workspace menu"
          >
            <Menu size={16} aria-hidden="true" />
          </button>

          {/* Quick Search Button (Cmd+K) */}
          <button
            onClick={onOpenSearch}
            aria-label="Search"
            className="flex items-center justify-center sm:justify-start gap-2 text-zinc-400 hover:text-zinc-100 w-10 h-10 sm:w-auto sm:px-3 sm:min-h-[38px] bg-zinc-900 sm:bg-zinc-950 border border-zinc-800 sm:border-zinc-800 hover:border-zinc-700 rounded-xl transition-colors text-xs font-sans cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.97]"
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
              className="w-10 h-10 rounded-xl bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/60 hover:border-zinc-700 text-zinc-500 hover:text-rose-400 flex items-center justify-center transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-95"
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
              className={`inline-flex items-center gap-1.5 px-3 min-h-[38px] rounded-[4px] border text-xs font-mono font-bold transition active:scale-[0.97] ${Object.keys(cancellingByAgent).some(k => activeChannelId && k.startsWith(`${activeChannelId}:`)) ? 'bg-zinc-800 border-zinc-700 text-zinc-500 cursor-wait' : 'bg-rose-600 hover:bg-rose-500 border-rose-500/20 text-white shadow-[0_2px_10px_rgba(244,63,94,0.25)]'}`}
              title="Stop generation"
            >
              <Square size={12} className="fill-white" />
              <span>{Object.keys(cancellingByAgent).some(k => activeChannelId && k.startsWith(`${activeChannelId}:`)) ? 'Stopping...' : 'Stop'}</span>
            </button>
          )}

          {/* Notification center trigger (Phase G): opens history, not mute. Mute lives inside the center. */}
          <button
            onClick={() => setNotificationCenterOpen(true)}
            aria-label={notificationBadge.dndActive ? 'Notifications, ' + notificationBadge.dndLabel + ', badge paused' : badgeLabel}
            title="Open notifications"
            className="relative w-10 h-10 rounded-xl border flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 cursor-pointer hidden sm:flex active:scale-95 text-zinc-500 hover:text-zinc-300 bg-zinc-900/60 border-zinc-800/60 hover:bg-zinc-900"
          >
            <Bell size={16} aria-hidden="true" />
            {!notificationBadge.dndActive && unreadForBadge > 0 && (
              <span aria-hidden="true" className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-[4px] bg-indigo-500 text-white text-[10px] font-semibold flex items-center justify-center border border-indigo-400/50 tnum">
                {unreadForBadge > 99 ? '99+' : String(unreadForBadge)}
              </span>
            )}
          </button>


          {/* Desktop Right Sidebar Selector — segmented: roster/repo/jobs/telemetry panel */}
          <div className="hidden xl:flex items-center bg-zinc-900 border border-zinc-800 rounded-xl p-1 ml-1 gap-1" role="tablist" aria-label="Right panel view">
            <button
              id="right-panel-tab-roster"
              role="tab"
              aria-selected={rightPanelView === 'roster'}
              aria-controls="right-panel-roster"
              onClick={() => setRightPanelView('roster')}
              aria-label="Show agent roster panel"
              className={`w-9 h-8 rounded-lg transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center ${rightPanelView === 'roster' ? 'text-indigo-300 bg-indigo-500/15 border border-indigo-500/20' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent active:bg-zinc-800'}`}
              title="Show agent roster panel"
            >
              <Users size={14} aria-hidden="true" />
            </button>
            <button
              id="right-panel-tab-repo"
              role="tab"
              aria-selected={rightPanelView === 'repo'}
              aria-controls="right-panel-repo"
              onClick={() => setRightPanelView('repo')}
              aria-label="Show repository panel"
              className={`w-9 h-8 rounded-lg transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center ${rightPanelView === 'repo' ? 'text-indigo-300 bg-indigo-500/15 border border-indigo-500/20' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent active:bg-zinc-800'}`}
              title="Show repository panel"
            >
              <Terminal size={14} aria-hidden="true" />
            </button>
            <button
              id="right-panel-tab-jobs"
              role="tab"
              aria-selected={rightPanelView === 'jobs'}
              aria-controls="right-panel-jobs"
              onClick={() => setRightPanelView('jobs')}
              aria-label="Show jobs panel"
              className={`w-9 h-8 rounded-lg transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center ${rightPanelView === 'jobs' ? 'text-indigo-300 bg-indigo-500/15 border border-indigo-500/20' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent active:bg-zinc-800'}`}
              title="Show jobs panel"
            >
              <ClipboardList size={14} aria-hidden="true" />
            </button>
            <button
              id="right-panel-tab-telemetry"
              role="tab"
              aria-selected={rightPanelView === 'telemetry'}
              aria-controls="right-panel-telemetry"
              onClick={() => setRightPanelView('telemetry')}
              aria-label="Show telemetry panel"
              className={`w-9 h-8 rounded-lg transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center ${rightPanelView === 'telemetry' ? 'text-indigo-300 bg-indigo-500/15 border border-indigo-500/20' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent active:bg-zinc-800'}`}
              title="Show telemetry panel"
            >
              <BarChart3 size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {/* Styled Confirm Dialog for Clearing Logs */}
      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear Channel Audit Logs?"
        description={`This clears all ${currentMessages.length} messages in #${activeChannel?.name || 'this channel'} from this device view and the local mirror only. It does not delete server history: reopening the channel refetches /api/channels/:id/messages and cleared messages can return. Agent memory is untouched: history belongs to this session, memory belongs to each agent.`}
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

      {/* Phase B overflow confirm: projected send (draft + mention prefix) is over
          the cap. Confirming sends with the legacy truncation; cancelling returns
          to the composer with the draft intact. */}
      <ConfirmDialog
        open={confirmOverflowOpen}
        title="Message exceeds the limit?"
        description={`This send is projected past ${MAX_MESSAGE_LEN} characters once mention chips are prefixed. Confirming sends it truncated to ${MAX_MESSAGE_LEN} characters; cancelling keeps your draft intact.`}
        confirmLabel="Send truncated"
        onConfirm={() => {
          setConfirmOverflowOpen(false);
          handleSend();
        }}
        onCancel={() => setConfirmOverflowOpen(false)}
      />

      {/* Message stream area — responsive padding, calm rhythm. Follow-scroll
          pins via container scrollTo(instant) while streaming; intent comes
          from wheel/touch (never the scroll event). Bottom padding clears the
          composer so the last line is never hidden behind it. */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={scrollHandlers.onWheel}
        onTouchMove={scrollHandlers.onTouchMove}
        style={{ overflowAnchor: 'auto', paddingBottom: 96 }}
        className={`flex-1 overflow-y-auto px-3 sm:px-4 lg:px-6 ${
          selectedSandboxFile && sandboxView === 'full' ? 'py-0' : 'py-4 sm:py-6'
        } transition-[padding] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] space-y-3 sm:space-y-4 scrollbar-thin scroll-auto overscroll-contain contain-paint select-text selection:bg-indigo-500/30 relative`}
      >
        {activeRunId && (
          <div className="sticky top-0 z-10">
            <RunHeader runId={activeRunId} />
          </div>
        )}
        {reconnectDigest?.visible && (
          <div className="mx-auto max-w-xl flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs font-sans text-indigo-200 shadow-sm">
            <span className="flex items-center gap-2 min-w-0">
              <Sparkles size={12} className="text-indigo-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{reconnectDigest.message}</span>
            </span>
            <button onClick={clearReconnectDigest} aria-label="Dismiss connection notice" title="Dismiss connection notice" className="p-1.5 rounded-lg hover:bg-indigo-500/20 text-indigo-300 shrink-0 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30">
              <X size={12} aria-hidden="true" />
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
          // Phase C: the checkpoint gate reads the server runtime for the run
          // (run.status_changed runtimeType, via runRuntimeByRun). Message
          // metadata carries only the runId, never the runtime, so the gate
          // hides instead of guessing when the runtime is unknown.
          const latestRuntime = latestRunId ? (useCrowdOSStore.getState().runRuntimeByRun[latestRunId] ?? null) : null;
          const showCheckpoint = latestRuntime === 'coding' || latestRuntime === 'swarm';
          if (diffArtifacts.length > 0 && latestRunId) {
            return (
              <div className="mx-auto max-w-3xl w-full space-y-2">
                {showCheckpoint && (
                  <React.Suspense fallback={<div className="p-3 text-xs text-zinc-500 animate-pulse">Loading checkpoint…</div>}>
                    <CheckpointRow runId={latestRunId} runtime={latestRuntime as string} />
                  </React.Suspense>
                )}
                <React.Suspense fallback={<div className="p-3 text-xs text-zinc-500 animate-pulse">Loading diffs…</div>}>
                  <DiffViewer runId={latestRunId} />
                </React.Suspense>
              </div>
            );
          }
          return null;
        })()}
        {(() => {
          const seen = new Set<string>();
          const runIds: string[] = [];
          for (const m of currentMessages) {
            const rid = (m as any).metadata?.runId || (m as any).metadata?.run_id || (m as any).runId;
            if (typeof rid === 'string' && rid && !seen.has(rid)) {
              seen.add(rid);
              runIds.push(rid);
            }
          }
          if (runIds.length === 0) return null;
          return (
            <div className="mx-auto max-w-3xl w-full space-y-2">
              {runIds.map((rid) => (
                <RunCard key={rid} runId={rid} onOpenThread={(id) => setOpenRunThreadId(id)} onOpenDiff={() => setRightPanelView('repo')} />
              ))}
            </div>
          );
        })()}
        {renderedMessages.length > 0 ? (
          renderedMessages
        ) : (
          /* Empty Channel state — premium onboarding */
          <div className="relative flex flex-col items-center justify-center min-h-[60vh] text-center p-6 sm:p-8 animate-fade-in-up select-none">
            <div className="absolute inset-0 pointer-events-none" aria-hidden>
              <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[420px] h-[220px] bg-[#465EDB]/8 blur-[100px] rounded-full" />
            </div>
            <div className="relative w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 mb-4 shadow-[0_8px_24px_rgba(10,14,32,0.5)]">
              <Hash size={28} />
            </div>
            <h3 className="relative font-semibold text-zinc-100 text-lg sm:text-xl tracking-[-0.02em] text-balance">
              Welcome to #{activeChannel ? activeChannel.name : 'crowdos'}
            </h3>
            <p className="relative text-[13px] sm:text-sm text-zinc-400 max-w-[38ch] mt-2 leading-relaxed font-sans text-pretty">
              This is the start of the channel. Mention an agent to put the swarm to work.
            </p>

            {/* One-tap dispatch chips — larger, thumb-friendly */}
            {quickStartAgents.length > 0 && (
              <div className="relative flex flex-wrap items-center justify-center gap-2.5 mt-6 max-w-sm">
                {quickStartAgents.map(ag => (
                  <button
                    key={ag.id}
                    onClick={() => handleQuickStart(ag)}
                    className="flex items-center gap-2.5 pl-3 pr-4 py-2.5 min-h-[44px] rounded-xl bg-zinc-900 border border-zinc-800 hover:border-indigo-500/30 hover:bg-zinc-800/80 transition-colors duration-200 text-[13px] text-zinc-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 active:scale-[0.98] shadow-sm"
                  >
                    <PresenceIndicator status={ag.status} size="sm" />
                    <span className="font-medium">@{ag.name}</span>
                    <span className="tnum text-[10px] font-mono text-zinc-400 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800">L{ag.level}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Capture cards: one-click deep-links to existing actions only (no new endpoints) */}
            <div className="relative grid grid-cols-1 min-[480px]:grid-cols-2 gap-2 mt-6 w-full max-w-md" role="group" aria-label="Suggested next actions">
              <button
                type="button"
                onClick={handleAskL0}
                disabled={!l0Agent}
                aria-label={l0Agent ? 'Ask ' + l0Agent.name : 'Ask L0 (no L0 agent available)'}
                title={l0Agent ? 'Draft @' + l0Agent.name + ' in the composer' : 'No L0 agent in this workspace yet'}
                className={captureCardClass}
              >
                <Sparkles size={16} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-zinc-100">Ask L0</span>
                  <span className="block text-[11px] text-zinc-500 truncate">{l0Agent ? '@' + l0Agent.name + ' in composer' : 'No L0 agent yet'}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={handleRunResearch}
                aria-label="Run research in research mode"
                title="Switch the composer to research mode"
                className={captureCardClass}
              >
                <Telescope size={16} className="mt-0.5 shrink-0 text-fuchsia-400" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-zinc-100">Run research</span>
                  <span className="block text-[11px] text-zinc-500">Research mode in composer</span>
                </span>
              </button>
              <button
                type="button"
                onClick={handleReviewDiff}
                aria-label="Review diffs in the repo panel"
                title="Open the repo panel where diffs surface"
                className={captureCardClass}
              >
                <FileCode2 size={16} className="mt-0.5 shrink-0 text-violet-400" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-zinc-100">Review diff</span>
                  <span className="block text-[11px] text-zinc-500">Diffs in the repo panel</span>
                </span>
              </button>
              <button
                type="button"
                onClick={handleMountFolder}
                aria-label="Mount a folder from the repo panel"
                title="Open the repo panel folder mount entry"
                className={captureCardClass}
              >
                <FolderOpen size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-zinc-100">Mount folder</span>
                  <span className="block text-[11px] text-zinc-500">Folder mount in repo panel</span>
                </span>
              </button>
            </div>

            {isSwarmActive && (
              <div className="relative flex items-center gap-2 mt-6 px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-mono text-emerald-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </span>
                Swarm operational, agents standing by
              </div>
            )}
          </div>
        )}
        {/* Floating Jump to Present Button */}
        {isUserScrolledUp && (
          <div className="sticky bottom-3 flex justify-center w-full pointer-events-none z-20">
            <button
              onClick={() => { setMissedCount(0); resume(); }}
              className="jump-latest pointer-events-auto flex items-center gap-1.5 px-3.5 py-2 min-h-[36px] rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-[0_8px_24px_rgba(10,14,32,0.55)] transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] cursor-pointer border border-indigo-400/30"
            >
              {missedCount > 0 ? (
                <span className="tnum min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded bg-white/20 text-[10px] font-mono font-semibold">
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

      {/* Code viewer — in-flow panel between stream and composer so drafts
          survive view switches (single SandboxCodeViewer mount). min: 46px
          bar; dock: sheet; full: fills the chat area below the header. */}
      <AnimatePresence>
        {selectedSandboxFile && (
          <motion.div
            key="sandbox-code-viewer"
            ref={panelRef}
            initial={{ opacity: 0, y: 12, height: SANDBOX_MIN_H }}
            animate={{
              opacity: 1,
              y: 0,
              height: sandboxView === 'min' ? SANDBOX_MIN_H : sandboxView === 'dock' ? sandboxDockH : sandboxFullH,
            }}
            exit={{
              opacity: 0,
              y: 12,
              height: 0,
              marginBottom: 0,
              transition: shouldReduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
            }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            style={{ flex: 'none' }}
            className="mx-3 sm:mx-4 mb-2 flex min-h-0 flex-col bg-[#0c0c0f] border border-zinc-800 rounded-[8px] shadow-[0_-12px_40px_rgba(10,14,32,0.6)] overflow-hidden shrink-0">
            {/* Constant header height in every view (h-11) so collapsing never
                pops the title bar; the divider only exists outside `min`. */}
            <div className={`flex items-center justify-between shrink-0 select-none px-3.5 h-11 bg-zinc-950/70 ${sandboxView === 'min' ? '' : 'border-b border-zinc-800'}`}>
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-7 h-7 rounded-[4px] bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                <FileCode2 size={13} className="text-zinc-400" />
              </span>
              <span className="text-[12px] font-mono font-medium text-zinc-300 tracking-tight truncate">{selectedSandboxFile}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  // min ⇄ dock only; full is entered/exited via maximize.
                  if (sandboxView === 'min') setSandboxView('dock');
                  else if (sandboxView === 'dock') setSandboxView('min');
                  else setSandboxView('dock');
                }}
                aria-label={sandboxView === 'min' ? 'Expand code editor' : 'Collapse code editor'}
                className="w-9 h-9 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-[4px] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 transition-colors cursor-pointer flex items-center justify-center active:scale-95"
              >
                {sandboxView === 'min' ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
              {/* Maximize jumps the extremes (min/dock ⇄ full), skipping the
                  half sheet; from full the chevron collapses back through dock. */}
              <button
                onClick={() => {
                  if (sandboxView === 'full') {
                    setSandboxView('min');
                  } else {
                    setSandboxView('full');
                  }
                }}
                aria-label={sandboxView === 'full' ? 'Minimize code editor' : 'Maximize code editor'}
                className="w-9 h-9 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-[4px] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 transition-colors cursor-pointer flex items-center justify-center active:scale-95"
              >
                {sandboxView === 'full' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                onClick={() => setSelectedSandboxFile(null)}
                aria-label="Close code editor"
                className="w-9 h-9 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-[4px] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 transition-colors cursor-pointer flex items-center justify-center active:scale-95"
              >
                <X size={15} />
              </button>
            </div>
          </div>
          {/* Always mounted: drafts survive every switch, and the parent's
              explicit height is the only thing that animates. The body fades
              fast so text never smears mid-tween. */}
          <motion.div
            initial={false}
            animate={{ opacity: sandboxView === 'min' ? 0 : 1 }}
            transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.15 }}
            className="flex min-h-0 flex-col overflow-hidden"
            style={{ flex: '1 1 auto' }}
            aria-hidden={sandboxView === 'min'}
          >
            <SandboxCodeViewer path={selectedSandboxFile} workspaceId={activeWorkspaceId} channelId={activeChannelId} />
          </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

      {/* Dynamic Mention Suggestion — floats above composer, thumb-reachable */}
      {showMentions && filteredAgents.length > 0 && (
        <div className="mx-3 sm:mx-4 bg-[#1A1A1E] border border-zinc-800 rounded-2xl shadow-[0_16px_48px_rgba(10,14,32,0.6)] p-2 max-h-52 overflow-y-auto scrollbar-thin overscroll-contain mb-2 animate-scale-in" role="listbox" aria-label="Agent mentions">
          <div className="text-[13px] font-medium text-zinc-400 px-2.5 py-1 select-none">
            Agents: tap to mention
          </div>
          {filteredAgents.map((ag, index) => (
            <button
              key={ag.id}
              role="option"
              aria-selected={index === mentionIndex}
              onMouseEnter={() => setMentionIndex(index)}
              onClick={() => insertMention(ag)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 min-h-[46px] rounded-xl text-[13px] font-sans text-left transition-colors select-none cursor-pointer focus:outline-none active:scale-[0.99] ${
                index === mentionIndex ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-300 hover:bg-zinc-800 active:bg-zinc-800'
              }`}
            >
              <PresenceIndicator status={ag.status} size="sm" />
              <span className="font-medium">{ag.name}</span>
              <span className={`tnum text-[10px] font-mono px-1.5 py-0.5 rounded border ${index===mentionIndex ? 'bg-white/15 border-white/20 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-500'}`}>L{ag.level}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input Composer Zone — sticky, thumb-ergonomic, safe-area aware */}
      <div ref={composerBoxRef} className="p-3 sm:p-4 pb-3 bg-[#121214] shrink-0 relative border-t border-zinc-900/60" id="input-composer-container">

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`bg-[#1E1E21] border transition-all duration-200 rounded-xl flex flex-col gap-1 focus-within:shadow-[0_8px_32px_rgba(10,14,32,0.45)] focus-within:-translate-y-[1px] focus-within:border-zinc-700/80 ${
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
                          className="p-1.5 text-zinc-500 hover:text-indigo-400 transition-colors hover:bg-zinc-900 rounded-md focus:outline-none cursor-pointer"
                          title="Pin this mention"
                        >
                          <Pin size={13} />
                        </button>
                        <button
                          onClick={() => setSelectedMentions(prev => prev.filter(m => m.id !== ag.id))}
                          aria-label={`Remove ${ag.name}`}
                          className="p-1.5 text-zinc-500 hover:text-rose-400 transition-colors hover:bg-zinc-900 rounded-md focus:outline-none cursor-pointer"
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
                        className="absolute right-0.5 top-1/2 -translate-y-1/2 p-1.5 text-zinc-500 hover:text-rose-400 transition-colors hover:bg-zinc-900 rounded-md focus:outline-none cursor-pointer"
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
                          className="absolute right-0.5 top-1/2 -translate-y-1/2 p-1.5 text-indigo-400 hover:text-rose-400 transition-colors hover:bg-indigo-500/20 rounded-md focus:outline-none cursor-pointer"
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

          {/* Phase D strip (presentational, props only): runtime + mount +
              cost/context + elapsed, directly above the preflight line and
              the textarea. No store slice on purpose: the composer
              already owns mountScope/mode, so props are the single source.
              Mount/tooltips reuse the preflight + explorer view-models. */}
          <StatusStrip
            runtime={selectedMode}
            pinned={isPinned}
            mount={shortPath(mountScope.path) !== '' ? {
              shortPath: shortPath(mountScope.path),
              sourceLabel: sourceLabel(mountScope.source),
              sourceHint: sourceHint(mountScope.source),
              onOpen: () => setRightPanelView('repo'),
            } : null}
            contextPct={null}
            onContextOpen={() => setRightPanelView('telemetry')}
            tokens={null}
            runCost={null}
            onCostOpen={() => setRightPanelView('telemetry')}
            elapsedMs={null}
            runStartedAt={null}
          />
          <textarea
            ref={composerRef}
            rows={1}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleMentionKeydown}
            maxLength={MAX_MESSAGE_LEN}
            aria-label={`Message ${activeChannel ? activeChannel.name : 'channel'}`}
            placeholder={
              isDragging
                ? "Drop files here, release to attach"
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

          {/* Phase E: follow-up scope while a run is active. Queue-don't-lock:
              the composer stays usable during runs; this chooses whether the
              next send applies to the current run or starts the next turn. */}
          {isSending && activeChannelId && (
            <div className="flex items-center gap-1.5 px-4 pb-1.5" role="group" aria-label="Follow-up scope">
              <span className="text-[10px] font-mono text-zinc-500">Applies to</span>
              {(['current', 'next'] as const).map(scope => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setAppliesTo(activeChannelId, scope)}
                  aria-pressed={(appliesTo[activeChannelId] ?? 'next') === scope}
                  className={`px-2 py-1 text-[10px] font-mono rounded-md border transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 ${(appliesTo[activeChannelId] ?? 'next') === scope ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-200' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                >
                  {scope === 'current' ? 'Current run' : 'Next turn'}
                </button>
              ))}
            </div>
          )}

          {/* Action Bar — thumb-zone optimized, 44px min */}
          <div className="flex items-center justify-between p-2 pt-1 select-none shrink-0 gap-2">
            <div className="flex items-center gap-1 text-zinc-500 relative" ref={attachmentMenuRef}>
              <button
                onClick={() => setShowAttachmentMenu(!showAttachmentMenu)}
                aria-label="Attach files"
                aria-expanded={showAttachmentMenu}
                className={`w-11 h-11 rounded-xl border transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center active:scale-95 ${
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

                </div>
              )}

              {/* Emoji Picker Popover */}
              <div className="relative">
                <button
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  aria-label="Insert emoji"
                  aria-expanded={showEmojiPicker}
                  className={`w-11 h-11 rounded-xl border transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 flex items-center justify-center active:scale-95 ${
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
              <ModeSelector
                value={selectedMode}
                onChange={(m) => setMode(m, activeChannelId || undefined)}
                isPinned={isPinned}
                onTogglePin={togglePin}
              />
              <button
                onClick={handleSend}
                disabled={!canSend}
                aria-label="Send message"
                className={`min-w-[48px] min-h-[44px] sm:min-w-[56px] sm:min-h-[42px] px-3.5 sm:px-4 rounded-xl text-[14px] flex items-center justify-center gap-1.5 transition-all select-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:scale-[0.97] ${
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
    <NotificationCenter
      open={notificationCenterOpen}
      onClose={() => setNotificationCenterOpen(false)}
      channelId={activeChannelId}
      channelName={activeChannel?.name ?? null}
      isChannelMuted={isChannelMuted}
      onToggleMute={toggleMuteChannel}
    />
    {openRunThreadId && (
      <ThreadDrawer
        channelId={activeChannelId}
        runId={openRunThreadId}
        open
        onClose={() => setOpenRunThreadId(null)}
      />
    )}
    </div>
  );
}
