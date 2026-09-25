import { create } from 'zustand';
import { socket, emitChannelJoin, emitChannelLeave, emitWorkspaceLeave } from '../src/config/socket';
import { stripToolCalls } from '@crowdspace/shared';
import {
  encodeBeforeParam,
  parseMessagesEnvelope,
  prependOlderMessages,
  capMessagesMirror,
  MESSAGE_MIRROR_CAP_PER_CHANNEL
} from './messagePagination';
import type { PageCursor } from './messagePagination';
import { apiClient, setActiveWorkspaceId } from '../src/api/client';
import { setActiveWorkspaceIdGetter, withTenantHeaders } from '../src/config/pin';
import { isScreenlockError, useScreenLockStore } from './screenLockStore';

// UX-7: DEMO_FALLBACK honesty — when false, outages show errors, not seeded demo data
const DEMO_FALLBACK: boolean = (() => {
  try {
    const viteFlag = (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_DEMO_FALLBACK;
    if (viteFlag === 'true') return true;
    if (viteFlag === 'false') return false;
  } catch {}
  try {
    const nodeFlag = (typeof process !== 'undefined' ? (process as unknown as { env?: Record<string, string> })?.env?.DEMO_FALLBACK : undefined);
    if (nodeFlag === 'true') return true;
    if (nodeFlag === 'false') return false;
  } catch {}
  return false;
})();

// Tenant header source for the global fetch patch (src/config/pin.ts). The
// patch injects x-workspace-id into every /api/ fetch that a caller (legacy
// direct fetch calls in this store included) did not scope explicitly.
// Registered at module load, before any request can fire.
setActiveWorkspaceIdGetter(() => useCrowdOSStore.getState().activeWorkspaceId);
import { 
  Agent, 
  AgentStatus,
  AgentLevel,
  Workspace, 
  Message, 
  ModelProfile, 
  InstructionModule, 
  ModelModule, 
  ToolkitModule, 
  RuntimeOverride, 
  Tool, 
  Role,
  Channel,
  Category,
  ConstraintsModule,
  CapabilitiesModule,
  ComposerMode,
  composerModeToRuntime,
  runtimeToComposerMode
} from '../types/crowdOs';

export interface ApprovalRequest {
  id: string;
  runId: string;
  tool: string;
  argsPreview: Record<string, unknown> | null;
  riskClass: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  channelId?: string | null;
  scope?: string | null;
  expiresAt?: string | null;
  requestedBy?: string | null;
}

export interface ArtifactRow {
  id: string;
  runId: string | null;
  workspaceId: string;
  producerAgent: string;
  artifactType: string;
  path: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  patch: string | null;
  contentRef: string | null;
  createdAt: string;
}

const BACKEND_URL = '';

function loadSeqCursors(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem('crowdos_seq_cursors');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
    }
  } catch {}
  return {};
}

function persistSeqCursors(map: Record<string, number>) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem('crowdos_seq_cursors', JSON.stringify(map)); } catch {}
}

let _persistSeqTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistSeqCursors(map: Record<string, number>) {
  if (typeof localStorage === 'undefined') return;
  if (_persistSeqTimer) return;
  _persistSeqTimer = setTimeout(() => {
    _persistSeqTimer = null;
    try {
      const idle = (globalThis as any).requestIdleCallback as ((cb: () => void) => void) | undefined;
      if (idle) idle(() => persistSeqCursors(map));
      else persistSeqCursors(map);
    } catch { persistSeqCursors(map); }
  }, 500);
}

function isChannelMutedLS(channelId: string): boolean {
  if (typeof localStorage === 'undefined' || !channelId) return false;
  try {
    if (localStorage.getItem(`crowdos_mute_${channelId}`) === 'true') return true;
    const raw = localStorage.getItem('crowdos_muted_channels');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed[channelId]) return true;
    }
  } catch {}
  return false;
}

function unwrapEnvelope(raw: any): { payload: any; seq: number | null; type?: string; eventId?: string } {
  if (raw && typeof raw === 'object' && 'payload' in raw && ('eventId' in raw || 'type' in raw || 'seq' in raw)) {
    return { payload: raw.payload, seq: raw.seq ?? null, type: raw.type, eventId: raw.eventId };
  }
  return { payload: raw, seq: raw?.seq ?? null, type: raw?.type, eventId: raw?.eventId };
}

// DEFENCE-IN-DEPTH ONLY (§30). The server now namespaces every socket room by
// workspace (`ws:<workspaceId>:channel:<channelId>` / `ws:<workspaceId>`), so a
// foreign workspace's events never reach this client's socket in the first
// place — server-side room scoping is the PRIMARY defence. This filter stays as
// a cheap belt-and-braces check for global/mirrored broadcasts that are tagged
// with a workspace id (e.g. runtime:snapshot, workspace-room mirrors): it drops
// anything tagged for a different workspace than the one currently open.
// Untagged events pass. Do NOT rely on this as the isolation boundary.
function isForeignWorkspacePayload(payload: any): boolean {
  const wid = payload?.workspaceId;
  return typeof wid === 'string' && wid.length > 0 && wid !== useCrowdOSStore.getState().activeWorkspaceId;
}

async function readApiError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { message?: string; error?: string };
    return new Error(body.message || body.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

async function fetchJsonOrThrow<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  // Tenant-aware: legacy direct fetches here must carry x-workspace-id like
  // apiClient does (the global patch is the backstop, not the only layer).
  const response = await fetch(url, withTenantHeaders(init));
  if (!response.ok) {
    throw await readApiError(response, fallback);
  }
  return response.json() as Promise<T>;
}

async function fetchNoContentOrThrow(url: string, init: RequestInit, fallback: string): Promise<void> {
  const response = await fetch(url, withTenantHeaders(init));
  if (!response.ok) {
    throw await readApiError(response, fallback);
  }
}

function mapBackendChannel(channel: any, description: string): Channel {
  return {
    id: channel.id,
    name: channel.name,
    description,
    unreadCount: 0,
    hasMention: false,
    categoryId: channel.categoryId ?? null,
    type: channel.type,
    position: channel.position,
    archivedAt: channel.archivedAt ?? null
  };
}

function getFirstChannelId(workspace?: Workspace): string | null {
  return workspace?.channels?.[0]?.id || workspace?.categories.flatMap(category => category.channels)[0]?.id || null;
}

function getHashChannelId(): string | null {
  if (typeof window === 'undefined' || !window.location.hash) return null;
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash) return null;
  // supports #ch-xxx or #workspaceId/ch-xxx or #channel=ch-xxx
  if (hash.includes('channel=')) {
    const m = hash.match(/channel=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  const parts = hash.split('/');
  return parts[parts.length - 1] || null;
}

function pushChannelHistory(workspaceId: string | null, channelId: string | null, replace = false) {
  if (typeof window === 'undefined') return;
  if (!workspaceId || !channelId) return;
  const next = `#${workspaceId}/${channelId}`;
  if (window.location.hash === next) return;
  try {
    if (replace) window.history.replaceState({ workspaceId, channelId }, '', next);
    else window.history.pushState({ workspaceId, channelId }, '', next);
  } catch {}
}

function persistActiveChannel(channelId: string | null) {
  if (typeof localStorage === 'undefined') return;
  if (channelId) localStorage.setItem('crowdos_active_channel', channelId);
  else localStorage.removeItem('crowdos_active_channel');
}

// PERF-5: localStorage mirror is capped per channel so it cannot grow unbounded.
function writeMessagesMirror(messages: Message[]) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem('crowdos_messages', JSON.stringify(capMessagesMirror(messages)));
}

let _writeMirrorTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingMirrorMessages: Message[] | null = null;
function scheduleWriteMessagesMirror(messages: Message[]) {
  _pendingMirrorMessages = messages;
  if (_writeMirrorTimer) return;
  _writeMirrorTimer = setTimeout(() => {
    const toWrite = _pendingMirrorMessages;
    _pendingMirrorMessages = null;
    _writeMirrorTimer = null;
    if (toWrite) {
      const idle = (globalThis as any).requestIdleCallback as ((cb: () => void) => void) | undefined;
      if (idle) idle(() => writeMessagesMirror(toWrite));
      else writeMessagesMirror(toWrite);
    }
  }, 500);
}
function flushWriteMessagesMirrorImmediate(messages: Message[]) {
  if (_writeMirrorTimer) { clearTimeout(_writeMirrorTimer); _writeMirrorTimer = null; _pendingMirrorMessages = null; }
  writeMessagesMirror(messages);
}

function mapBackendMessage(msg: any): Message {
  return {
    id: msg.id,
    type: msg.type || (msg.authorType === 'user' ? 'human' : 'agent'),
    content: stripToolCalls(msg.content || ''),
    authorId: msg.authorId,
    authorName: msg.authorName,
    authorAvatar: msg.authorType === 'user' ? undefined : '🤖',
    channelId: msg.channelId,
    timestamp: new Date(msg.timestamp).toISOString(),
    metadata: msg.metadata
      ? {
          ...msg.metadata,
          monologue: msg.metadata.monologue ? stripToolCalls(msg.metadata.monologue) : undefined
        }
      : undefined,
    toolExecution: msg.toolExecution || undefined
  };
}

function toBackendAgentStatus(status?: AgentStatus): 'idle' | 'working' | 'paused' | 'offline' | undefined {
  if (!status) return undefined;
  if (status === 'paused' || status === 'offline' || status === 'idle' || status === 'working') return status;
  if (status === 'active' || status === 'thinking' || status === 'delegating' || status === 'executing') return 'working';
  return 'offline';
}

interface CrowdOSState {
  // Data
  workspaces: Workspace[];
  agents: Agent[];
  messages: Message[];
  modelProfiles: ModelProfile[];
  instructionModules: InstructionModule[];
  modelModules: ModelModule[];
  toolkitModules: ToolkitModule[];
  constraintsModules: ConstraintsModule[];
  capabilitiesModules: CapabilitiesModule[];
  runtimeOverrides: RuntimeOverride[];
  tools: Tool[];
  roles: Role[];
  archivedChannels: Channel[];

  // Budget Telemetry
  globalSoftCap: number;
  perProviderBudget: Record<string, { softCap: number; used: number; resetPeriod: 'daily' | 'weekly' | 'monthly' | 'never'; lastResetAt?: string }>;
  totalTokensConsumed: number;

  // Selection & UI
  activeWorkspaceId: string | null;
  activeChannelId: string | null;
  selectedAgentId: string | null;
  selectedSandboxFile: string | null;
  filesystemRevision: number;
  rightSidebarOpen: boolean;
  leftSidebarCollapsed: boolean;
  settingsModalOpen: boolean;
  agentProfileModalOpen: boolean;
  workspaceSettingsTab: string;

  // Mobile navigation
  activeMobileTab: 'channels' | 'chat' | 'agents' | 'stats' | 'settings';
  mobileDrawerLeft: boolean;
  mobileDrawerRight: boolean;

  // Search & Filters
  chatSearchQuery: string;

  // Composer Mode State
  selectedMode: ComposerMode;
  isPinned: boolean;
  /**
   * §6 per-Channel pin. The pin belongs to the CHANNEL, not the browser: pinning
   * Coding in #bug-fix must leave every other channel alone, and returning to
   * #bug-fix must restore it.
   *
   * `pinnedModeByChannel` is the local mirror of `channel_settings.pinned_runtime`
   * for instant UI feedback; the server row is the source of truth and is
   * hydrated by `hydrateChannelPin`. `isPinned` remains as a DERIVED convenience
   * for the ACTIVE channel only — it is never the stored truth.
   */
  pinnedModeByChannel: Record<string, ComposerMode>;
  setMode: (mode: ComposerMode, channelId?: string) => void;
  togglePin: () => void;
  /** Read the channel's persisted pin and apply it to the composer. */
  hydrateChannelPin: (channelId: string) => Promise<void>;
  resetOnChannelChange: (channelId?: string) => void;

  // Async indicators
  isFetchingWorkspaces: boolean;
  isCreatingWorkspace: boolean;
  isUpdatingWorkspace: boolean;
  isDatabaseOffline: boolean;
  databaseErrorMessage: string | null;
  workspaceError: string | null;

