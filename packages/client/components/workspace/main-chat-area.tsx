import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Hash, Users, Search, Bell, Pin, Mail, HelpCircle, 
  Trash2, Send, PlusCircle, Smile, CircleX, ChevronRight, ChevronDown, ChevronUp, Sparkles,
  Paperclip, FileText, Image as ImageIcon, X, File,
  Telescope, Globe, MoreHorizontal, Clock, Terminal, FileCode2, BellOff
} from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowd-os-store';
import MessageRouter from './messages/message';
import MentionParser from './messages/mention-parser';
import { mockFileContent, SimpleSyntaxHighlighter } from './file-explorer';
import PresenceIndicator from './ui/presence-indicator';
import { Attachment, Agent } from '@/types/crowd-os';
import { useToast } from '@/components/ui/toast-provider';
import ConfirmDialog from '@/components/ui/confirm-dialog';
import EmojiPickerPopover from './emoji-picker-popover';

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
          className="px-3 py-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 disabled:opacity-50 border border-transparent hover:bg-zinc-800 rounded transition cursor-pointer"
        >
          Revert
        </button>
        <button 
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className="px-3.5 py-1 text-[11px] font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white rounded transition cursor-pointer shadow-sm"
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
    toggleRightSidebar,
    openAgentProfileModal,
    setMobileDrawerLeft,
    setMobileDrawerRight
  } = useCrowdOSStore();

  const { showSuccess, showInfo } = useToast();

  const [inputText, setInputText] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isSandboxMinimized, setIsSandboxMinimized] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [mutedChannels, setMutedChannels] = useState<Record<string, boolean>>({});

  // Active composer mode state
  const [activeMode, setActiveMode] = useState<'web' | 'research' | 'image' | null>(null);

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

  const handleCreateImageTrigger = () => {
    setActiveMode('image');
    setShowAttachmentMenu(false);
    composerRef.current?.focus();
  };

  const handleDeepResearchTrigger = () => {
    setActiveMode('research');
    setShowAttachmentMenu(false);
    composerRef.current?.focus();
  };

  const handleWebSearchTrigger = () => {
    setActiveMode('web');
    setShowAttachmentMenu(false);
    composerRef.current?.focus();
  };

  // File parsing procedures
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    addFilesToArray(e.target.files);
    e.target.value = '';
  };

  const addFilesToArray = (files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
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
          setAttachments(prev => [...prev, newAttachment]);
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

  // Find active workspace & channel
  const activeWS = workspaces.find(ws => ws.id === activeWorkspaceId);
  
  let activeChannel = null;
  if (activeWS) {
    for (const cat of activeWS.categories) {
      const ch = cat.channels.find(c => c.id === activeChannelId);
      if (ch) {
        activeChannel = ch;
        break;
      }
    }
    if (!activeChannel && activeWS.channels) {
      activeChannel = activeWS.channels.find(c => c.id === activeChannelId) || null;
    }
  }

  // Filter messages belonging to this channel
  const currentMessages = messages.filter(msg => msg.channelId === activeChannelId);
  const stickyMentions = activeChannelId ? (stickyMentionsByChannel[activeChannelId] || []) : [];

  // Check if any agent is currently active or executing in the swarm
  const activeExecutingAgents = agents.filter(a => a.status === 'executing' || a.status === 'thinking');
  const isSwarmActive = activeExecutingAgents.length > 0;

  // Handle scroll events to detect user scroll position
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setIsUserScrolledUp(distanceFromBottom > 120);
  };

  const scrollToBottom = (smooth = true) => {
    endRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    setIsUserScrolledUp(false);
  };

  // Smart Auto-scroll effect: scroll to bottom when messages or streaming content updates UNLESS user is reading history
  useEffect(() => {
    if (!isUserScrolledUp) {
      scrollToBottom(true);
    }
  }, [messages, isUserScrolledUp]);

  // Handle caret input change for mention detection
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
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
    const activeStickyMentions = activeChannelId ? (stickyMentionsByChannel[activeChannelId] || []) : [];
    if ((!inputText.trim() && attachments.length === 0 && selectedMentions.length === 0 && activeStickyMentions.length === 0) || !activeChannelId) return;

    const allMentions = [...selectedMentions, ...activeStickyMentions];

    let finalContent = inputText.trim();

    // Prepend Mode tags if active
    if (activeMode === 'web') {
      finalContent = `[WEB GROUNDED] ${finalContent}`;
    } else if (activeMode === 'research') {
      finalContent = `[DEEP RESEARCH] ${finalContent}`;
    } else if (activeMode === 'image') {
      finalContent = `@ImageGen ${finalContent}`;
    }

    if (allMentions.length > 0) {
      const uniqueMentions = Array.from(new Set(allMentions.map(a => a.name)));
      const mentionsPrefix = uniqueMentions.map(name => `@${name}`).join(' ');
      finalContent = finalContent ? `${mentionsPrefix} ${finalContent}` : mentionsPrefix;
    }

    addMessage({
      type: 'human',
      content: finalContent,
      authorId: 'user-01',
      authorName: 'Juan Hamzah',
      channelId: activeChannelId,
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions: allMentions.length > 0 ? Array.from(new Set(allMentions.map(a => a.name))) : undefined
    });

    setInputText('');
    setAttachments([]);
    setSelectedMentions([]);
    setShowMentions(false);
    setActiveMode(null);
  };

  const isChannelMuted = activeChannelId ? mutedChannels[activeChannelId] : false;

  const toggleMuteChannel = () => {
    if (!activeChannelId) return;
    const nextState = !isChannelMuted;
    setMutedChannels(prev => ({ ...prev, [activeChannelId]: nextState }));
    if (nextState) {
      showInfo('Channel Muted', `Notifications silenced for #${activeChannel?.name || 'channel'}.`);
    } else {
      showSuccess('Channel Unmuted', `Notifications enabled for #${activeChannel?.name || 'channel'}.`);
    }
  };

  const renderedMessages = [];
  for (let i = 0; i < currentMessages.length; i++) {
    const current = currentMessages[i];
    const prev = currentMessages[i - 1];

    const isGroupable = 
      prev && 
      prev.authorId === current.authorId && 
      !current.id.startsWith('stream-') &&
      !current.metadata?.monologue &&
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
      renderedMessages.push(
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
      renderedMessages.push(
        <MessageRouter 
          key={current.id} 
          message={current} 
          agentLevel={matchedAgent?.level ?? 3} 
        />
      );
    }
  }

  return (
    <div id="main-chat-area" className="flex-1 bg-[#121214] flex flex-col h-full overflow-hidden">
      {/* Top Channel Header Zone */}
      <div className="h-14 border-b border-zinc-900 px-4 flex items-center justify-between bg-[#121214]/90 backdrop-blur shrink-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <Hash size={18} className="text-zinc-500 shrink-0" />
          <h1 className="font-semibold text-zinc-100 text-sm tracking-tight truncate font-sans">
            {activeChannel ? activeChannel.name : 'select-channel'}
          </h1>
          {activeChannel?.description && (
            <>
              <span className="text-zinc-700 h-4 w-[1px] bg-zinc-800 mx-2 hidden sm:block" />
              <p className="text-xs text-zinc-400 truncate hidden sm:block font-sans">
                {activeChannel.description}
              </p>
            </>
          )}
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center gap-1">
          {/* Quick Search Button (Cmd+K) */}
          <button
            onClick={onOpenSearch}
            className="flex items-center gap-2 text-zinc-400 hover:text-zinc-100 px-2.5 py-1.5 bg-zinc-950 border border-zinc-850 hover:border-zinc-700 rounded-lg transition text-xs font-sans cursor-pointer focus:outline-none"
            title="Search (Cmd+K)"
          >
            <Search size={14} />
            <span className="hidden lg:inline text-[11px] font-mono text-zinc-500">Cmd+K</span>
          </button>

          {/* Clear Channel History Trigger */}
          {activeChannelId && currentMessages.length > 0 && (
            <button
              onClick={() => setConfirmClearOpen(true)}
              className="text-zinc-500 hover:text-rose-400 p-2 hover:bg-zinc-900 rounded-md transition cursor-pointer focus:outline-none"
              title="Clear Channel Audit Logs"
            >
              <Trash2 size={16} />
            </button>
          )}

          {/* Mute/Unmute Notifications Bell */}
          <button 
            onClick={toggleMuteChannel}
            className={`p-2 rounded-md transition focus:outline-none cursor-pointer hidden sm:block ${
              isChannelMuted ? 'text-rose-400 hover:bg-rose-500/10' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'
            }`}
            title={isChannelMuted ? "Unmute Channel" : "Mute Channel Notifications"}
          >
            {isChannelMuted ? <BellOff size={16} /> : <Bell size={16} />}
          </button>
          
          {/* Desktop Right Sidebar Selector */}
          <div className="hidden md:flex items-center bg-zinc-950 border border-zinc-900 rounded-lg p-0.5 ml-2">
            <button 
              onClick={() => setRightSidebarOpen(true)}
              className={`p-1.5 rounded-md transition cursor-pointer focus:outline-none flex items-center justify-center min-w-[32px] ${rightSidebarOpen ? 'text-indigo-400 bg-indigo-500/10 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Agent Roster"
            >
              <Users size={15} />
            </button>
            <button 
              onClick={() => setRightSidebarOpen(!rightSidebarOpen ? true : false)}
              className={`p-1.5 rounded-md transition cursor-pointer focus:outline-none flex items-center justify-center min-w-[32px] ${!rightSidebarOpen ? 'text-indigo-400 bg-indigo-500/10 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
              title={!rightSidebarOpen ? "Close Workspace Sandbox" : "Open Workspace Sandbox"}
            >
              <Terminal size={15} />
            </button>
          </div>
        </div>
      </div>

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

      {/* Message stream area */}
      <div 
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scroll-smooth pr-2 select-text selection:bg-indigo-500/30 relative"
      >
        {renderedMessages.length > 0 ? (
          renderedMessages
        ) : (
          /* Empty Channel state */
          <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-3 animate-fade-in-up select-none">
            <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-650">
              <Hash size={32} />
            </div>
            <div>
              <h3 className="font-semibold text-zinc-200 text-sm tracking-tight">
                Welcome to #{activeChannel ? activeChannel.name : 'CrowdOS Channel'}!
              </h3>
              <p className="text-xs text-zinc-550 max-w-sm mt-1 leading-normal font-sans">
                This operations zone is ready for dispatch logs. Connect and initialize subtask parameters to record actions here.
              </p>
            </div>
          </div>
        )}
        <div ref={endRef} />

        {/* Floating Jump to Present Button */}
        {isUserScrolledUp && (
          <div className="sticky bottom-3 flex justify-center w-full pointer-events-none z-20">
            <button
              onClick={() => scrollToBottom(true)}
              className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-semibold shadow-2xl transition cursor-pointer border border-indigo-400/30 animate-bounce"
            >
              <span>Jump to Present</span>
              <ChevronDown size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Dynamic Mention Suggestion Floating Box */}
      {showMentions && filteredAgents.length > 0 && (
        <div className="mx-4 bg-zinc-950 border border-zinc-900 rounded-lg shadow-2xl p-1.5 max-h-48 overflow-y-auto mb-1 animate-scale-in">
          <div className="text-[9px] font-mono font-bold text-zinc-500 px-2 py-1 select-none">
            AGENT DIRECTORIES (@)
          </div>
          {filteredAgents.map((ag, index) => (
            <button
              key={ag.id}
              onClick={() => insertMention(ag)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-mono text-left transition select-none cursor-pointer focus:outline-none ${
                index === mentionIndex ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-300 hover:bg-zinc-900'
              }`}
            >
              <PresenceIndicator status={ag.status} size="sm" />
              <span className="font-semibold">{ag.name}</span>
              <span className="text-[10px] text-zinc-500">Tier L{ag.level}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input Composer Zone */}
      <div className="p-3 md:p-4 bg-[#121214] shrink-0 relative" id="input-composer-container">
        
        {/* Code Preview Pane (Popup) */}
        {selectedSandboxFile && (
          <div className={`absolute bottom-full left-3 right-3 md:left-4 md:right-4 mb-2 flex flex-col bg-[#0c0c0e] rounded-xl border border-zinc-800 shadow-[0_-8px_30px_rgba(0,0,0,0.6)] z-20 overflow-hidden transition-all duration-300 ${isSandboxMinimized ? 'h-[36px]' : 'h-72 animate-slide-up'}`}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-900 bg-zinc-950/80 shrink-0 select-none">
              <div className="flex items-center gap-2">
                <FileCode2 size={13} className="text-zinc-500" />
                <span className="text-xs font-sans font-medium text-zinc-300 tracking-tight">{selectedSandboxFile}</span>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => setIsSandboxMinimized(!isSandboxMinimized)}
                  className="text-zinc-500 hover:text-zinc-200 p-1 hover:bg-zinc-800 rounded-md focus:outline-none transition cursor-pointer"
                  title={isSandboxMinimized ? "Expand" : "Minimize"}
                >
                  {isSandboxMinimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                <button 
                  onClick={() => setSelectedSandboxFile(null)}
                  className="text-zinc-500 hover:text-zinc-200 p-1 hover:bg-zinc-800 rounded-md focus:outline-none transition cursor-pointer"
                >
                  <X size={14} />
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
          className={`bg-zinc-900 border transition-all duration-200 rounded-xl md:rounded-2xl flex flex-col gap-1 focus-within:shadow-[0_4px_16px_rgba(0,0,0,0.3)] focus-within:-translate-y-[1px] ${
            isDragging 
              ? 'border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/20' 
              : 'border-zinc-800/80 focus-within:border-zinc-700 focus-within:ring-1 focus-within:ring-zinc-700/40'
          }`}
        >
          {/* Active Mode Badge & Attachments row */}
          {(activeMode || attachments.length > 0 || selectedMentions.length > 0 || stickyMentions.length > 0) && (
            <div className="flex justify-between items-start p-2 pb-0 border-b border-zinc-900/40 bg-zinc-950/25 rounded-t-xl mb-1 select-none max-h-32 overflow-y-auto gap-4">
              <div className="flex flex-wrap gap-2 items-center">
                {/* Active Mode Pill Badge */}
                {activeMode && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-[11px] font-mono font-semibold shadow-sm animate-scale-in">
                    {activeMode === 'web' && <Globe size={13} className="text-cyan-400" />}
                    {activeMode === 'research' && <Telescope size={13} className="text-purple-400" />}
                    {activeMode === 'image' && <ImageIcon size={13} className="text-emerald-400" />}
                    <span className="uppercase">
                      {activeMode === 'web' && 'Web Grounded Active'}
                      {activeMode === 'research' && 'Deep Research Active'}
                      {activeMode === 'image' && 'Image Generation Active'}
                    </span>
                    <button
                      onClick={() => setActiveMode(null)}
                      className="p-0.5 hover:bg-indigo-500/20 rounded-full transition focus:outline-none cursor-pointer ml-1"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                <AnimatePresence>
                  {selectedMentions.map((ag) => (
                    <motion.div 
                      layout
                      layoutId={`mention-${ag.id}`}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ type: "spring", stiffness: 400, damping: 25 }}
                      key={ag.id}
                      className="relative flex items-center gap-2 pl-2.5 pr-14 py-1.5 rounded-lg bg-[#0e0e11] border border-zinc-800 text-[11px] w-fit shadow-sm group"
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
                          className="p-1 text-zinc-500 hover:text-indigo-400 transition hover:bg-zinc-900 rounded-full focus:outline-none cursor-pointer"
                          title="Pin this mention"
                        >
                          <Pin size={12} />
                        </button>
                        <button
                          onClick={() => setSelectedMentions(prev => prev.filter(m => m.id !== ag.id))}
                          className="p-1 text-zinc-500 hover:text-rose-400 transition hover:bg-zinc-900 rounded-full focus:outline-none cursor-pointer"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                <AnimatePresence>
                  {attachments.map((att) => (
                    <motion.div 
                      layout
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      key={att.id}
                      className="relative flex items-center gap-2 pl-2.5 pr-8 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] w-fit shadow-sm"
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
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-rose-400 transition hover:bg-zinc-900 rounded-full focus:outline-none cursor-pointer"
                      >
                        <X size={12} />
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
                        layout
                        layoutId={`mention-${ag.id}`}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                        key={`sticky-${ag.id}`}
                        className="relative flex items-center gap-2 pl-2.5 pr-8 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-[11px] w-fit shadow-sm"
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
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-indigo-400 hover:text-rose-400 transition hover:bg-indigo-500/20 rounded-full focus:outline-none cursor-pointer"
                        >
                          <X size={12} />
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
            placeholder={
              isDragging 
                ? "Drop file(s) here" 
                : `Message #${activeChannel ? activeChannel.name : 'operational-matrix'}`
            }
            className="w-full bg-transparent border-0 text-[15px] sm:text-sm text-zinc-100 placeholder-zinc-500 focus:ring-0 focus:outline-none resize-none px-3.5 pt-3 pb-1 md:py-3 leading-relaxed caret-indigo-400 select-text"
            style={{ minHeight: '48px', maxHeight: '160px' }}
          />
          
          {/* Action Bar */}
          <div className="flex items-center justify-between p-1.5 pt-0 select-none shrink-0">
            <div className="flex items-center gap-1 text-zinc-500 relative" ref={attachmentMenuRef}>
              <button 
                onClick={() => setShowAttachmentMenu(!showAttachmentMenu)}
                className={`p-2 rounded-lg transition cursor-pointer focus:outline-none ${
                  showAttachmentMenu ? 'text-indigo-400 bg-indigo-500/10' : 'hover:text-zinc-300 hover:bg-zinc-800/80'
                }`}
                title="Attach files or triggers"
              >
                <PlusCircle size={20} />
              </button>

              {/* Advanced Attachment & Operation Portal Menu */}
              {showAttachmentMenu && (
                <div 
                  className="absolute bottom-12 left-0 z-50 w-64 bg-[#141416] border border-zinc-800/90 rounded-2xl shadow-2xl py-2 px-1.5 animate-scale-in text-zinc-300 select-none text-left"
                  id="attachment-menu-popover"
                >
                  <button
                    onClick={() => {
                      fileInputRef.current?.click();
                      setShowAttachmentMenu(false);
                    }}
                    type="button"
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/80 hover:text-white rounded-xl transition text-[13px] font-medium cursor-pointer focus:outline-none"
                  >
                    <Paperclip size={16} className="text-zinc-400 shrink-0" />
                    <span>Add photos & files</span>
                  </button>

                  <button
                    onClick={handleAttachRecentFile}
                    type="button"
                    className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-zinc-800/80 hover:text-white rounded-xl transition text-[13px] font-medium cursor-pointer focus:outline-none"
                  >
                    <div className="flex items-center gap-3">
                      <Clock size={16} className="text-zinc-400 shrink-0" />
                      <span>Recent files</span>
                    </div>
                    <ChevronRight size={14} className="text-zinc-550 shrink-0" />
                  </button>

                  <div className="h-[1px] bg-zinc-800/40 my-1 mx-2" />

                  <button
                    onClick={handleCreateImageTrigger}
                    type="button"
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/80 hover:text-white rounded-xl transition text-[13px] font-medium cursor-pointer focus:outline-none"
                  >
                    <ImageIcon size={16} className="text-emerald-400 shrink-0" />
                    <span>Create image</span>
                  </button>

                  <button
                    onClick={handleDeepResearchTrigger}
                    type="button"
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/80 hover:text-white rounded-xl transition text-[13px] font-medium cursor-pointer focus:outline-none"
                  >
                    <Telescope size={16} className="text-purple-400 shrink-0" />
                    <span>Deep research</span>
                  </button>

                  <button
                    onClick={handleWebSearchTrigger}
                    type="button"
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/80 hover:text-white rounded-xl transition text-[13px] font-medium cursor-pointer focus:outline-none"
                  >
                    <Globe size={16} className="text-cyan-400 shrink-0" />
                    <span>Web search</span>
                  </button>
                </div>
              )}

              {/* Emoji Picker Popover */}
              <div className="relative">
                <button
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  className={`p-2 rounded-lg transition cursor-pointer focus:outline-none ${
                    showEmojiPicker ? 'text-indigo-400 bg-indigo-500/10' : 'hover:text-zinc-300 hover:bg-zinc-800/80'
                  }`}
                  title="Insert emoji"
                >
                  <Smile size={20} />
                </button>

                <EmojiPickerPopover
                  open={showEmojiPicker}
                  onSelect={(emoji) => setInputText(prev => prev + emoji)}
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

            <button
              onClick={handleSend}
              disabled={!inputText.trim() && attachments.length === 0 && !activeMode}
              className={`px-3.5 py-1.5 md:px-4 md:py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 transition select-none cursor-pointer focus:outline-none ${
                inputText.trim() || attachments.length > 0 || activeMode
                  ? 'bg-indigo-500 text-white font-medium hover:bg-indigo-600 shadow-md hover:-translate-y-[1px]' 
                  : 'bg-zinc-800/50 text-zinc-500 cursor-not-allowed'
              }`}
            >
              <Send size={15} />
              <span className="hidden sm:inline">Send</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