  // Actions
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, dbUrl?: string, icon?: string) => Promise<void>;
  updateWorkspace: (id: string, patch: { name?: string; icon?: string; databaseUrl?: string | null; storagePreference?: 'default' | 'local' }) => Promise<void>;
  deleteWorkspace: (id: string, opts?: { flush?: boolean }) => Promise<void>;
  enterWorkspace: (id: string) => Promise<void>;
  leaveWorkspace: () => void;
  // Dual-boot sync state (per active workspace; null when unknown)
  dbSyncStatus: {
    storagePreference: 'default' | 'local';
    tier: 'dual' | 'local';
    dbConfigured: boolean;
    dbReachable: boolean;
    dbSync: { dbWorkspaceId: string | null; state: string; updatedAt: string } | null;
    backlog: number;
    backlogNotice: boolean;
    suggestion?: string;
  } | null;
  isSyncing: boolean;
  fetchDbSync: (id?: string) => Promise<void>;
  setStoragePreference: (id: string, preference: 'default' | 'local') => Promise<void>;
  resolveDbConflict: (id: string, choice: 'flush-local' | 'flush-db' | 'change-db') => Promise<any>;
  syncNow: (id: string) => Promise<any>;
  rebuildRag: (id: string) => Promise<any>;
  clearTenantSlices: () => void;
  setActiveChannel: (id: string) => Promise<void>;
  
  // Message actions
  addMessage: (msg: Omit<Message, 'id' | 'timestamp'> & { runtimeMode?: string }) => void;
  clearChannelMessages: (channelId: string) => void;

  // PERF-5 pagination state
  channelCursors: Record<string, PageCursor | null>;
  isLoadingOlder: boolean;
  loadOlderMessages: () => Promise<void>;

  // Agent actions
  addAgent: (agent: Omit<Agent, 'id' | 'createdAt' | 'lastActive'>) => Promise<void>;
  updateAgentStatus: (id: string, status: Agent['status']) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  openAgentProfileModal: (agentId: string) => void;
  closeAgentProfileModal: () => void;

  // Model Profile CRUD
  addModelProfile: (profile: Omit<ModelProfile, 'id' | 'createdAt'>) => Promise<void>;
  updateModelProfile: (id: string, patch: Partial<ModelProfile>) => Promise<void>;
  deleteModelProfile: (id: string) => Promise<void>;

  // Module actions
  addInstructionModule: (mod: Omit<InstructionModule, 'id' | 'createdAt'>) => Promise<void>;
  updateInstructionModule: (id: string, patch: Partial<InstructionModule>) => Promise<void>;
  deleteInstructionModule: (id: string) => Promise<void>;

  addModelModule: (mod: Omit<ModelModule, 'id' | 'createdAt'>) => Promise<void>;
  updateModelModule: (id: string, patch: Partial<ModelModule>) => Promise<void>;
  deleteModelModule: (id: string) => Promise<void>;

  addToolkitModule: (mod: Omit<ToolkitModule, 'id' | 'createdAt'>) => Promise<void>;
  updateToolkitModule: (id: string, patch: Partial<ToolkitModule>) => Promise<void>;
  deleteToolkitModule: (id: string) => Promise<void>;

  addConstraintsModule: (mod: Omit<ConstraintsModule, 'id' | 'createdAt'>) => Promise<void>;
  updateConstraintsModule: (id: string, patch: Partial<ConstraintsModule>) => Promise<void>;
  deleteConstraintsModule: (id: string) => Promise<void>;

  addCapabilitiesModule: (mod: Omit<CapabilitiesModule, 'id' | 'createdAt'>) => Promise<void>;
  updateCapabilitiesModule: (id: string, patch: Partial<CapabilitiesModule>) => Promise<void>;
  deleteCapabilitiesModule: (id: string) => Promise<void>;

  // Override actions
  addRuntimeOverride: (override: Omit<RuntimeOverride, 'id' | 'createdAt'>) => void;
  toggleRuntimeOverride: (id: string, active: boolean) => void;
  deleteRuntimeOverride: (id: string) => void;

  // Layout UI Toggles
  toggleRightSidebar: () => void;
  setRightSidebarOpen: (isOpen: boolean) => void;
  toggleLeftSidebar: () => void;
  setSettingsModalOpen: (open: boolean) => void;
  setWorkspaceSettingsTab: (tab: string) => void;
  toggleCategoryCollapse: (categoryId: string) => void;
  deleteCategory: (categoryId: string) => Promise<void>;
  createCategory: (name: string) => Promise<void>;
  createChannel: (categoryId: string | null, name: string, description?: string) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  archiveChannel: (channelId: string, archive: boolean) => Promise<void>;
  reorderCategory: (categoryId: string, direction: 'up' | 'down') => Promise<void>;
  reorderChannel: (channelId: string, direction: 'up' | 'down') => Promise<void>;

  setSelectedSandboxFile: (file: string | null) => void;
  incrementFilesystemRevision: () => void;

  // Mobile Layout Actions
  setActiveMobileTab: (tab: CrowdOSState['activeMobileTab']) => void;
  setMobileDrawerLeft: (open: boolean) => void;
  setMobileDrawerRight: (open: boolean) => void;
  selectChannelMobile: (channelId: string) => void;

  // Tools Setup Toggle
  toggleToolEnabled: (toolId: string) => void;
  incrementToolUsage: (toolId: string) => void;

  // Roles Mutation
  addRole: (role: Omit<Role, 'id'>) => void;
  updateRole: (id: string, patch: Partial<Role>) => void;
  reorderRoles: (startIndex: number, endIndex: number) => void;
  deleteRole: (id: string) => void;

  // Budget Actions
  fetchBudget: () => Promise<void>;
  updateBudget: (globalSoftCap?: number, perProviderBudget?: any) => Promise<void>;
  resetBudget: () => Promise<void>;

  // UX-1 cancel + UX-5 background continuity
  channelSeq: Record<string, number>;
  reconnectDigest: { message: string; visible: boolean } | null;
  cancellingByAgent: Record<string, boolean>;
  cancelRun: (channelId: string, agentId?: string) => void;
  clearReconnectDigest: () => void;
  /** §30: joins the channel room within the given workspace scope (defaults to the active one). */
  emitChannelJoin: (channelId: string, workspaceId?: string | null) => void;
  isChannelMuted: (channelId: string) => boolean;

  // UX-2 Approval cards
  approvalRequests: ApprovalRequest[];
  decideApproval: (approvalId: string, decision: 'approved' | 'denied', scope?: string | null) => Promise<void>;

  // UX-3 Diff review
  artifactsByRun: Record<string, ArtifactRow[]>;
  fetchArtifacts: (runId: string) => Promise<void>;
  applyDiff: (artifactId: string) => Promise<void>;
  revertDiff: (artifactId: string) => Promise<void>;

  // UX-4 Edit/regenerate/retry
  editResend: (originalMessageId: string, newContent: string) => void;
  regenerate: (messageId: string) => void;
  retryRun: (runId: string) => Promise<void>;
}

import { initialTools, initialRoles, initialModelProfiles, initialInstructionModules, initialModelModules, initialToolkitModules, initialAgents, defaultWorkspaces, initialMessages } from './initialData';

export const useCrowdOSStore = create<CrowdOSState>((set, get) => {
  // Read initial workspace state from localStorage if available
  let storedWorkspaceId = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_workspace') : null;
  if (storedWorkspaceId === 'ws-crowdos') {
    storedWorkspaceId = 'crowdos';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('crowdos_active_workspace', 'crowdos');
    }
  }

  const storedWorkspaces = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_workspaces') : null;
  let parsedWorkspaces = storedWorkspaces ? JSON.parse(storedWorkspaces) : defaultWorkspaces;

  // Migrate any old 'ws-crowdos' entry in the workspaces array
  let migratedWorkspaces = false;
  parsedWorkspaces = parsedWorkspaces.map((ws: any) => {
    if (ws.id === 'ws-crowdos') {
      migratedWorkspaces = true;
      return { ...ws, id: 'crowdos' };
    }
    return ws;
  });
  if (migratedWorkspaces && typeof localStorage !== 'undefined') {
    localStorage.setItem('crowdos_workspaces', JSON.stringify(parsedWorkspaces));
  }

  const storedAgents = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_agents') : null;
  const storedProfiles = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_model_profiles') : null;
  const storedMessages = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_messages') : null;
  const storedInstructionModules = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_instruction_modules') : null;
  const storedModelModules = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_model_modules') : null;
// §6 per-channel pin mirror. `crowdos_pinned_modes` is { channelId: ComposerMode }.
//
// The old GLOBAL keys (crowdos_is_pinned / crowdos_selected_mode) described the
// pre-§6 design where one pin applied to every channel; they are deliberately
// NOT migrated, because a single global value cannot be attributed to any one
// channel. The server row (channel_settings.pinned_runtime) is the real source
// of truth and is re-hydrated per channel by hydrateChannelPin, so a stale
// browser mirror self-corrects on the next channel entry.
const storedPinnedModes: Record<string, ComposerMode> = (() => {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem('crowdos_pinned_modes');
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, ComposerMode>) : {};
    }
  } catch {
    // Malformed mirror is not fatal — the server row re-hydrates it.
  }
  return {};
})();
// §6 cold start: the restored channel's own pin decides the composer state.
// `hydrateChannelPin` reconciles against the server row once the app is live;
// this seeds the mirror so the first paint already reflects the pin.
const initialSelectedMode: ComposerMode = (() => {
  const restored = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_channel') : null;
  return restored && storedPinnedModes[restored] ? storedPinnedModes[restored] : 'auto';
})();
  const storedToolkitModules = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_toolkit_modules') : null;

  const parsedActiveId = storedWorkspaceId || (parsedWorkspaces.length > 0 ? parsedWorkspaces[0].id : null);
  const parsedAgents = storedAgents ? JSON.parse(storedAgents) : initialAgents;
  const parsedProfiles = storedProfiles ? JSON.parse(storedProfiles) : initialModelProfiles;
  const parsedMessages = capMessagesMirror(storedMessages ? JSON.parse(storedMessages) : initialMessages, MESSAGE_MIRROR_CAP_PER_CHANNEL);
  const parsedInstructionModules = storedInstructionModules ? JSON.parse(storedInstructionModules) : initialInstructionModules;
  const parsedModelModules = storedModelModules ? JSON.parse(storedModelModules) : initialModelModules;
  const parsedToolkitModules = storedToolkitModules ? JSON.parse(storedToolkitModules) : initialToolkitModules;
  // Resolve active channel — hash > persisted > first channel
  const currentWS = parsedWorkspaces.find((w: Workspace) => w.id === parsedActiveId);
  const storedChannelId = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_channel') : null;
  const hashChannelId = getHashChannelId();
  const allChannelIdsForInit = new Set([
    ...((currentWS as any)?.channels?.map((c: Channel) => c.id) || []),
    ...((currentWS?.categories.flatMap((category: any) => category.channels.map((ch: any) => ch.id)) || []) as string[])
  ]);
  const initialChannelId = (() => {
    if (hashChannelId && allChannelIdsForInit.has(hashChannelId)) return hashChannelId;
    if (storedChannelId && allChannelIdsForInit.has(storedChannelId)) return storedChannelId;
    return getFirstChannelId(currentWS as Workspace | undefined);
  })();
  if (parsedActiveId && initialChannelId) {
    persistActiveChannel(initialChannelId);
    // seed history without pushing duplicate entry
    if (typeof window !== 'undefined' && !window.location.hash) {
      pushChannelHistory(parsedActiveId, initialChannelId, true);
    }
  }

  const seqCursors: Record<string, number> = loadSeqCursors();
  let wasDisconnected = false;

  function persistSeq(channelId: string, seq: number) {
    if (!channelId || typeof seq !== 'number' || Number.isNaN(seq)) return;
    const cur = seqCursors[channelId] ?? 0;
    if (seq > cur) {
      seqCursors[channelId] = seq;
      schedulePersistSeqCursors(seqCursors);
      set((s: any) => ({ channelSeq: { ...s.channelSeq, [channelId]: seq } }));
    }
  }

  function emitChannelJoinDebounced(channelId: string) {
    if (!channelId) return;
    // §30: send the active workspace alongside the channel so the server can
    // scope the join; the server still derives the authoritative room key from
    // the channel row itself.
    try { emitChannelJoin(channelId, get().activeWorkspaceId); } catch {}
  }

  async function fetchGapAndDigest(channelId: string, afterSeq: number) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/events/recent?channelId=${encodeURIComponent(channelId)}&afterSeq=${afterSeq}&limit=100`);
      if (!res.ok) return;
      const data = await res.json() as { events: Array<{ seq: number; type: string; agentId?: string; payload: any; createdAt: string }>; lastSeq: number; channelId: string };
      const events = data.events || [];
      if (events.length === 0) return;
      let runsFinished = 0;
      let runsFailed = 0;
      let newMessages = 0;
      const msgsToAdd: Message[] = [];
      for (const ev of events) {
        if (typeof ev.seq === 'number') persistSeq(channelId, ev.seq);
        const type = ev.type;
        const payload = ev.payload;
        if (type === 'run.status_changed') {
          const st = payload?.status;
          if (st === 'completed') runsFinished++;
          else if (st === 'failed') runsFailed++;
        }
        if (type === 'message:new' && payload) {
          const p = payload as any;
          if (!p.isInternalMonologue) {
            newMessages++;
            try {
              const mapped = mapBackendMessage({
                ...p,
                timestamp: p.timestamp || ev.createdAt || new Date().toISOString(),
              });
              msgsToAdd.push(mapped);
            } catch {}
          }
        }
      }
      if (msgsToAdd.length > 0) {
        set((state: any) => {
          const existingIds = new Set(state.messages.map((m: Message) => m.id));
          const fresh = msgsToAdd.filter(m => !existingIds.has(m.id));
          if (fresh.length === 0) return state;
          let updated = [...state.messages, ...fresh];
          updated = capMessagesMirror(updated);
          writeMessagesMirror(updated);
          return { messages: updated };
        });
      }
      if (runsFinished > 0 || runsFailed > 0 || newMessages > 0) {
        const parts: string[] = [];
        if (runsFinished > 0) parts.push(`${runsFinished} run${runsFinished === 1 ? '' : 's'} finished`);
        if (runsFailed > 0) parts.push(`${runsFailed} failed`);
        if (newMessages > 0 && runsFinished === 0 && runsFailed === 0) parts.push(`${newMessages} new message${newMessages === 1 ? '' : 's'}`);
        else if (newMessages > 0) parts.push(`${newMessages} new message${newMessages === 1 ? '' : 's'}`);
        const digest = `While you were away: ${parts.join(', ')}`;
        set({ reconnectDigest: { message: digest, visible: true } } as any);
        setTimeout(() => {
          const cur = (get() as any).reconnectDigest;
          if (cur && cur.message === digest) set({ reconnectDigest: null } as any);
        }, 9000);
      }
    } catch {}
  }

  socket.on('connect', async () => {
    const activeCh = get().activeChannelId;
    if (!activeCh) {
      wasDisconnected = false;
      return;
    }
    if (wasDisconnected) {
      const afterSeq = seqCursors[activeCh] ?? 0;
      await fetchGapAndDigest(activeCh, afterSeq);
      emitChannelJoinDebounced(activeCh);
      wasDisconnected = false;
    } else {
      emitChannelJoinDebounced(activeCh);
      wasDisconnected = false;
    }
  });

  socket.on('disconnect', () => {
    wasDisconnected = true;
    // Offline banner (auto-clears on reconnect)
    set({ reconnectDigest: { message: 'Offline — reconnecting…', visible: true } } as any);
  });
  socket.on('connect_error' as any, () => {
    set({ reconnectDigest: { message: 'Connection error — retrying…', visible: true } } as any);
  });
  // HMR cleanup: avoid duplicate listeners on hot reload (store recreated)
  if (typeof import.meta !== 'undefined' && (import.meta as any).hot) {
    (import.meta as any).hot.dispose(() => {
      try { socket.off('connect'); socket.off('disconnect'); socket.off('message:new'); socket.off('message:stream'); socket.off('tool:start'); socket.off('tool:complete'); socket.off('agent:status'); socket.off('agent:thinking'); } catch {}
    });
  }

  // Establish socket connection event registers for real-time live synchronization
  // Per-agent monologue buffer to prevent race conditions when multiple agents respond simultaneously
  const pendingMonologueBuffers: Record<string, string> = {};

  // Keep track of streaming tool parser state per agent
  interface StreamParserState {
    thoughtsBuffer: string;     // Accumulated thought reasoning buffer
    contentBuffer: string;      // Accumulated user-facing content buffer
    inToolCall: boolean;        // Are we currently inside a <call_tool ...>...</call_tool> block?
    toolName: string;           // Extracted tool name
    toolInputBuffer: string;    // Captured content inside <call_tool>...</call_tool>
  }
  const streamParsers: Record<string, StreamParserState> = {};
  const lastTurnFinishedAt: Record<string, number> = {};
  const activeToolMessageIds: Record<string, string> = {};

  // Streaming coalescer: batch message:stream chunks to ≤32ms cadence to avoid 50Hz set() storms
  const pendingStreamMeta: Record<string, { channelId: string }> = {};
  const dirtyStreamAgents = new Set<string>();
  let streamCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let streamRaf: number | null = null;
  function flushStreamCoalesced() {
    streamCoalesceTimer = null;
    streamRaf = null;
    if (dirtyStreamAgents.size === 0) return;
    const activeCh = get().activeChannelId;
    const agentsToFlush = Array.from(dirtyStreamAgents);
    dirtyStreamAgents.clear();
    set((state: any) => {
      let updated = [...state.messages];
      let didChange = false;
      for (const agentId of agentsToFlush) {
        const p = streamParsers[agentId];
        const meta = pendingStreamMeta[agentId];
        if (!p || !meta) continue;
        if (meta.channelId !== activeCh) continue;
        const cleanThoughts = stripToolCalls(p.thoughtsBuffer || '');
        const cleanContent = stripToolCalls(p.contentBuffer || '');
        const existingIdx = updated.findIndex((m: Message) => m.id === `stream-${agentId}`);
        if (existingIdx !== -1) {
          if (updated[existingIdx].content !== cleanContent || (updated[existingIdx].metadata as any)?.monologue !== cleanThoughts) {
            updated[existingIdx] = {
              ...updated[existingIdx],
              content: cleanContent,
              metadata: cleanThoughts ? { ...updated[existingIdx].metadata, monologue: cleanThoughts } : updated[existingIdx].metadata,
            };
            didChange = true;
          }
        } else {
          const streamMsg: Message = {
            id: `stream-${agentId}`,
            type: 'agent',
            content: cleanContent,
            authorId: agentId,
            authorName: state.agents.find((a: Agent) => a.id === agentId)?.name || 'Agent Swarm',
            authorAvatar: '🤖',
            channelId: meta.channelId,
            timestamp: new Date().toISOString(),
            metadata: cleanThoughts ? { monologue: cleanThoughts } : undefined,
          };
          updated.push(streamMsg);
          didChange = true;
        }
        // Handle streaming tool preview coalesced as well
        if (p.toolName) {
          const toolMsgId = `stream-tool-${agentId}`;
          const existingToolIdx = updated.findIndex((m: Message) => m.id === toolMsgId);
          let cleanInput = p.toolInputBuffer.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
          const toolMsg: Message = {
            id: toolMsgId,
            type: 'tool_execution',
            content: '',
            authorId: agentId,
            authorName: state.agents.find((a: Agent) => a.id === agentId)?.name || 'Agent Swarm',
            authorAvatar: '🤖',
            channelId: meta.channelId,
            timestamp: new Date().toISOString(),
            toolExecution: { name: p.toolName, input: cleanInput, status: 'working', durationMs: 0 },
          };
          if (existingToolIdx !== -1) {
            updated[existingToolIdx] = toolMsg;
          } else {
            updated.push(toolMsg);
          }
          didChange = true;
        }
      }
      if (!didChange) return state;
      return { messages: updated };
    });
  }
  function scheduleStreamFlush(agentId: string, channelId: string) {
    pendingStreamMeta[agentId] = { channelId };
    dirtyStreamAgents.add(agentId);
    if (streamCoalesceTimer) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      streamCoalesceTimer = setTimeout(() => {
        streamRaf = window.requestAnimationFrame(() => flushStreamCoalesced());
      }, 32) as unknown as ReturnType<typeof setTimeout>;
    } else {
      streamCoalesceTimer = setTimeout(() => flushStreamCoalesced(), 32);
    }
  }
  // Prune stale streamParsers/lastTurnFinishedAt to avoid leak (TTL 15s)
  setInterval(() => {
    const now = Date.now();
    for (const [aid, ts] of Object.entries(lastTurnFinishedAt)) {
      if (now - ts > 15000) delete lastTurnFinishedAt[aid];
    }
  }, 30000).unref?.();

  socket.on('message:new', (raw: any) => {
    const { payload: msg, seq } = unwrapEnvelope(raw);
    if (!msg || isForeignWorkspacePayload(msg)) return;
    if (typeof seq === 'number' && msg.channelId) persistSeq(msg.channelId, seq);
    if (msg.isInternalMonologue) {
      pendingMonologueBuffers[msg.authorId] = msg.content;
      return;
    }
    if (msg.authorType === 'agent') {
      if (streamParsers[msg.authorId]) {
        delete streamParsers[msg.authorId];
      }
      // cancel coalesced flush for this agent (final message wins)
      dirtyStreamAgents.delete(msg.authorId);
      delete pendingStreamMeta[msg.authorId];
      lastTurnFinishedAt[msg.authorId] = Date.now();
    }
    const activeCh = get().activeChannelId;
    const monologue = msg.authorType === 'agent' && pendingMonologueBuffers[msg.authorId]
      ? stripToolCalls(pendingMonologueBuffers[msg.authorId])
      : undefined;
    const mapped: Message = {
      id: msg.id,
      type: msg.authorType === 'user' ? 'human' : 'agent',
      content: stripToolCalls(msg.content),
      authorId: msg.authorId,
      authorName: msg.authorName,
      authorAvatar: msg.authorType === 'user' ? undefined : '🤖',
      channelId: msg.channelId,
      timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
      mentions: msg.mentions?.map((m: any) => m.targetName) || [],
      metadata: monologue
        ? { monologue }
        : (msg.metadata
            ? { ...msg.metadata, monologue: msg.metadata.monologue ? stripToolCalls(msg.metadata.monologue) : undefined }
            : undefined),
      turnStatus: (msg as any).turnStatus || (msg as any).metadata?.turnStatus || undefined
    };

    // Reset per-agent buffer after consumption
    if (msg.authorType === 'agent') {
      delete pendingMonologueBuffers[msg.authorId];
    }

    set(state => {
      // Check if message already exists
      if (state.messages.some(m => m.id === mapped.id)) {
        return state;
      }
      const updatedMessages = state.messages
        .filter(m => m.id !== `stream-${mapped.authorId}` && m.id !== `stream-tool-${mapped.authorId}`)
        .concat(mapped);
      writeMessagesMirror(updatedMessages);

      // Also trigger notification increment if not active channel
      let updatedWorkspaces = state.workspaces;
      if (mapped.channelId !== activeCh) {
        updatedWorkspaces = state.workspaces.map(ws => ({
          ...ws,
          categories: ws.categories.map(cat => ({
            ...cat,
            channels: cat.channels.map(ch => {
              if (ch.id === mapped.channelId) {
                return {
                  ...ch,
                  unreadCount: ch.unreadCount + 1,
                  hasMention: ch.hasMention || mapped.mentions?.some(m => m.toLowerCase().includes('operator') || m.toLowerCase().includes('user')) || false
                };
              }
              return ch;
            })
          }))
        }));
      }

      return {
        messages: updatedMessages,
        workspaces: updatedWorkspaces
      };
    });
  });

  socket.on('message:stream', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload || isForeignWorkspacePayload(payload)) return;
    if (typeof seq === 'number' && payload.channelId) persistSeq(payload.channelId, seq);
    const activeCh = get().activeChannelId;
    if (payload.channelId !== activeCh) return;

    const agentId = payload.agentId;

    // Guard: ignore stream chunks that arrive after the final message has already
    // replaced the stream virtual message (trailing/late chunks from a completed turn).
    if (!streamParsers[agentId] && lastTurnFinishedAt[agentId] && (Date.now() - lastTurnFinishedAt[agentId] < 2000)) {
      return;
    }

    if (!streamParsers[agentId]) {
      delete lastTurnFinishedAt[agentId];
      streamParsers[agentId] = {
        thoughtsBuffer: '',
        contentBuffer: '',
        inToolCall: false,
        toolName: '',
        toolInputBuffer: ''
      };
    }

    const p = streamParsers[agentId];
    if (payload.isThoughts) {
      p.thoughtsBuffer = (p.thoughtsBuffer || '') + payload.chunk;
    } else {
      p.contentBuffer = (p.contentBuffer || '') + payload.chunk;
    }

    // Parse tool calls across both thoughts and content buffers (buffer update sync, DOM flush coalesced)
    const combinedBuffer = (p.thoughtsBuffer || '') + '\n' + (p.contentBuffer || '');
    const openTagIdx = combinedBuffer.indexOf('<call_tool');
    if (openTagIdx !== -1) {
      const closeTagIdx = combinedBuffer.indexOf('>', openTagIdx);
      if (closeTagIdx !== -1) {
        const tagText = combinedBuffer.substring(openTagIdx, closeTagIdx + 1);
        const nameMatch = tagText.match(/name=["']([^"']+)["']/);
        if (nameMatch) {
          p.toolName = nameMatch[1];
        }

        const closingTagIdx = combinedBuffer.indexOf('</call_tool>', closeTagIdx);
        if (closingTagIdx !== -1) {
          p.toolInputBuffer = combinedBuffer.substring(closeTagIdx + 1, closingTagIdx);
          p.inToolCall = false;
        } else {
          p.toolInputBuffer = combinedBuffer.substring(closeTagIdx + 1);
          p.inToolCall = true;
        }
      } else {
        p.inToolCall = false;
      }
    } else {
      p.inToolCall = false;
    }

    scheduleStreamFlush(agentId, payload.channelId);
  });

  socket.on('tool:start', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload) return;
    if (typeof seq === 'number' && payload.channelId) persistSeq(payload.channelId, seq);
    const activeCh = get().activeChannelId;
    if (payload.channelId !== activeCh) return;
 
    set(state => {
      // Remove the temporary stream-tool message if it exists
      let updated = state.messages.filter(m => m.id !== `stream-tool-${payload.agentId}`);
 
      const trackingKey = payload.callId || `${payload.agentId}-${payload.toolName}`;
      const toolMsgId = payload.callId ? `tool-${payload.callId}` : `tool-${payload.agentId}-${payload.toolName}-${Date.now()}`;
      activeToolMessageIds[trackingKey] = toolMsgId;
 
      let cleanInput = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input, null, 2);
 
      const toolMsg: Message = {
        id: toolMsgId,
        type: 'tool_execution',
        content: '',
        authorId: payload.agentId,
        authorName: state.agents.find(a => a.id === payload.agentId)?.name || 'Agent Swarm',
        authorAvatar: '🤖',
        channelId: payload.channelId,
        timestamp: new Date().toISOString(),
        toolExecution: {
          name: payload.toolName,
          input: cleanInput,
          status: 'working',
          durationMs: 0
        }
      };
 
      updated.push(toolMsg);
      return { messages: updated };
    });
  });
 
  socket.on('tool:complete', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload) return;
    if (typeof seq === 'number' && payload.channelId) persistSeq(payload.channelId, seq);
    const activeCh = get().activeChannelId;
    if (payload.channelId !== activeCh) return;
 
    set(state => {
      const trackingKey = payload.callId || `${payload.agentId}-${payload.toolName}`;
      const toolMsgId = activeToolMessageIds[trackingKey];
      if (!toolMsgId) return state;
 
      const updated = state.messages.map(msg => {
        if (msg.id === toolMsgId) {
          let cleanOutput = '';
          if (payload.output) {
            cleanOutput = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output, null, 2);
          } else if (payload.error) {
            cleanOutput = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error, null, 2);
          }
 
          return {
            ...msg,
            toolExecution: {
              ...msg.toolExecution!,
              output: cleanOutput,
              status: (payload.success ? 'success' : 'error') as 'success' | 'error',
              durationMs: payload.durationMs || 0
            }
          };
        }
        return msg;
      });
 
      delete activeToolMessageIds[trackingKey];
      return { messages: updated };
    });
  });

  socket.on('agent:status', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload || isForeignWorkspacePayload(payload)) return;
    if (typeof seq === 'number' && payload.channelId) persistSeq(payload.channelId, seq);
    else if (typeof seq === 'number' && (payload as any).channelId == null) {
      const ch = get().activeChannelId;
      if (ch) persistSeq(ch, seq);
    }
    set(state => ({
      agents: state.agents.map(ag => {
        if (ag.id === payload.agentId || ag.name.toLowerCase() === payload.agentId.toLowerCase()) {
          return {
            ...ag,
            status: payload.status as AgentStatus,
            lastActive: new Date().toISOString()
          };
        }
        return ag;
      })
    }));
  });

  socket.on('agent:thinking', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload || isForeignWorkspacePayload(payload)) return;
    if (typeof seq === 'number' && payload.channelId) persistSeq(payload.channelId, seq);
    if (payload.agentId) {
      delete lastTurnFinishedAt[payload.agentId];
      if (!streamParsers[payload.agentId]) {
        streamParsers[payload.agentId] = {
          thoughtsBuffer: '',
          contentBuffer: '',
          inToolCall: false,
          toolName: '',
          toolInputBuffer: ''
        };
      }
    }
    set(state => ({
      agents: state.agents.map(ag => {
        if (ag.id === payload.agentId || ag.name.toLowerCase() === payload.agentId.toLowerCase()) {
          return {
            ...ag,
            status: 'thinking',
            lastActive: new Date().toISOString()
          };
        }
        return ag;
      })
    }));
  });

  socket.on('workspace:sync', (raw: any) => {
    const { seq } = unwrapEnvelope(raw);
    if (typeof seq === 'number') {
      const ch = get().activeChannelId;
      if (ch) persistSeq(ch, seq);
    }
    get().fetchWorkspaces();
  });

  socket.on('budget:exceeded', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (typeof seq === 'number' && payload?.channelId) persistSeq(payload.channelId, seq);
    console.warn('[Socket] Swarm safety budget exceeded!', payload ?? raw);
    get().fetchBudget();
  });

  socket.on('budget:warning', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (typeof seq === 'number' && payload?.channelId) persistSeq(payload.channelId, seq);
    console.warn('[Socket] Swarm safety budget warning!', payload ?? raw);
    get().fetchBudget();
  });

  // agent:spawned / agent:despawned handlers were removed with the L3 spawn
  // manager (cleanup commit 1c8274e): nothing emits these events, swarm v1
  // delegates to existing agents instead of spawning new ones.

  // UX-6: delegation tree/timeline from SW-2 events — typed via shared contracts
  socket.on('delegation:start' as any, (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload) return;
    const channelId = (payload as any).channelId || get().activeChannelId;
    if (typeof seq === 'number' && channelId) persistSeq(channelId, seq);
    if (!channelId) return;
    const msg: Message = {
      id: `delegation-${(payload as any).childRunId || Date.now()}`,
      type: 'delegation',
      content: '',
      authorId: (payload as any).parentRunId || 'system',
      authorName: 'Delegation',
      channelId,
      timestamp: new Date().toISOString(),
      delegationInfo: {
        id: (payload as any).childRunId || `del-${Date.now()}`,
        fromAgentId: (payload as any).parentRunId || 'parent',
        fromAgentName: 'Parent',
        toAgentId: (payload as any).childRunId || 'child',
        toAgentName: (payload as any).taskId ? `Task ${ (payload as any).taskId}` : 'Child',
        task: (payload as any).taskId ? `Delegating task ${(payload as any).taskId} (depth ${(payload as any).depth ?? '?'})` : `Delegation depth ${(payload as any).depth ?? '?'}`,
        status: 'executing',
        tokens: 0,
        cost: 0
      }
    };
    set(state => {
      const updated = [...state.messages, msg];
      writeMessagesMirror(capMessagesMirror(updated));
      return { messages: updated };
    });
  });

  socket.on('delegation:completed' as any, (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload) return;
    const channelId = (payload as any).channelId || get().activeChannelId;
    if (typeof seq === 'number' && channelId) persistSeq(channelId, seq);
    const childRunId = (payload as any).childRunId;
    if (!childRunId) return;
    set(state => {
      let found = false;
      const updated = state.messages.map(m => {
        if (m.delegationInfo && m.delegationInfo.id === childRunId) {
          found = true;
          return {
            ...m,
            delegationInfo: {
              ...m.delegationInfo,
              status: 'completed' as const,
              task: (payload as any).summary ? `${m.delegationInfo.task} — ${(payload as any).summary.slice(0,120)}` : m.delegationInfo.task
            },
            content: (payload as any).summary || m.content
          };
        }
        return m;
      });
      if (!found && channelId) {
        const msg: Message = {
          id: `delegation-${childRunId}`,
          type: 'delegation',
          content: (payload as any).summary || '',
          authorId: (payload as any).parentRunId || 'system',
          authorName: 'Delegation',
          channelId,
          timestamp: new Date().toISOString(),
          delegationInfo: {
            id: childRunId,
            fromAgentId: (payload as any).parentRunId || 'parent',
            fromAgentName: 'Parent',
            toAgentId: childRunId,
            toAgentName: 'Child',
            task: (payload as any).summary ? (payload as any).summary.slice(0,200) : 'Delegation completed',
            status: 'completed',
            tokens: 0,
            cost: 0
          }
        };
        const withNew = [...updated, msg];
        writeMessagesMirror(capMessagesMirror(withNew));
        return { messages: withNew };
      }
      writeMessagesMirror(capMessagesMirror(updated));
      return { messages: updated };
    });
  });

  socket.on('agent:paused', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload) return;
    if (typeof seq === 'number' && payload.channelId) persistSeq(payload.channelId, seq);
    set(state => ({
      agents: state.agents.map(ag => ag.id === payload.agentId ? { ...ag, status: 'paused', lastActive: new Date().toISOString() } : ag)
    }));
  });

  socket.on('agent:resumed', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload) return;
    if (typeof seq === 'number' && payload.channelId) persistSeq(payload.channelId, seq);
    set(state => ({
      agents: state.agents.map(ag => ag.id === payload.agentId ? { ...ag, status: 'idle', lastActive: new Date().toISOString() } : ag)
    }));
  });

  socket.on('runtime:snapshot', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    const snap = payload ?? raw;
    if (typeof seq === 'number') {
      const ch = get().activeChannelId;
      if (ch) persistSeq(ch, seq);
    }
    // Debug-level: this fires every ~15s per connection and flooded the
    // console with object dumps (QA audit 2026-09-23). Keep it available
    // under verbose filtering only.
    console.debug('[Socket] Authoritative runtime snapshot received:', snap);
    // ponytail: the roster is owned by the tenant REST fetch — a snapshot
    // built from another database must never clobber it (untagged snapshots
    // are global broadcasts; apply their agents only on a workspaceId match).
    // Overrides keep flowing (no other source yet); full per-workspace room
    // namespacing is the follow-up that will tag these snapshots properly.
    const snapWorkspaceId = (snap as any)?.workspaceId;
    const rosterInScope =
      typeof snapWorkspaceId === 'string' &&
      snapWorkspaceId.length > 0 &&
      snapWorkspaceId === get().activeWorkspaceId;
    set(state => {
      const mappedOverrides: RuntimeOverride[] = (snap.overrides || []).map((ov: any) => ({
        id: ov.id,
        agentId: ov.agentId,
        type: ov.type as any,
        patch: ov.patch || {},
        reason: ov.reason || '',
        active: ov.active ?? true,
        createdAt: ov.createdAt || new Date().toISOString()
      }));

      if (!rosterInScope) {
        return { runtimeOverrides: mappedOverrides };
      }

      const mappedAgents: Agent[] = (snap.agents || []).map((ag: any) => ({
        id: ag.id,
        name: ag.name,
        species: ag.species || 'AI Assistant',
        level: ag.authorityLevel as AgentLevel,
        status: ag.status || 'idle',
        avatar: ag.avatar || '🤖',
        instructionModuleId: ag.instructionModuleId,
        modelModuleId: ag.modelModuleId,
        toolkitModuleId: ag.toolkitModuleId,
        description: ag.title || ag.description || '',
        isOmniscient: ag.isOmniscient || false,
        createdAt: ag.createdAt || new Date().toISOString(),
        lastActive: ag.updatedAt || new Date().toISOString()
      }));

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_agents', JSON.stringify(mappedAgents));
      }

      return {
        agents: mappedAgents,
        runtimeOverrides: mappedOverrides
      };
    });
  });

  socket.on('escalation:created', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    const data = payload ?? raw;
    if (typeof seq === 'number' && data.channelId) persistSeq(data.channelId, seq);
    console.warn('[Socket] Swarm escalation received:', data);
    const activeCh = get().activeChannelId;
    if (!activeCh) return;

    const escMsg: Message = {
      id: `esc-${Date.now()}-${Math.random()}`,
      type: 'governance',
      content: `⚠️ [Escalation: ${data.type}] Agent @${data.agentId} triggered: ${data.message}`,
      authorId: 'system',
      authorName: 'Governance Escalator',
      authorAvatar: '⚖️',
      channelId: activeCh,
      timestamp: data.timestamp || new Date().toISOString(),
      metadata: data.details || {}
    };

    set(state => {
      const updated = [...state.messages, escMsg];
      writeMessagesMirror(updated);
      return { messages: updated };
    });
  });

  socket.on('strike:initiated', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    const data = payload ?? raw;
    if (typeof seq === 'number' && data.channelId) persistSeq(data.channelId, seq);
    console.warn('[Socket] Strike initiated received:', data);
    const activeCh = get().activeChannelId;
    if (!activeCh) return;

    const strikeMsg: Message = {
      id: `strike-${Date.now()}-${Math.random()}`,
      type: 'governance',
      content: data.reason,
      authorId: 'system',
      authorName: 'Safety Arbiter',
      authorAvatar: '⚖️',
      channelId: activeCh,
      timestamp: data.timestamp || new Date().toISOString(),
      metadata: {
        subtype: 'strike',
        agentId: data.agentId,
        strikeCount: data.strikeCount,
        maxStrikes: data.maxStrikes || 3
      }
    };

    set(state => {
      const updated = [...state.messages, strikeMsg];
      return { messages: updated };
    });
  });

  socket.on('sandbox:updated', (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    const data = payload ?? raw;
    if (typeof seq === 'number' && data.workspaceId) {
      const ch = get().activeChannelId;
      if (ch) persistSeq(ch, seq);
    }
    console.log('[Socket] Sandbox updated event:', data);
    get().incrementFilesystemRevision();
  });

  function handleApprovalRequested(raw: any) {
    const { payload, seq } = unwrapEnvelope(raw);
    const data = payload ?? raw;
    if (typeof seq === 'number' && data.channelId) persistSeq(data.channelId, seq);
    const approvalId = data.approvalId || data.id;
    const runId = data.runId;
    const tool = data.tool || data.toolName || 'unknown';
    if (!approvalId || !runId) return;
    const channelId = (data.channelId as string) || get().activeChannelId;
    const req: ApprovalRequest = {
      id: approvalId,
      runId,
      tool,
      argsPreview: (data.argsPreview as Record<string, unknown> | null) ?? null,
      riskClass: (data.riskClass as string) || 'general',
      status: 'pending',
      channelId: channelId || null,
      scope: (data.scope as string | null) ?? null,
      expiresAt: (data.expiresAt as string | null) ?? null,
      requestedBy: (data.requestedBy as string | null) ?? null,
    };
    set((state: any) => {
      if (state.approvalRequests.some((r: ApprovalRequest) => r.id === req.id)) return state;
      return { approvalRequests: [...state.approvalRequests, req] };
    });
  }

  function handleApprovalDecided(raw: any) {
    const { payload, seq } = unwrapEnvelope(raw);
    const data = payload ?? raw;
    if (typeof seq === 'number' && data.channelId) persistSeq(data.channelId, seq);
    const approvalId = data.approvalId || data.id;
    const decision = (data.decision as string) || 'approved';
    if (!approvalId) return;
    set((state: any) => ({
      approvalRequests: state.approvalRequests.map((r: ApprovalRequest) =>
        r.id === approvalId ? { ...r, status: decision as ApprovalRequest['status'] } : r
      ),
    }));
  }

  function handleArtifactCreated(raw: any) {
    const { payload, seq } = unwrapEnvelope(raw);
    const data = payload ?? raw;
    if (typeof seq === 'number' && (data.channelId as string)) persistSeq(data.channelId as string, seq);
    const runId = (data.runId as string) || (data.artifact as any)?.runId;
    if (runId) {
      void get().fetchArtifacts(runId);
    }
  }

  socket.on('approval.requested' as any, handleApprovalRequested);
  socket.on('approval.decided' as any, handleApprovalDecided);
  socket.on('artifact.created' as any, handleArtifactCreated);
  socket.on('diff.created' as any, handleArtifactCreated);
  socket.on('artifact.updated' as any, handleArtifactCreated);

  socket.on('run.status_changed' as any, (raw: any) => {
    const { payload, seq } = unwrapEnvelope(raw);
    if (!payload) return;
    const channelId = payload.channelId as string | undefined;
    const agentId = payload.agentId as string | undefined;
    const status = (payload.status ?? payload.to) as string | undefined;
    if (typeof seq === 'number' && channelId) persistSeq(channelId, seq);
    if (!channelId || !status) return;
    const st = String(status).toLowerCase();
    if (st === 'cancelled') {
      if (agentId) {
        if (streamParsers[agentId]) delete streamParsers[agentId];
        lastTurnFinishedAt[agentId] = Date.now();
      }
      set((state: any) => {
        const nextCancelling = { ...state.cancellingByAgent };
        if (agentId) delete nextCancelling[`${channelId}:${agentId}`];
        delete nextCancelling[`${channelId}:*`];
        let updated = [...state.messages] as Message[];
        let bufferedContent = '';
        let bufferedMonologue: string | undefined;
        const streamIdx = agentId ? updated.findIndex(m => m.id === `stream-${agentId}` && m.channelId === channelId) : -1;
        if (streamIdx !== -1) {
          bufferedContent = updated[streamIdx].content || '';
          bufferedMonologue = (updated[streamIdx].metadata as any)?.monologue;
        }
        updated = updated.filter(m => {
          if (m.channelId !== channelId) return true;
          if (agentId && (m.id === `stream-${agentId}` || m.id === `stream-tool-${agentId}`)) return false;
          if (!agentId && (m.id.startsWith('stream-') || m.id.startsWith('stream-tool-'))) return false;
          return true;
        });
        const targetAgentId = agentId || 'system';
        const agentName = state.agents.find((a: Agent) => a.id === targetAgentId)?.name || (agentId ? 'Agent' : 'Run');
        const cancelledMsg: Message = {
          id: `cancelled-${targetAgentId}-${Date.now()}`,
          type: 'agent',
          content: bufferedContent || 'Run cancelled by user.',
          authorId: targetAgentId,
          authorName: agentName,
          authorAvatar: '🤖',
          channelId,
          timestamp: new Date().toISOString(),
          turnStatus: 'cancelled' as any,
          metadata: bufferedMonologue ? { monologue: bufferedMonologue, cancelled: true } : { cancelled: true }
        } as Message;
        updated.push(cancelledMsg);
        writeMessagesMirror(updated);
        return { messages: updated, cancellingByAgent: nextCancelling, agents: state.agents.map((ag: Agent) => ag.id === agentId ? { ...ag, status: 'idle' as any, lastActive: new Date().toISOString() } : ag) };
      });
    } else if (st === 'completed' || st === 'failed') {
      set((state: any) => {
        const next = { ...state.cancellingByAgent };
        if (agentId) delete next[`${channelId}:${agentId}`];
        return { cancellingByAgent: next };
      });
      if (agentId && streamParsers[agentId]) delete streamParsers[agentId];
      if (agentId) lastTurnFinishedAt[agentId] = Date.now();
      // UX-3: fetch diff artifacts on completion
      if (st === 'completed' && (payload as any).runId) {
        void get().fetchArtifacts((payload as any).runId);
      }
      if (typeof document !== 'undefined' && typeof Notification !== 'undefined') {
        try {
          if (!isChannelMutedLS(channelId) && (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus()))) {
            if (Notification.permission === 'default') {
              Notification.requestPermission().catch(() => {});
            }
            if (Notification.permission === 'granted') {
              const agentName = get().agents.find((a: Agent) => a.id === agentId)?.name || 'Agent';
              const title = st === 'completed' ? `Run completed — ${agentName}` : `Run failed — ${agentName}`;
              const body = `Channel #${channelId} • ${st}`;
              try { new Notification(title, { body }); } catch {}
            }
          }
        } catch {}
      }
    } else {
      if (st === 'running' || st === 'starting' || st === 'queued') {
        const cur = get().activeChannelId;
        if (cur === channelId && agentId) {
          set((state: any) => ({
            agents: state.agents.map((ag: Agent) => ag.id === agentId ? { ...ag, status: 'executing' as any, lastActive: new Date().toISOString() } : ag)
          }));
        }
      }
    }
  });

  return {
    // Shared Data Slices
    workspaces: parsedWorkspaces,
    agents: parsedAgents,
    messages: parsedMessages,
    modelProfiles: parsedProfiles,
    instructionModules: parsedInstructionModules,
    modelModules: parsedModelModules,
    toolkitModules: parsedToolkitModules,
    constraintsModules: [],
    capabilitiesModules: [],
    runtimeOverrides: [],
    tools: initialTools,
    roles: initialRoles,
    archivedChannels: [],

    // Budget Telemetry initial state
    globalSoftCap: 1000000,
    perProviderBudget: {},
    totalTokensConsumed: 0,

    // Layout configuration
    activeWorkspaceId: parsedActiveId,
    activeChannelId: initialChannelId,
    selectedAgentId: null,
    selectedSandboxFile: null,
    filesystemRevision: 0,
    rightSidebarOpen: true,
    leftSidebarCollapsed: false,
    settingsModalOpen: false,
    agentProfileModalOpen: false,
    workspaceSettingsTab: 'overview',

    // Mobile Navigation state
    activeMobileTab: 'chat',
    mobileDrawerLeft: false,
    mobileDrawerRight: false,

    // Search query
    chatSearchQuery: '',
    selectedMode: initialSelectedMode,
    // Derived from the ACTIVE channel's pin, not a browser-global flag (§6).
    isPinned: initialSelectedMode !== 'auto',
    pinnedModeByChannel: storedPinnedModes,

    // PERF-5 pagination
    channelCursors: {},
    isLoadingOlder: false,

    // UX-5 + UX-1
    channelSeq: seqCursors,
    reconnectDigest: null,
    cancellingByAgent: {},

    // UX-2 Approval cards + UX-3 Diff review
    approvalRequests: [] as ApprovalRequest[],
    artifactsByRun: {} as Record<string, ArtifactRow[]>,

    cancelRun: (channelId: string, agentId?: string) => {
      const targetChannel = channelId || get().activeChannelId;
      if (!targetChannel) return;
      if (agentId) {
        set((s: any) => ({ cancellingByAgent: { ...s.cancellingByAgent, [`${targetChannel}:${agentId}`]: true } }));
      } else {
        const streamingAgents = new Set<string>();
        const msgs = get().messages;
        for (const m of msgs) {
          if (m.id.startsWith('stream-') && m.channelId === targetChannel) streamingAgents.add(m.authorId);
        }
        if (streamingAgents.size === 0) {
          for (const ag of get().agents) {
            if (ag.status === 'executing' || (ag.status as string) === 'thinking' || ag.status === 'working') streamingAgents.add(ag.id);
          }
        }
        const updates: Record<string, boolean> = {};
        if (streamingAgents.size > 0) {
          for (const aid of streamingAgents) updates[`${targetChannel}:${aid}`] = true;
        } else {
          updates[`${targetChannel}:*`] = true;
        }
        set((s: any) => ({ cancellingByAgent: { ...s.cancellingByAgent, ...updates } }));
      }
      try { socket.emit('user:cancel' as any, { channelId: targetChannel, agentId }); } catch {}
      setTimeout(() => {
        set((s: any) => {
          const next = { ...s.cancellingByAgent };
          if (agentId) delete next[`${targetChannel}:${agentId}`];
          else Object.keys(next).forEach(k => { if (k.startsWith(`${targetChannel}:`)) delete next[k]; });
          return { cancellingByAgent: next };
        });
      }, 5000);
    },

    clearReconnectDigest: () => set({ reconnectDigest: null } as any),

    emitChannelJoin: (channelId: string, workspaceId?: string | null) => {
      // Explicit workspace wins; otherwise the debounced helper uses the active one.
      if (workspaceId && workspaceId !== get().activeWorkspaceId) {
        try { emitChannelJoin(channelId, workspaceId); } catch {}
        return;
      }
      emitChannelJoinDebounced(channelId);
    },

    isChannelMuted: (channelId: string) => isChannelMutedLS(channelId),

    setMode: (mode, channelId) => {
      set(s => {
        // §6: changing the mode WHILE pinned re-pins the channel to the new mode.
        // The pin is per channel, so only the active channel's pin moves.
        const pinChannel = channelId || s.activeChannelId;
        const isPinnedHere = !!pinChannel && s.isPinned;
        if (isPinnedHere && pinChannel) {
          void apiClient
            .updateChannelSettings(pinChannel, { pinnedRuntime: composerModeToRuntime(mode) })
            .catch((err) => console.warn('[Pin] failed to persist channel runtime pin:', err));
        }
        const nextPinned = isPinnedHere && pinChannel
          ? { ...s.pinnedModeByChannel, [pinChannel]: mode }
          : s.pinnedModeByChannel;
        return {
          selectedMode: mode,
          pinnedModeByChannel: nextPinned,
          isPinned: isPinnedHere,
        };
      });
    },

    // §6: pinning writes to the SERVER (channel_settings.pinned_runtime) so the
    // pin survives a reload, follows the channel across devices, and is visible
    // to the Router. Previously the pin lived only in localStorage under a
    // single global key — so it was per-browser, not per-channel, and the
    // server never learned about it. localStorage remains a write-through cache
    // for instant UI feedback; the server is the source of truth.
    togglePin: () => {
      set(s => {
        const channelId = s.activeChannelId;
        if (!channelId) return {};
        const nextIsPinned = !s.isPinned;
        const nextPinnedModes = { ...s.pinnedModeByChannel };
        if (nextIsPinned) nextPinnedModes[channelId] = s.selectedMode;
        else delete nextPinnedModes[channelId];

        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem('crowdos_pinned_modes', JSON.stringify(nextPinnedModes));
          } catch {
            // Mirror only; the server row below is the source of truth.
          }
        }

        // Fire-and-forget: the local UI must not block on the round trip, and a
        // failed write degrades to the local mirror rather than trapping the
        // user. §22: the value sent is a RUNTIME name (chat → conversational),
        // never the composer mode, and `auto` clears the pin (null).
        void apiClient
          .updateChannelSettings(channelId, {
            pinnedRuntime: nextIsPinned ? composerModeToRuntime(s.selectedMode) : null,
          })
          .catch((err) => console.warn('[Pin] failed to persist channel runtime pin:', err));

        return { isPinned: nextIsPinned, pinnedModeByChannel: nextPinnedModes };
      });
    },

    // §6: the pin is per CHANNEL, so entering a channel must apply THAT
    // channel's pin. The local mirror gives instant feedback; the server row is
    // authoritative and is fetched to reconcile (another device may have
    // changed it). A failed read leaves the local mirror in place rather than
    // clearing a pin the user set.
    hydrateChannelPin: async (channelId) => {
      if (!channelId) return;
      try {
        const settings = await apiClient.getChannelSettings(channelId);
        const mode = runtimeToComposerMode(settings?.pinnedRuntime);
        set(s => {
          const nextPinnedModes = { ...s.pinnedModeByChannel };
          if (mode === 'auto') delete nextPinnedModes[channelId];
          else nextPinnedModes[channelId] = mode;
          if (typeof localStorage !== 'undefined') {
            try {
              localStorage.setItem('crowdos_pinned_modes', JSON.stringify(nextPinnedModes));
            } catch {}
          }
          const isActive = s.activeChannelId === channelId;
          if (!isActive) return { pinnedModeByChannel: nextPinnedModes };
          // The server row is authoritative for the ACTIVE channel, in both
          // directions: a pin it knows about is applied, and a pin it does NOT
          // have clears the composer back to Auto. Only applying the positive
          // case would leave a stale local mirror showing a mode the server had
          // already dropped — pinned-looking UI over an unpinned channel.
          return {
            pinnedModeByChannel: nextPinnedModes,
            isPinned: mode !== 'auto',
            selectedMode: mode,
          };
        });
      } catch (err) {
        console.warn('[Pin] failed to read channel runtime pin:', err);
      }
    },

    resetOnChannelChange: (channelId) => {
      set(s => {
        // §6, verbatim: "An unpinned runtime selection is temporary. When the
        // user switches away from the Channel, the Channel returns to Auto."
        //
        // So the arriving channel's OWN pin decides, and nothing else:
        //   pinned   → that channel's pinned mode
        //   unpinned → Auto
        //
        // A pin from another channel must never leak in (the global-flag
        // defect), and a TEMPORARY selection must not survive either — the old
        // `modeByChannel` lookup restored the stale temporary mode, which §6
        // explicitly says is discarded on leaving the channel.
        const pinnedMode = channelId ? s.pinnedModeByChannel[channelId] : undefined;
        if (pinnedMode) {
          return { selectedMode: pinnedMode, isPinned: true };
        }
        return { selectedMode: 'auto', isPinned: false };
      });
    },

    // Async state flags
    isFetchingWorkspaces: false,
    isCreatingWorkspace: false,
    isUpdatingWorkspace: false,
    isDatabaseOffline: false,
    databaseErrorMessage: null,
    workspaceError: null,
    dbSyncStatus: null,
    isSyncing: false,

    // Core actions
    fetchWorkspaces: async () => {
      const markName = 'crowdos:fetchWorkspaces';
      try { performance.mark(`${markName}:start`); } catch {}
      set({ isFetchingWorkspaces: true });
      try {
        // 1. Fetch live workspace roster from backend
        let rawWsList: any[] = [];
        try {
          rawWsList = await apiClient.getWorkspaces();
        } catch (wsErr: any) {
          if (isScreenlockError(wsErr?.message)) {
            useScreenLockStore.getState().lock();
            set({ isFetchingWorkspaces: false });
            return;
          }
          console.warn('Failed to load workspaces list:', wsErr);
        }

        if (Array.isArray(rawWsList)) {
          if (rawWsList.length === 0) {
            // Clean state — no workspaces exist in registry
            get().clearTenantSlices();
            set({
              workspaces: [],
              activeWorkspaceId: null,
              activeChannelId: null,
              isFetchingWorkspaces: false,
              workspaceError: null,
            });
            if (typeof localStorage !== 'undefined') {
              localStorage.removeItem('crowdos_workspaces');
              localStorage.removeItem('crowdos_active_workspace');
            }
            return;
          }

          const existingWsMap = new Map(get().workspaces.map(w => [w.id, w]));
          const mappedWs: Workspace[] = rawWsList.map((dto: any) => {
            const existing = existingWsMap.get(dto.id);
            return {
              id: dto.id,
              name: dto.name,
              icon: dto.icon || '💼',
              screenLockEnabled: !!dto.screenLockEnabled,
              dbUrl: dto.database?.configured ? `postgresql://***@${dto.database.host}/${dto.database.database}` : '',
              database: dto.database,
              storagePreference: dto.storagePreference === 'local' ? 'local' : 'default',
              dbSync: dto.dbSync ?? null,
              categories: existing?.categories || [],
              channels: existing?.channels || [],
              createdAt: dto.createdAt || new Date().toISOString(),
            };
          });

          const currentActive = get().activeWorkspaceId;
          const activeStillValid = currentActive && mappedWs.some(w => w.id === currentActive);
          if (!activeStillValid) {
            get().clearTenantSlices();
            set({
              workspaces: mappedWs,
              activeWorkspaceId: null,
              activeChannelId: null,
              isFetchingWorkspaces: false,
            });
            if (typeof localStorage !== 'undefined') {
              localStorage.removeItem('crowdos_active_workspace');
            }
            return;
          }

          set({ workspaces: mappedWs });
        }

        const targetWsId = get().activeWorkspaceId;
        if (!targetWsId) {
          set({ isFetchingWorkspaces: false });
          return;
        }

        const reqHeaders: Record<string, string> = { 'x-workspace-id': targetWsId };

        // Parallel fetch: 5 independent REST calls for active tenant.
        // ponytail: each bounded — one hung GET must never freeze the shell
        // on stale rows; a timeout lands in the catch below (cleared + error).
        const tenantSignal = AbortSignal.timeout(30_000);
        const [catRes, chanRes, agentRes, moduleRes, profRes] = await Promise.all([
          fetch(`${BACKEND_URL}/api/categories`, { headers: reqHeaders, signal: tenantSignal }),
          fetch(`${BACKEND_URL}/api/channels`, { headers: reqHeaders, signal: tenantSignal }),
          fetch(`${BACKEND_URL}/api/agents`, { headers: reqHeaders, signal: tenantSignal }),
          fetch(`${BACKEND_URL}/api/modules`, { headers: reqHeaders, signal: tenantSignal }),
          fetch(`${BACKEND_URL}/api/providers/generation`, { headers: reqHeaders, signal: tenantSignal }),
        ]);

        for (const res of [catRes, chanRes, agentRes, moduleRes, profRes]) {
          if (res && res.status === 401) {
            const body = await res.clone().json().catch(() => ({}));
            if (isScreenlockError(body?.message)) {
              useScreenLockStore.getState().lock();
              // ponytail: veil shows, but stale rows must not linger behind it.
              get().clearTenantSlices();
              set({ isFetchingWorkspaces: false });
              return;
            }
          }
          // ponytail: 503 = tenant DB down; degraded shell, not portal bounce.
          if (res && res.status === 503) {
            const body = await res.clone().json().catch(() => ({}));
            get().clearTenantSlices();
            set({
              isDatabaseOffline: true,
              databaseErrorMessage: body?.message || 'Database Offline: could not reach workspace database.',
              isFetchingWorkspaces: false,
            });
            return;
          }
        }
        set({ isDatabaseOffline: false, databaseErrorMessage: null });

        // ponytail: any failed REQUIRED tenant fetch clears slices — partial
        // fresh + partial stale is how foreign rows survive a refresh.
        // Dual-boot: module/profile catalogs are optional (local mode has no
        // catalog tier); only categories/channels/agents can fail the refresh.
        const requiredFailedRes = [catRes, chanRes, agentRes].find(r => !r || !r.ok);
        if (requiredFailedRes) {
          const detail = await requiredFailedRes.clone().json().catch(() => ({} as any));
          get().clearTenantSlices();
          set({
            isFetchingWorkspaces: false,
            workspaceError: (detail as any)?.message || `Failed to load workspace data (HTTP ${requiredFailedRes.status})`,
          });
          return;
        }

        let dbWorkspaces = get().workspaces;
        let dbArchivedChannels = get().archivedChannels;
        
        if (catRes.ok && chanRes.ok) {
          const dbCategories = await catRes.json();
          const dbChannels = await chanRes.json();
          const previousWorkspace = get().workspaces.find(ws => ws.id === get().activeWorkspaceId);
          const previousCollapseById = new Map(
            previousWorkspace?.categories.map(category => [category.id, category.collapsed]) || []
          );

          // Separate top-level channels (where categoryId is null)
          const topLevelChannels = (dbChannels || [])
            .filter((ch: any) => ch.categoryId === null && ch.type !== 'archived')
            .map((ch: any) => mapBackendChannel(ch, 'Default operational sector'));

          dbArchivedChannels = (dbChannels || [])
            .filter((ch: any) => ch.type === 'archived')
            .map((ch: any) => mapBackendChannel(ch, 'Archived operational sector'));

          dbWorkspaces = get().workspaces.map(ws => {
            if (ws.id === get().activeWorkspaceId) {
              return {
                ...ws,
                channels: topLevelChannels,
                categories: (dbCategories || []).map((c: any) => ({
                  id: c.id,
                  name: c.name,
                  collapsed: previousCollapseById.get(c.id) ?? false,
                  position: c.position,
                  channels: (c.channels || [])
                    .filter((ch: any) => ch.type !== 'archived')
                    .map((ch: any) => mapBackendChannel(ch, 'Operations sector'))
                }))
              };
            }
            return ws;
          });
        }

        // Agents (already fetched in parallel)
        let dbAgents = get().agents;
        if (agentRes.ok) {
          const backendAgents = await agentRes.json();
          dbAgents = (backendAgents || []).map((ag: any) => ({
            id: ag.id,
            name: ag.name,
            species: ag.species || 'AI Assistant',
            level: ag.authorityLevel,
            status: ag.status || 'idle',
            avatar: ag.avatar || '🤖',
            instructionModuleId: ag.instructionModuleId,
            modelModuleId: ag.modelModuleId,
            toolkitModuleId: ag.toolkitModuleId,
            description: ag.title || '',
            isOmniscient: ag.isOmniscient || false,
            createdAt: ag.createdAt,
            lastActive: ag.updatedAt
          }));
        }

        // Modules aggregated (already fetched). A failed catalog fetch degrades
        // to empty — never stale rows from another mode (dual-boot).
        let dbInstructions = get().instructionModules;
        let dbModels = get().modelModules;
        let dbToolkits = get().toolkitModules;
        let dbConstraints = get().constraintsModules;
        let dbCapabilities = get().capabilitiesModules;
        if (!moduleRes.ok) {
          dbInstructions = [];
          dbModels = [];
          dbToolkits = [];
          dbConstraints = [];
          dbCapabilities = [];
        }

        if (moduleRes.ok) {
          const mods = await moduleRes.json();
          dbInstructions = (mods.instructionModules || []).map((m: any) => ({
            id: m.id,
            name: m.label,
            systemPrompt: m.base?.join('\n') || '',
            rules: [],
            createdAt: m.createdAt
          }));
          dbModels = (mods.modelModules || []).map((m: any) => ({
            id: m.id,
            name: m.label,
            modelProfileId: m.modelName,
            provider: m.provider,
            apiKey: m.apiKey,
            baseUrl: m.endpointUrl,
            temperature: m.temperature,
            maxTokens: m.maxOutputTokens,
            topP: m.topP,
            maxRecentMessages: m.maxRecentMessages,
            enableCompression: m.enableCompression,
            compressionThreshold: m.compressionThreshold,
            createdAt: m.createdAt
          }));
          dbToolkits = (mods.toolkitModules || []).map((m: any) => ({
            id: m.id,
            name: m.label,
            enabledToolIds: m.tools || [],
            createdAt: m.createdAt
          }));
          dbConstraints = (mods.constraintsModules || []).map((m: any) => ({
            id: m.id,
            name: m.label,
            rules: m.rules || [],
            disallowedActions: m.disallowedActions || [],
            createdAt: m.createdAt
          }));
          dbCapabilities = (mods.capabilitiesModules || []).map((m: any) => ({
            id: m.id,
            name: m.label,
            skills: m.skills || [],
            functionSchemas: m.functionSchemas || [],
            createdAt: m.createdAt
          }));
        }

        // Generation profiles (already fetched). Failed fetch degrades to empty.
        let dbProfiles = get().modelProfiles;
        if (!profRes.ok) {
          dbProfiles = [];
        }
        if (profRes.ok) {
          const backendProfs = await profRes.json();
          dbProfiles = (backendProfs || []).map((p: any) => ({
            id: p.id,
            label: p.label,
            provider: p.provider,
            modelName: p.modelName,
            apiKeyConfigured: !!p.apiKey,
            createdAt: p.createdAt
          }));
        }

        // Budget Telemetry (parallel after core fetches to not block roster).
        // Budget endpoints are PG-only (local-mode guard answers 501); calling
        // them for a DB-less workspace spammed the console with guaranteed
        // "Failed to load resource" errors on every refresh (QA audit
        // 2026-09-23). Skip unless the active workspace has a database.
        const activeWsForBudget = get().workspaces.find(w => w.id === targetWsId);
        if (activeWsForBudget?.database?.configured) {
          await get().fetchBudget();
        }

        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('crowdos_workspaces', JSON.stringify(dbWorkspaces));
          localStorage.setItem('crowdos_agents', JSON.stringify(dbAgents));
          localStorage.setItem('crowdos_model_profiles', JSON.stringify(dbProfiles));
          localStorage.setItem('crowdos_constraints_modules', JSON.stringify(dbConstraints));
          localStorage.setItem('crowdos_capabilities_modules', JSON.stringify(dbCapabilities));
        }

        set({
          workspaces: dbWorkspaces,
          agents: dbAgents,
          instructionModules: dbInstructions,
          modelModules: dbModels,
          toolkitModules: dbToolkits,
          constraintsModules: dbConstraints,
          capabilitiesModules: dbCapabilities,
          modelProfiles: dbProfiles,
          archivedChannels: dbArchivedChannels,
          isFetchingWorkspaces: false
        });

        // Trigger active channel messages reload
        const activeWorkspace = get().workspaces.find(ws => ws.id === get().activeWorkspaceId);
        const visibleChannelIds = new Set([
          ...(activeWorkspace?.channels?.map(channel => channel.id) || []),
          ...(activeWorkspace?.categories.flatMap(category => category.channels.map(channel => channel.id)) || [])
        ]);
        const currentChannelId = get().activeChannelId;
        const nextChannelId = currentChannelId && visibleChannelIds.has(currentChannelId)
          ? currentChannelId
          : getFirstChannelId(activeWorkspace);

        if (nextChannelId) {
          await get().setActiveChannel(nextChannelId);
        } else if (currentChannelId) {
          set({ activeChannelId: null });
        }

      } catch (err) {
        console.error("Failed to connect to CrowdOS Live Backend.", err);
        if (!DEMO_FALLBACK) {
          // ponytail: never keep another workspace's rows on transport failure.
          get().clearTenantSlices();
          set({ isFetchingWorkspaces: false, workspaceError: err instanceof Error ? err.message : 'Backend unavailable — DEMO_FALLBACK is off' });
          // Honesty: do not keep showing seeded demo workspaces/agents when DEMO_FALLBACK is off
          // (outage shows error, not demo). Keep current state but surface error; empty fallback only if no localStorage.
        } else {
          console.warn("DEMO_FALLBACK=true — using seeded demo data as fallback (honest demo mode)");
          set({ isFetchingWorkspaces: false });
        }
      } finally {
        try {
          performance.mark(`${markName}:end`);
          performance.measure('fetchWorkspaces', `${markName}:start`, `${markName}:end`);
          const entries = performance.getEntriesByName('fetchWorkspaces');
          const last = entries[entries.length - 1] as PerformanceMeasure | undefined;

        } catch {}
      }
    },

    createWorkspace: async (name, dbUrl, icon) => {
      set({ isCreatingWorkspace: true, workspaceError: null });

      const parsedHost = (() => {
        if (!dbUrl) return undefined;
        try {
          const u = new URL(dbUrl);
          return u.hostname;
        } catch {
          return undefined;
        }
      })();

      let createdDto: any = null;
      try {
        const trimmedDbUrl = (dbUrl ?? "").trim();
        const res = await fetch(`${BACKEND_URL}/api/workspaces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // ponytail: creation must surface, never spin forever (server-side
          // stalls previously left the portal on "Provisioning" with no error).
          signal: AbortSignal.timeout(120_000),
          // D1/C3 local-first: one honest policy — DB-optional. Empty = local.
          body: JSON.stringify(trimmedDbUrl
            ? { name, icon: icon || '💼', databaseUrl: trimmedDbUrl }
            : { name, icon: icon || '💼' }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData.message || 'Failed to create workspace';
          set({ workspaceError: errMsg, isCreatingWorkspace: false });
          throw new Error(errMsg);
        }

        createdDto = await res.json();
      } catch (err: any) {
        if (get().workspaceError) {
          throw err;
        }
        // Network / offline fallback
        console.warn('Backend database proxy verification failed, offline mode active.');
        const newWS: Workspace = {
          id: `ws-${Date.now()}`,
          name: name,
          icon: icon || '💼',
          dbUrl: dbUrl || 'local://sandbox-env',
          database: dbUrl ? {
            configured: false,
            pendingSync: true,
            host: parsedHost,
          } : undefined,
          categories: [],
          channels: [],
          createdAt: new Date().toISOString(),
        };

        const updatedWorkspaces = [...get().workspaces, newWS];
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('crowdos_workspaces', JSON.stringify(updatedWorkspaces));
          localStorage.setItem('crowdos_active_workspace', newWS.id);
        }
        set({
          workspaces: updatedWorkspaces,
          isCreatingWorkspace: false,
          activeWorkspaceId: newWS.id,
          activeChannelId: null,
        });
        return;
      }

      const newWS: Workspace = {
        id: createdDto.id,
        name: createdDto.name,
        icon: createdDto.icon,
        database: createdDto.database,
        screenLockEnabled: createdDto.screenLockEnabled,
        categories: [],
        channels: [],
        createdAt: createdDto.createdAt,
        updatedAt: createdDto.updatedAt,
      };

      const updatedWorkspaces = [...get().workspaces.filter(w => w.id !== newWS.id), newWS];
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_workspaces', JSON.stringify(updatedWorkspaces));
        localStorage.setItem('crowdos_active_workspace', newWS.id);
      }
      set({
        workspaces: updatedWorkspaces,
        isCreatingWorkspace: false,
        activeWorkspaceId: newWS.id,
      });

      await get().fetchWorkspaces();
    },

    updateWorkspace: async (id, patch) => {
      set({ isUpdatingWorkspace: true, workspaceError: null });

      const parsedHost = (() => {
        if (!patch.databaseUrl) return undefined;
        try {
          const u = new URL(patch.databaseUrl);
          return u.hostname;
        } catch {
          return undefined;
        }
      })();

      try {
        const res = await fetch(`${BACKEND_URL}/api/workspaces/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData.message || 'Failed to update workspace';
          set({ workspaceError: errMsg, isUpdatingWorkspace: false });
          throw new Error(errMsg);
        }

        const updatedDto = await res.json();
        set(s => ({
          isUpdatingWorkspace: false,
          workspaces: s.workspaces.map(w =>
            w.id === id
              ? {
                  ...w,
                  name: updatedDto.name ?? w.name,
                  icon: updatedDto.icon ?? w.icon,
                  database: updatedDto.database ?? w.database,
                  storagePreference: updatedDto.storagePreference ?? w.storagePreference,
                  dbSync: updatedDto.dbSync ?? w.dbSync ?? null,
                }
              : w
          ),
        }));
        await get().fetchDbSync(id).catch(() => {});
      } catch (err: any) {
        if (get().workspaceError) {
          throw err;
        }
        set(s => ({
          isUpdatingWorkspace: false,
          workspaces: s.workspaces.map(w =>
            w.id === id
              ? {
                  ...w,
                  name: patch.name ?? w.name,
                  icon: patch.icon ?? w.icon,
                  database: patch.databaseUrl
                    ? {
                        configured: false,
                        pendingSync: true,
                        host: parsedHost,
                      }
                    : undefined,
                }
              : w
          ),
        }));
      }
    },

    fetchDbSync: async (id) => {
      const targetId = id ?? get().activeWorkspaceId;
      if (!targetId) {
        set({ dbSyncStatus: null });
        return;
      }
      try {
        const status = await apiClient.getDbSync(targetId);
        set({ dbSyncStatus: status });
        set(s => ({
          workspaces: s.workspaces.map(w =>
            w.id === targetId
              ? { ...w, storagePreference: status.storagePreference, dbSync: status.dbSync as any }
              : w
          ),
        }));
      } catch {
        // Sync status is advisory — a failed probe must never break the shell.
      }
    },

    setStoragePreference: async (id, preference) => {
      await get().updateWorkspace(id, { storagePreference: preference });
      await get().fetchDbSync(id).catch(() => {});
    },

    resolveDbConflict: async (id, choice) => {
      set({ isSyncing: true, workspaceError: null });
      try {
        const result = await apiClient.postDbSync(id, { action: 'resolve', choice });
        await get().fetchDbSync(id).catch(() => {});
        await get().fetchWorkspaces().catch(() => {});
        return result;
      } catch (err: any) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to resolve sync conflict' });
        throw err;
      } finally {
        set({ isSyncing: false });
      }
    },

    syncNow: async (id) => {
      set({ isSyncing: true, workspaceError: null });
      try {
        const result = await apiClient.postDbSync(id, { action: 'sync-now' });
        await get().fetchDbSync(id).catch(() => {});
        return result;
      } catch (err: any) {
        set({ workspaceError: err instanceof Error ? err.message : 'Sync failed' });
        throw err;
      } finally {
        set({ isSyncing: false });
      }
    },

    rebuildRag: async (id) => {
      set({ isSyncing: true, workspaceError: null });
      try {
        const result = await apiClient.postDbSync(id, { action: 'rebuild-rag' });
        await get().fetchDbSync(id).catch(() => {});
        return result;
      } catch (err: any) {
        set({ workspaceError: err instanceof Error ? err.message : 'Index rebuild failed' });
        throw err;
      } finally {
        set({ isSyncing: false });
      }
    },

    deleteWorkspace: async (id, opts) => {
      try {
        const qs = opts?.flush ? '?flush=true' : '';
        await fetch(`${BACKEND_URL}/api/workspaces/${encodeURIComponent(id)}${qs}`, {
          method: 'DELETE',
        });
      } catch {}

      const updatedWorkspaces = get().workspaces.filter(ws => ws.id !== id);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_workspaces', JSON.stringify(updatedWorkspaces));
      }

      let nextActiveWorkspaceId = null;
      let nextActiveChannelId = null;

      if (updatedWorkspaces.length > 0) {
        nextActiveWorkspaceId = updatedWorkspaces[0].id;
        nextActiveChannelId = updatedWorkspaces[0].categories[0]?.channels[0]?.id || null;
      }

      set({
        workspaces: updatedWorkspaces,
        activeWorkspaceId: nextActiveWorkspaceId,
        activeChannelId: nextActiveChannelId,
      });

      if (typeof localStorage !== 'undefined') {
        if (nextActiveWorkspaceId) {
          localStorage.setItem('crowdos_active_workspace', nextActiveWorkspaceId);
          persistActiveChannel(nextActiveChannelId);
          if (nextActiveChannelId) pushChannelHistory(nextActiveWorkspaceId, nextActiveChannelId, true);
        } else {
          localStorage.removeItem('crowdos_active_workspace');
          localStorage.removeItem('crowdos_active_channel');
          if (typeof window !== 'undefined') {
            try { window.history.pushState({}, '', window.location.pathname); } catch {}
          }
        }
      }
    },

    // ponytail: tenant slices are per-database — never carry another
    // workspace's rows across a switch or a failed refresh.
    clearTenantSlices: () => {
      set({
        agents: [],
        messages: [],
        modelProfiles: [],
        instructionModules: [],
        modelModules: [],
        toolkitModules: [],
        constraintsModules: [],
        capabilitiesModules: [],
        archivedChannels: [],
      });
      if (typeof localStorage !== 'undefined') {
        for (const k of ['crowdos_agents', 'crowdos_messages', 'crowdos_model_profiles', 'crowdos_instruction_modules', 'crowdos_model_modules', 'crowdos_toolkit_modules', 'crowdos_constraints_modules', 'crowdos_capabilities_modules']) {
          try { localStorage.removeItem(k); } catch {}
        }
      }
    },

    enterWorkspace: async (id) => {
      // D1 switch teardown: leave previously observed rooms before slicing.
      // §30: the leave carries the workspace the room was joined under.
      const prevWs = get().activeWorkspaceId;
      const prevCh = get().activeChannelId;
      if (prevCh) emitChannelLeave(prevCh, prevWs);
      if (prevWs && prevWs !== id) emitWorkspaceLeave(prevWs);
      setActiveWorkspaceId(id);
      get().clearTenantSlices();
      const currentWS = get().workspaces.find(ws => ws.id === id);
      // Prefer persisted or hash channel if valid for this workspace
      const storedChannelId = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_active_channel') : null;
      const hashChannelId = getHashChannelId();
      const validIds = new Set([
        ...(currentWS?.channels?.map(c => c.id) || []),
        ...(currentWS?.categories.flatMap(c => c.channels.map(ch => ch.id)) || [])
      ]);
      let chId: string | null = null;
      if (hashChannelId && validIds.has(hashChannelId)) chId = hashChannelId;
      else if (storedChannelId && validIds.has(storedChannelId)) chId = storedChannelId;
      else chId = currentWS?.categories[0]?.channels[0]?.id || getFirstChannelId(currentWS as Workspace | undefined);
      
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_active_workspace', id);
        persistActiveChannel(chId);
      }
      if (chId) pushChannelHistory(id, chId, false);

      set({
        activeWorkspaceId: id,
        activeChannelId: chId,
        mobileDrawerLeft: false,
        mobileDrawerRight: false,
        activeMobileTab: 'chat'
      });

      await get().fetchWorkspaces();
      await get().fetchDbSync(id).catch(() => {});
      // §6: apply the entered channel's OWN pin before the composer is used.
      get().resetOnChannelChange(chId ?? undefined);
      if (chId) void get().hydrateChannelPin(chId);
    },

    leaveWorkspace: () => {
      // §30: leave both rooms under the workspace they were joined in.
      const prevWs = get().activeWorkspaceId;
      const prevCh = get().activeChannelId;
      if (prevCh) emitChannelLeave(prevCh, prevWs);
      if (prevWs) emitWorkspaceLeave(prevWs);
      setActiveWorkspaceId(null);
      get().clearTenantSlices();
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('crowdos_active_workspace');
        localStorage.removeItem('crowdos_active_channel');
      }
      if (typeof window !== 'undefined') {
        try { window.history.pushState({}, '', window.location.pathname); } catch {}
      }
      set({ 
        activeWorkspaceId: null, 
        activeChannelId: null,
        selectedAgentId: null,
        settingsModalOpen: false,
        agentProfileModalOpen: false
      });
    },

    setActiveChannel: async (id) => {
      // D1: leave the previously observed channel room before joining the next.
      // §30: the leave names the workspace the room was joined under.
      const prevActive = get().activeChannelId;
      if (prevActive && prevActive !== id) emitChannelLeave(prevActive, get().activeWorkspaceId);
      // Clear notifications across both categories and top-level channels
      const updatedWorkspaces = get().workspaces.map(ws => {
        if (ws.id === get().activeWorkspaceId) {
          return {
            ...ws,
            channels: ws.channels ? ws.channels.map(ch => {
              if (ch.id === id) {
                return { ...ch, unreadCount: 0, hasMention: false };
              }
              return ch;
            }) : undefined,
            categories: ws.categories.map(cat => ({
              ...cat,
              channels: cat.channels.map(ch => {
                if (ch.id === id) {
                  return { ...ch, unreadCount: 0, hasMention: false };
                }
                return ch;
              })
            }))
          };
        }
        return ws;
      });

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_workspaces', JSON.stringify(updatedWorkspaces));
      }

      persistActiveChannel(id);
      pushChannelHistory(get().activeWorkspaceId, id, false);

      set({
        activeChannelId: id,
        workspaces: updatedWorkspaces,
        mobileDrawerLeft: false
      });

      // §6: the ARRIVING channel's own pin decides the composer state. This is
      // unconditional — a pin in the channel we just left must not leak here,
      // and a pin in the channel we just entered must be restored.
      get().resetOnChannelChange(id);
      // ...then reconcile against the server row, which is the source of truth
      // (another device or session may have changed the pin).
      void get().hydrateChannelPin(id);

      emitChannelJoinDebounced(id);

      try {
        const msgRes = await fetch(`${BACKEND_URL}/api/channels/${id}/messages`);
        if (msgRes.ok) {
          const payload = await msgRes.json();
          const { chronological, cursor } = parseMessagesEnvelope(payload);
          const mappedMessages = chronological.map(mapBackendMessage);
          set({
            messages: mappedMessages,
            channelCursors: { ...get().channelCursors, [id]: cursor }
          });
          const maxSeq = chronological.reduce((m: number, r: any) => Math.max(m, r.sequenceNumber ?? 0), 0);
          if (maxSeq > 0) persistSeq(id, maxSeq);
        }
      } catch {
        console.warn("Failed to fetch live message logs from backend, local store logs active.");
      }

      try {
        const afterSeq = seqCursors[id] ?? 0;
        if (afterSeq > 0) {
          await fetchGapAndDigest(id, afterSeq);
        }
      } catch {}

      const pendingDigest = (get() as any).reconnectDigest;
      if (pendingDigest?.visible) {
        setTimeout(() => {
          const cur = (get() as any).reconnectDigest;
          if (cur?.message === pendingDigest.message) set({ reconnectDigest: null } as any);
        }, 9000);
      }
    },

    // PERF-5: fetch the previous page via the keyset cursor and prepend it.
    loadOlderMessages: async () => {
      const channelId = get().activeChannelId;
      if (!channelId || get().isLoadingOlder) return;
      const cursor = get().channelCursors[channelId];
      if (!cursor) return;

      set({ isLoadingOlder: true });
      try {
        const msgRes = await fetch(
          `${BACKEND_URL}/api/channels/${channelId}/messages?before=${encodeURIComponent(encodeBeforeParam(cursor))}`
        );
        if (!msgRes.ok) return;
        const payload = await msgRes.json();
        const { chronological, cursor: nextCursor } = parseMessagesEnvelope(payload);
        const olderPage = chronological.map(mapBackendMessage);

        set(state => {
          const merged = prependOlderMessages(state.messages, olderPage);
          return {
            messages: merged,
            channelCursors: { ...state.channelCursors, [channelId]: nextCursor },
            isLoadingOlder: false
          };
        });
      } catch {
        set({ isLoadingOlder: false });
      }
    },

    addMessage: (msg) => {
      const activeCh = get().activeChannelId;
      if (!activeCh) return;
      socket.emit('user:message', {
        channelId: activeCh,
        content: msg.content,
        mentions: msg.mentions || [],
       mode: (msg as any).mode || (msg as any).runtimeMode || get().selectedMode,
        runtimeMode: (msg as any).mode || (msg as any).runtimeMode || get().selectedMode,
      });
    },

    clearChannelMessages: (channelId) => {
      const updated = get().messages.filter(msg => msg.channelId !== channelId);
      writeMessagesMirror(updated);
      set({ messages: updated });
    },

    // Agent operations
    addAgent: async (agent) => {
      try {
        // Local mode: the server seeds canon default modules and resolves
        // missing references on create, so an empty catalog is not an error.
        const modelModuleId = agent.modelModuleId || get().modelModules[0]?.id || null;
        const instructionModuleId = agent.instructionModuleId || get().instructionModules[0]?.id || 'instr-default';

        const body = {
          name: agent.name,
          title: agent.description || 'Agent node',
          species: agent.species || 'Crow',
          avatar: agent.avatar || '🤖',
          authorityLevel: agent.level,
          modelModuleId,
          instructionModuleId,
          toolkitModuleId: agent.toolkitModuleId || undefined,
          isOmniscient: agent.isOmniscient || false,
          memorySharingPolicy: agent.level === 0 ? 'full' : agent.level === 1 ? 'full' : 'vertical',
          permissions: { spawnAgents: true, patchRuntime: true, accessAllChannels: true },
          status: toBackendAgentStatus(agent.status) || 'idle'
        };

        await fetchJsonOrThrow<Agent>(`${BACKEND_URL}/api/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }, 'Failed to create agent.');
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create agent.';
        console.error("Failed to commit agent to live database.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    updateAgentStatus: (id, status) => {
      const updated = get().agents.map(ag => {
        if (ag.id === id) {
          return { ...ag, status, lastActive: new Date().toISOString() };
        }
        return ag;
      });
      set({ agents: updated });
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_agents', JSON.stringify(updated));
      }
    },

    updateAgent: async (id, patch) => {
      try {
        const body: Record<string, any> = {};
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.description !== undefined) body.title = patch.description;
        if (patch.species !== undefined) body.species = patch.species;
        if (patch.level !== undefined) body.authorityLevel = patch.level;
        if (patch.avatar !== undefined) body.avatar = patch.avatar;
        if (patch.instructionModuleId !== undefined) body.instructionModuleId = patch.instructionModuleId;
        if (patch.modelModuleId !== undefined) body.modelModuleId = patch.modelModuleId;
        if ('toolkitModuleId' in patch) body.toolkitModuleId = patch.toolkitModuleId ?? null;
        if (patch.isOmniscient !== undefined) body.isOmniscient = patch.isOmniscient;
        const backendStatus = toBackendAgentStatus(patch.status);
        if (backendStatus !== undefined) body.status = backendStatus;
        // Permissions are advisory-only here; the backend merges partial
        // updates over the existing deny-by-default blob. Never force-grant.

        await fetchJsonOrThrow<Agent>(`${BACKEND_URL}/api/agents/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }, 'Failed to update agent.');
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update agent.';
        console.error("Failed to save agent profile update to database.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    deleteAgent: async (id) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/agents/${id}`, {
          method: 'DELETE'
        }, 'Failed to delete agent.');
        const updated = get().agents.filter(ag => ag.id !== id);
        set({ agents: updated });
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('crowdos_agents', JSON.stringify(updated));
        }
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete agent.';
        console.error("Failed to delete agent.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    openAgentProfileModal: (agentId) => {
      set({ selectedAgentId: agentId, agentProfileModalOpen: true });
    },

    closeAgentProfileModal: () => {
      set({ selectedAgentId: null, agentProfileModalOpen: false });
    },

    // Model Profile CRUD actions
    addModelProfile: async (profile) => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/providers/generation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: profile.label,
            provider: profile.provider,
            modelName: profile.modelName,
            apiKey: profile.apiKey || 'mock-key',
            endpointUrl: profile.baseUrl || null,
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: 2048,
            maxRecentMessages: 10,
            compressionThreshold: 15
          })
        });
        if (res.ok) {
          await get().fetchWorkspaces();
        }
      } catch (err) {
        console.error("Failed to create Model profile card, using offline mock fallback.", err);
        const newProf: ModelProfile = {
          ...profile,
          id: `prof-${Date.now()}`,
          createdAt: new Date().toISOString()
        };
        const updated = [...get().modelProfiles, newProf];
        set({ modelProfiles: updated });
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('crowdos_model_profiles', JSON.stringify(updated));
        }
      }
    },

    updateModelProfile: async (id, patch) => {
      try {
        const body: Record<string, any> = {};
        if (patch.label !== undefined) body.label = patch.label;
        if (patch.provider !== undefined) body.provider = patch.provider;
        if (patch.modelName !== undefined) body.modelName = patch.modelName;
        if (patch.apiKey !== undefined) body.apiKey = patch.apiKey;
        if (patch.baseUrl !== undefined) body.endpointUrl = patch.baseUrl;

        const res = await fetch(`${BACKEND_URL}/api/providers/generation/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (res.ok) {
          await get().fetchWorkspaces();
        }
      } catch (err) {
        console.error("Failed to update Model profile card, using offline mock fallback.", err);
        const updated = get().modelProfiles.map(prof => {
          if (prof.id === id) {
            return { ...prof, ...patch, updatedAt: new Date().toISOString() };
          }
          return prof;
        });
        set({ modelProfiles: updated });
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('crowdos_model_profiles', JSON.stringify(updated));
        }
      }
    },

    deleteModelProfile: async (id) => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/providers/generation/${id}`, {
          method: 'DELETE'
        });
        if (res.ok) {
          const updated = get().modelProfiles.filter(prof => prof.id !== id);
          set({ modelProfiles: updated });
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('crowdos_model_profiles', JSON.stringify(updated));
          }
          await get().fetchWorkspaces();
        }
      } catch (err) {
        console.error("Failed to delete Model profile card, using offline mock fallback.", err);
        const updated = get().modelProfiles.filter(prof => prof.id !== id);
        set({ modelProfiles: updated });
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('crowdos_model_profiles', JSON.stringify(updated));
        }
      }
    },

    // Module management CRUD
    addInstructionModule: async (mod) => {
      try {
        await fetchJsonOrThrow<InstructionModule>(`${BACKEND_URL}/api/modules/instruction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: mod.name,
            base: [mod.systemPrompt],
            runtimePatchable: true
          })
        }, 'Failed to create InstructionModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to create InstructionModule.' });
        throw err;
      }
    },

    updateInstructionModule: async (id, patch) => {
      try {
        await fetchJsonOrThrow<InstructionModule>(`${BACKEND_URL}/api/modules/instruction/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: patch.name,
            base: patch.systemPrompt ? [patch.systemPrompt] : undefined
          })
        }, 'Failed to update InstructionModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to update InstructionModule.' });
        throw err;
      }
    },

    deleteInstructionModule: async (id) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/modules/instruction/${id}`, {
          method: 'DELETE'
        }, 'Failed to delete InstructionModule.');
        const updated = get().instructionModules.filter(m => m.id !== id);
        set({ instructionModules: updated });
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to delete InstructionModule.' });
        throw err;
      }
    },

    addModelModule: async (mod) => {
      try {
        await fetchJsonOrThrow<ModelModule>(`${BACKEND_URL}/api/modules/model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: mod.name,
            provider: mod.provider || 'google',
            modelName: mod.modelProfileId || 'gemini-2.5-flash',
            apiKey: mod.apiKey || '',
            endpointUrl: mod.baseUrl || null,
            temperature: mod.temperature || 0.7,
            topP: mod.topP ?? 0.9,
            maxOutputTokens: mod.maxTokens || 2048,
            maxRecentMessages: mod.maxRecentMessages ?? 10,
            enableCompression: mod.enableCompression ?? true,
            compressionThreshold: mod.compressionThreshold ?? 15
          })
        }, 'Failed to create ModelModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to create ModelModule.' });
        throw err;
      }
    },

    updateModelModule: async (id, patch) => {
      try {
        // Send only the fields actually provided: the redacted read returns
        // masks for secrets and the edit form omits unchanged numbers, so a
        // blind spread would send null/NaN and fail server validation.
        const body: Record<string, unknown> = {};
        if (patch.name !== undefined) body.label = patch.name;
        if (patch.provider !== undefined) body.provider = patch.provider;
        if (patch.modelProfileId !== undefined) body.modelName = patch.modelProfileId;
        if (patch.apiKey !== undefined && patch.apiKey !== '') body.apiKey = patch.apiKey;
        if (patch.baseUrl !== undefined) body.endpointUrl = patch.baseUrl || null;
        if (patch.temperature != null && Number.isFinite(patch.temperature)) body.temperature = patch.temperature;
        if (patch.topP != null && Number.isFinite(patch.topP)) body.topP = patch.topP;
        if (patch.maxTokens != null && Number.isFinite(patch.maxTokens)) body.maxOutputTokens = patch.maxTokens;
        if (patch.maxRecentMessages != null && Number.isFinite(patch.maxRecentMessages)) body.maxRecentMessages = patch.maxRecentMessages;
        if (patch.enableCompression !== undefined) body.enableCompression = patch.enableCompression;
        if (patch.compressionThreshold != null && Number.isFinite(patch.compressionThreshold)) body.compressionThreshold = patch.compressionThreshold;
        await fetchJsonOrThrow<ModelModule>(`${BACKEND_URL}/api/modules/model/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }, 'Failed to update ModelModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to update ModelModule.' });
        throw err;
      }
    },

    deleteModelModule: async (id) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/modules/model/${id}`, {
          method: 'DELETE'
        }, 'Failed to delete ModelModule.');
        const updated = get().modelModules.filter(m => m.id !== id);
        set({ modelModules: updated });
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to delete ModelModule.' });
        throw err;
      }
    },

    addToolkitModule: async (mod) => {
      try {
        await fetchJsonOrThrow<ToolkitModule>(`${BACKEND_URL}/api/modules/toolkit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: mod.name,
            tools: mod.enabledToolIds
          })
        }, 'Failed to create ToolkitModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to create ToolkitModule.' });
        throw err;
      }
    },

    updateToolkitModule: async (id, patch) => {
      try {
        await fetchJsonOrThrow<ToolkitModule>(`${BACKEND_URL}/api/modules/toolkit/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: patch.name,
            tools: patch.enabledToolIds
          })
        }, 'Failed to update ToolkitModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to update ToolkitModule.' });
        throw err;
      }
    },

    deleteToolkitModule: async (id) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/modules/toolkit/${id}`, {
          method: 'DELETE'
        }, 'Failed to delete ToolkitModule.');
        const updated = get().toolkitModules.filter(m => m.id !== id);
        set({ toolkitModules: updated });
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to delete ToolkitModule.' });
        throw err;
      }
    },

    addConstraintsModule: async (mod) => {
      try {
        await fetchJsonOrThrow<ConstraintsModule>(`${BACKEND_URL}/api/modules/constraints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: mod.name,
            rules: mod.rules || [],
            disallowedActions: mod.disallowedActions || []
          })
        }, 'Failed to create ConstraintsModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to create ConstraintsModule.' });
        throw err;
      }
    },

    updateConstraintsModule: async (id, patch) => {
      try {
        await fetchJsonOrThrow<ConstraintsModule>(`${BACKEND_URL}/api/modules/constraints/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: patch.name,
            rules: patch.rules,
            disallowedActions: patch.disallowedActions
          })
        }, 'Failed to update ConstraintsModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to update ConstraintsModule.' });
        throw err;
      }
    },

    deleteConstraintsModule: async (id) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/modules/constraints/${id}`, {
          method: 'DELETE'
        }, 'Failed to delete ConstraintsModule.');
        const updated = get().constraintsModules.filter(m => m.id !== id);
        set({ constraintsModules: updated });
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to delete ConstraintsModule.' });
        throw err;
      }
    },

    addCapabilitiesModule: async (mod) => {
      try {
        await fetchJsonOrThrow<CapabilitiesModule>(`${BACKEND_URL}/api/modules/capabilities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: mod.name,
            skills: mod.skills || [],
            functionSchemas: mod.functionSchemas || []
          })
        }, 'Failed to create CapabilitiesModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to create CapabilitiesModule.' });
        throw err;
      }
    },

    updateCapabilitiesModule: async (id, patch) => {
      try {
        await fetchJsonOrThrow<CapabilitiesModule>(`${BACKEND_URL}/api/modules/capabilities/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: patch.name,
            skills: patch.skills,
            functionSchemas: patch.functionSchemas
          })
        }, 'Failed to update CapabilitiesModule.');
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to update CapabilitiesModule.' });
        throw err;
      }
    },

    deleteCapabilitiesModule: async (id) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/modules/capabilities/${id}`, {
          method: 'DELETE'
        }, 'Failed to delete CapabilitiesModule.');
        const updated = get().capabilitiesModules.filter(m => m.id !== id);
        set({ capabilitiesModules: updated });
        await get().fetchWorkspaces();
      } catch (err) {
        set({ workspaceError: err instanceof Error ? err.message : 'Failed to delete CapabilitiesModule.' });
        throw err;
      }
    },

    // Overrides management
    addRuntimeOverride: (override) => {
      const newOver: RuntimeOverride = {
        ...override,
        id: `ov-${Date.now()}`,
        createdAt: new Date().toISOString()
      };
      set(s => ({ runtimeOverrides: [...s.runtimeOverrides, newOver] }));
    },

    toggleRuntimeOverride: (id, active) => {
      set(s => ({
        runtimeOverrides: s.runtimeOverrides.map(o => o.id === id ? { ...o, active } : o)
      }));
    },

    deleteRuntimeOverride: (id) => {
      set(s => ({
        runtimeOverrides: s.runtimeOverrides.filter(o => o.id !== id)
      }));
    },

    // Sidebar & Modal Layout controls
    toggleRightSidebar: () => set(s => ({ rightSidebarOpen: !s.rightSidebarOpen })),
    setRightSidebarOpen: (isOpen) => set({ rightSidebarOpen: isOpen }),
    toggleLeftSidebar: () => set(s => ({ leftSidebarCollapsed: !s.leftSidebarCollapsed })),
    setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),
    setWorkspaceSettingsTab: (tab) => set({ workspaceSettingsTab: tab }),
    
    deleteCategory: async (categoryId) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/categories/${categoryId}`, {
          method: 'DELETE'
        }, 'Failed to delete category.');
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete category.';
        console.error("Failed to delete category.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    createCategory: async (name) => {
      try {
        await fetchJsonOrThrow<Category>(`${BACKEND_URL}/api/categories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            createdBy: 'user',
            position: get().workspaces.find(w => w.id === get().activeWorkspaceId)?.categories.length || 0
          })
        }, 'Failed to create category.');
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create category.';
        console.error("Failed to create category.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    createChannel: async (categoryId, name, description) => {
      try {
        const activeWS = get().workspaces.find(w => w.id === get().activeWorkspaceId);
        let position = 0;
        if (categoryId) {
          const cat = activeWS?.categories.find(c => c.id === categoryId);
          position = cat?.channels.length || 0;
        } else {
          position = activeWS?.channels?.length || 0;
        }

        await fetchJsonOrThrow<Channel>(`${BACKEND_URL}/api/channels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            categoryId,
            name,
            createdBy: 'user',
            position
          })
        }, 'Failed to create channel.');
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create channel.';
        console.error("Failed to create channel.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    deleteChannel: async (channelId) => {
      try {
        await fetchNoContentOrThrow(`${BACKEND_URL}/api/channels/${channelId}`, {
          method: 'DELETE'
        }, 'Failed to delete channel.');
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete channel.';
        console.error("Failed to delete channel.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    archiveChannel: async (channelId, archive) => {
      try {
        await fetchJsonOrThrow<Channel>(`${BACKEND_URL}/api/channels/${channelId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: archive ? 'archived' : 'standard'
          })
        }, archive ? 'Failed to archive channel.' : 'Failed to restore channel.');
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to archive channel.';
        console.error("Failed to archive channel.", err);
        set({ workspaceError: message });
        throw err;
      }
    },

    reorderCategory: async (categoryId, direction) => {
      const activeWS = get().workspaces.find(w => w.id === get().activeWorkspaceId);
      if (!activeWS) return;
      const index = activeWS.categories.findIndex(c => c.id === categoryId);
      if (index === -1) return;

      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= activeWS.categories.length) return;

      const updatedCategories = [...activeWS.categories];
      const [removed] = updatedCategories.splice(index, 1);
      updatedCategories.splice(targetIndex, 0, removed);

      const updatedWorkspaces = get().workspaces.map(ws =>
        ws.id === get().activeWorkspaceId ? { ...ws, categories: updatedCategories } : ws
      );
      set({ workspaces: updatedWorkspaces });

      try {
        await Promise.all(updatedCategories.map((category, position) =>
          fetchJsonOrThrow<Category>(`${BACKEND_URL}/api/categories/${category.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position })
          }, 'Failed to reorder category.')
        ));
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to reorder category.';
        console.error("Failed to reorder category.", err);
        set({ workspaceError: message });
        await get().fetchWorkspaces();
        throw err;
      }
    },

    reorderChannel: async (channelId, direction) => {
      const activeWS = get().workspaces.find(w => w.id === get().activeWorkspaceId);
      if (!activeWS) return;

      let foundCatId = null;
      let foundIndex = -1;
      let channelList = activeWS.channels || [];

      const topLevelIndex = channelList.findIndex(ch => ch.id === channelId);
      if (topLevelIndex !== -1) {
        foundIndex = topLevelIndex;
      }

      if (foundIndex === -1) {
        for (const cat of activeWS.categories) {
          const idx = cat.channels.findIndex(ch => ch.id === channelId);
          if (idx !== -1) {
            foundCatId = cat.id;
            foundIndex = idx;
            channelList = cat.channels;
            break;
          }
        }
      }

      if (foundIndex === -1) return;

      const targetIndex = direction === 'up' ? foundIndex - 1 : foundIndex + 1;
      if (targetIndex < 0 || targetIndex >= channelList.length) return;

      const updatedChannels = [...channelList];
      const [removed] = updatedChannels.splice(foundIndex, 1);
      updatedChannels.splice(targetIndex, 0, removed);

      const updatedCategories = foundCatId
        ? activeWS.categories.map(c => c.id === foundCatId ? { ...c, channels: updatedChannels } : c)
        : activeWS.categories;

      const updatedWorkspaces = get().workspaces.map(ws =>
        ws.id === get().activeWorkspaceId
          ? { ...ws, channels: foundCatId ? ws.channels : updatedChannels, categories: updatedCategories }
          : ws
      );
      set({ workspaces: updatedWorkspaces });

      try {
        await Promise.all(updatedChannels.map((channel, position) =>
          fetchJsonOrThrow<Channel>(`${BACKEND_URL}/api/channels/${channel.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position })
          }, 'Failed to reorder channel.')
        ));
        await get().fetchWorkspaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to reorder channel.';
        console.error("Failed to reorder channel.", err);
        set({ workspaceError: message });
        await get().fetchWorkspaces();
        throw err;
      }
    },

    toggleCategoryCollapse: (categoryId) => {
      const updatedWorkspaces = get().workspaces.map(ws => {
        if (ws.id === get().activeWorkspaceId) {
          return {
            ...ws,
            categories: ws.categories.map(cat => {
              if (cat.id === categoryId) {
                return { ...cat, collapsed: !cat.collapsed };
              }
              return cat;
            })
          };
        }
        return ws;
      });
      set({ workspaces: updatedWorkspaces });
    },

    // Mobile States routing
    setSelectedSandboxFile: (file) => set({ selectedSandboxFile: file }),
    incrementFilesystemRevision: () => set(state => ({ filesystemRevision: state.filesystemRevision + 1 })),
    setActiveMobileTab: (tab) => set({ activeMobileTab: tab }),
    setMobileDrawerLeft: (open) => set({ mobileDrawerLeft: open }),
    setMobileDrawerRight: (open) => set({ mobileDrawerRight: open }),
    selectChannelMobile: (channelId) => {
      get().setActiveChannel(channelId);
      set({ activeMobileTab: 'chat', mobileDrawerLeft: false });
    },

    // Tool toggling status
    toggleToolEnabled: (toolId) => {
      const updated = get().tools.map(tool => {
        if (tool.id === toolId) {
          return { ...tool, enabled: !tool.enabled };
        }
        return tool;
      });
      set({ tools: updated });
    },

    incrementToolUsage: (toolId) => {
      const updated = get().tools.map(tool => {
        if (tool.id === toolId) {
          return { ...tool, usageCount: tool.usageCount + 1 };
        }
        return tool;
      });
      set({ tools: updated });
    },

    // Roles actions 
    addRole: (role) => {
      const newRole: Role = {
        ...role,
        id: `role-${Date.now()}`
      };
      set(s => ({ roles: [...s.roles, newRole] }));
    },
    
    updateRole: (id, patch) => {
      set(s => ({
        roles: s.roles.map(r => r.id === id ? { ...r, ...patch } : r)
      }));
    },
    
    reorderRoles: (startIndex, endIndex) => {
      set(s => {
        const result = Array.from(s.roles);
        const [removed] = result.splice(startIndex, 1);
        result.splice(endIndex, 0, removed);
        return { roles: result };
      });
    },

    deleteRole: (id) => {
      set(s => ({ roles: s.roles.filter(r => r.id !== id) }));
    },

    // Budget Actions implementation
    fetchBudget: async () => {
      try {
        // Defense in depth: skip the PG-only call for DB-less workspaces so
        // local mode never logs a guaranteed 501 (socket budget handlers and
        // settings flows can still call this directly).
        const activeWs = get().workspaces.find(w => w.id === get().activeWorkspaceId);
        if (!activeWs?.database?.configured) return;
        const res = await fetch(`${BACKEND_URL}/api/workspace/budget`);
        if (res.ok) {
          const data = await res.json();
          const perProvider = data.perProviderBudget || {};
          let totalConsumed = 0;
          for (const key of Object.keys(perProvider)) {
            totalConsumed += perProvider[key].used || 0;
          }
          set({
            globalSoftCap: data.globalSoftCap ?? 1000000,
            perProviderBudget: perProvider,
            totalTokensConsumed: totalConsumed
          });
        }
      } catch (err) {
        console.error("Failed to fetch workspace budget telemetry", err);
      }
    },

    updateBudget: async (globalSoftCap, perProviderBudget) => {
      try {
        const body: any = {};
        if (globalSoftCap !== undefined) body.globalSoftCap = globalSoftCap;
        if (perProviderBudget !== undefined) body.perProviderBudget = perProviderBudget;

        const res = await fetch(`${BACKEND_URL}/api/workspace/budget`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (res.ok) {
          await get().fetchBudget();
        }
      } catch (err) {
        console.error("Failed to update budget", err);
      }
    },

    resetBudget: async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/workspace/budget/reset`, {
          method: 'POST'
        });
        if (res.ok) {
          await get().fetchBudget();
        }
      } catch (err) {
        console.error("Failed to reset budget logs", err);
      }
    },

    decideApproval: async (approvalId, decision, scope) => {
      set((state: any) => ({
        approvalRequests: state.approvalRequests.map((r: ApprovalRequest) =>
          r.id === approvalId ? { ...r, status: decision } : r
        ),
      }));
      try {
        await apiClient.decideApproval(approvalId, decision, scope ?? null);
      } catch (err) {
        console.error('[store] decideApproval failed', err);
        throw err;
      }
    },

    fetchArtifacts: async (runId) => {
      try {
        const data = await apiClient.getArtifacts(runId);
        const rows: ArtifactRow[] = ((data as any).artifacts || data || []) as ArtifactRow[];
        const mapped = rows.map((r: any) => ({
          ...r,
          createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
        }));
        set((state: any) => ({
          artifactsByRun: { ...state.artifactsByRun, [runId]: mapped },
        }));
      } catch {}
    },

    applyDiff: async (artifactId) => {
      const all = Object.values(get().artifactsByRun as Record<string, ArtifactRow[]>).flat() as ArtifactRow[];
      const art = all.find((a) => a.id === artifactId);
      if (!art || !art.path) return;
      const workspaceId = get().activeWorkspaceId || art.workspaceId || 'default';
      const content = art.contentRef ?? '';
      await apiClient.applyFileContent(art.path, content, workspaceId);
      get().incrementFilesystemRevision();
    },

    revertDiff: async (artifactId) => {
      const all = Object.values(get().artifactsByRun as Record<string, ArtifactRow[]>).flat() as ArtifactRow[];
      const art = all.find((a) => a.id === artifactId);
      if (!art || !art.path) return;
      const workspaceId = get().activeWorkspaceId || art.workspaceId || 'default';
      if (!art.beforeHash) {
        await apiClient.deleteFile(art.path, workspaceId);
      } else {
        let before = '';
        if (art.patch) {
          const lines = art.patch.split('\n');
          const beforeLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
            if (line.startsWith('-') || line.startsWith(' ')) beforeLines.push(line.slice(1));
          }
          before = beforeLines.join('\n');
        }
        if (before) {
          await apiClient.applyFileContent(art.path, before, workspaceId);
        } else {
          await apiClient.deleteFile(art.path, workspaceId);
        }
      }
      get().incrementFilesystemRevision();
    },

    editResend: (originalMessageId, newContent) => {
      const state = get();
      const orig = state.messages.find((m: Message) => m.id === originalMessageId);
      const channelId = orig?.channelId || state.activeChannelId;
      if (!channelId || !newContent.trim()) return;
      socket.emit('user:message' as any, {
        channelId,
        content: newContent,
        mentions: orig?.mentions || [],
        mode: (state as any).selectedMode,
        runtimeMode: (state as any).selectedMode,
        originalMessageId,
      } as any);
    },

    regenerate: (messageId) => {
      const state = get();
      const target = state.messages.find((m: Message) => m.id === messageId);
      if (!target) return;
      const idx = state.messages.findIndex((m: Message) => m.id === messageId);
      let human: Message | undefined;
      for (let i = idx; i >= 0; i--) {
        const cand = state.messages[i];
        if (cand.type === 'human' && cand.channelId === target.channelId) {
          human = cand;
          break;
        }
      }
      const content = human?.content || target.content;
      const channelId = target.channelId;
      socket.emit('user:message' as any, {
        channelId,
        content,
        mentions: human?.mentions || [],
        mode: (state as any).selectedMode,
        runtimeMode: (state as any).selectedMode,
        regenerateFrom: messageId,
      } as any);
    },

    retryRun: async (runId) => {
      await apiClient.retryRun(runId);
    },
  };
});

