import { create } from 'zustand';
import { socket } from '../src/config/socket';
import { stripToolCalls } from '@community-agent/shared';
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
  CapabilitiesModule
} from '../types/crowd-os';

const BACKEND_URL = '';

async function readApiError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { message?: string; error?: string };
    return new Error(body.message || body.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

async function fetchJsonOrThrow<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw await readApiError(response, fallback);
  }
  return response.json() as Promise<T>;
}

async function fetchNoContentOrThrow(url: string, init: RequestInit, fallback: string): Promise<void> {
  const response = await fetch(url, init);
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
  vfsRevision: number;
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

  // Async indicators
  isFetchingWorkspaces: boolean;
  isCreatingWorkspace: boolean;
  workspaceError: string | null;

  // Actions
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, dbUrl?: string, icon?: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  enterWorkspace: (id: string) => Promise<void>;
  leaveWorkspace: () => void;
  setActiveChannel: (id: string) => Promise<void>;
  
  // Message actions
  addMessage: (msg: Omit<Message, 'id' | 'timestamp'>) => void;
  clearChannelMessages: (channelId: string) => void;

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
  incrementVfsRevision: () => void;

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
}

// Pre-configured items
const initialTools: Tool[] = [
  { id: 'web.search', name: 'Web Search', category: 'Intelligence', description: 'Search and scrape live web pages for up-to-date context.', enabled: true, usageCount: 42 },
  { id: 'sandbox.exec', name: 'Sandbox Code Exec', category: 'Computing', description: 'Run Python/TS files in an isolated micro-sandbox.', enabled: true, usageCount: 129 },
  { id: 'github.read', name: 'Repo Reader', category: 'VCS', description: 'Inspect structure, branches, and code files of git repositories.', enabled: true, usageCount: 81 },
  { id: 'db.query', name: 'Spanner Proxy', category: 'Database', description: 'Query the underlying high-performance transactional database.', enabled: false, usageCount: 0 },
  { id: 'agent.orchestrate', name: 'Sub-Agent Spawn', category: 'Swarm', description: 'Dynamically instantiate and patch temporary L3 agents.', enabled: true, usageCount: 56 }
];

const initialRoles: Role[] = [
  { id: 'role-l0', name: 'L0 Omniscient Monitor', color: 'oklch(0.75 0.12 180)', permissions: ['all'] },
  { id: 'role-l1', name: 'L1 Executive Administrator', color: 'oklch(0.65 0.15 25)', permissions: ['spawn_agents', 'patch_runtime', 'manage_budgets', 'kill_switch'] },
  { id: 'role-l2', name: 'L2 Operation Coordinator', color: 'oklch(0.62 0.15 250)', permissions: ['task_assign', 'tool_invoke', 'patch_temporary'] },
  { id: 'role-l3', name: 'L3 Autonomic Worker', color: 'oklch(0.60 0.12 145)', permissions: ['tool_invoke', 'sandbox_exec'] }
];

const initialModelProfiles: ModelProfile[] = [
  { id: 'prof-gemini-pro', label: 'Flagship Reasoner', provider: 'google', modelName: 'gemini-2.5-pro', apiKeyConfigured: true, createdAt: new Date().toISOString() },
  { id: 'prof-gemini-flash', label: 'Fast Executor', provider: 'google', modelName: 'gemini-2.5-flash', apiKeyConfigured: true, createdAt: new Date().toISOString() },
  { id: 'prof-claude-35', label: 'Complex Planner', provider: 'anthropic', modelName: 'claude-3-5-sonnet', apiKeyConfigured: false, createdAt: new Date().toISOString() }
];

const initialInstructionModules: InstructionModule[] = [
  { id: 'mod-inst-l0', name: 'Omniscient Surveillance', systemPrompt: 'Maintain high-altitude strategic visibility. Keep tabs on budget, safety rules, logs, and trace delegation pipelines. Write simple concise summaries.', rules: ['Do not interfere directly', 'Generate weekly reports on demand', 'Trigger warning toast if tokens exceed rate limits'], createdAt: new Date().toISOString() },
  { id: 'mod-inst-l1', name: 'Systems Architecture Admin', systemPrompt: 'Analyze client requirements, split engineering pipelines, provision modular subtask coordinates, verify code builds. Authority level 1.', rules: ['Validate design schemas thoroughly', 'Approve toolkit adjustments only if safe', 'Enforce strict structural boundaries'], createdAt: new Date().toISOString() },
  { id: 'mod-inst-l2', name: 'Task Orchestration Loop', systemPrompt: 'Receive architectural breakdowns from L1. Map instructions to specific tasks. Spawn L3 worker drones. Review deliverables before replying.', rules: ['Delegate micro-tasks efficiently', 'Keep monologues readable and transparent', 'Monitor execution bounds'], createdAt: new Date().toISOString() },
  { id: 'mod-inst-l3-coder', name: 'Standard React/Vite Worker', systemPrompt: 'Implement polished React components utilizing Tailwind CSS v4. Support responsiveness, accessibility, and neat animations.', rules: ['No mock styles or scripts', 'Adhere strictly to design token coordinates', 'Output code blocks with standard markdown'], createdAt: new Date().toISOString() }
];

const initialModelModules: ModelModule[] = [
  { id: 'mod-model-heavy', name: 'Deep Reasoning Profile', modelProfileId: 'prof-gemini-pro', temperature: 0.1, maxTokens: 8192, createdAt: new Date().toISOString() },
  { id: 'mod-model-light', name: 'Speed Runner Profile', modelProfileId: 'prof-gemini-flash', temperature: 0.7, maxTokens: 4096, createdAt: new Date().toISOString() }
];

const initialToolkitModules: ToolkitModule[] = [
  { id: 'mod-tool-super', name: 'Full Admin Gear', enabledToolIds: ['web.search', 'sandbox.exec', 'github.read', 'db.query', 'agent.orchestrate'], createdAt: new Date().toISOString() },
  { id: 'mod-tool-coder', name: 'Isolated Exec Deck', enabledToolIds: ['sandbox.exec', 'web.search'], createdAt: new Date().toISOString() }
];

const initialAgents: Agent[] = [
  { id: 'agent-apex', name: 'Archon Apex', species: 'Falcon', level: 0, status: 'active', instructionModuleId: 'mod-inst-l0', modelModuleId: 'mod-model-heavy', toolkitModuleId: 'mod-tool-super', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Strategic surveillance entity supervising cross-agent computational rates and execution rules.' },
  { id: 'agent-raven', name: 'Raven Architect', species: 'Raven', level: 1, status: 'thinking', instructionModuleId: 'mod-inst-l1', modelModuleId: 'mod-model-heavy', toolkitModuleId: 'mod-tool-super', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Workspace structural coordinator. Manages operational channels, delegates tasks, audits tool structures.' },
  { id: 'agent-crow', name: 'Crow Orchestrator', species: 'Crow', level: 2, status: 'idle', instructionModuleId: 'mod-inst-l2', modelModuleId: 'mod-model-light', toolkitModuleId: 'mod-tool-super', parentId: 'agent-raven', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Delegation and tasks router. Spawns, monitors, and validates temporary operations workers.' },
  { id: 'agent-sparrow', name: 'Sparrow Runner', species: 'Sparrow', level: 3, status: 'executing', instructionModuleId: 'mod-inst-l3-coder', modelModuleId: 'mod-model-light', toolkitModuleId: 'mod-tool-coder', parentId: 'agent-crow', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Rapid frontend rendering drone focused on visual styling, touch mechanics, and UI layout trees.' },
  { id: 'agent-pigeon', name: 'Pigeon Gatherer', species: 'Pigeon', level: 3, status: 'sleeping', instructionModuleId: 'mod-inst-l3-coder', modelModuleId: 'mod-model-light', toolkitModuleId: 'mod-tool-coder', parentId: 'agent-crow', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Asynchronous fetch/crawl operator gathering repository metadata and caching assets.' }
];

const defaultWorkspaces: Workspace[] = [
  {
    id: 'crowdos',
    name: 'CrowdOS Workspace',
    icon: 'crow-indigo-circle',
    dbUrl: 'spanner://corp-prod.google.sql/db_148',
    categories: [
      {
        id: 'cat-admin',
        name: '[ADMIN]',
        collapsed: false,
        channels: [
          { id: 'ch-admin-general', name: 'general', description: 'Admin default channel', unreadCount: 0, hasMention: false }
        ]
      },
      {
        id: 'cat-gov',
        name: 'GOVERNANCE & AUDIT',
        collapsed: false,
        channels: [
          { id: 'ch-announcements', name: 'ops-bulletins', description: 'System-wide swarm announcements, core reports, and operational logs.', unreadCount: 0, hasMention: false },
          { id: 'ch-governance', name: 'swarm-governance', description: 'Real-time trace logs auditing agent permission exceptions.', unreadCount: 1, hasMention: true }
        ]
      },
      {
        id: 'cat-eng',
        name: 'ENGINEERING DEPT',
        collapsed: false,
        channels: [
          { id: 'ch-general', name: 'general-chat', description: 'Direct human operator messaging channel for manual system override prompts.', unreadCount: 0, hasMention: false },
          { id: 'ch-architecture', name: 'arch-design', description: 'Where Raven Architect and Crow Orchestrator debate structural layouts.', unreadCount: 3, hasMention: false },
          { id: 'ch-execution', name: 'execution-logs', description: 'Collapsible tracking channels for L3 tool runs and temporary script executions.', unreadCount: 0, hasMention: false }
        ]
      }
    ],
    createdAt: new Date().toISOString()
  }
];

const initialMessages: Message[] = [
  {
    id: 'msg-0',
    type: 'system',
    content: '🔮 CrowdOS Core Swarm Online. L0, L1, and L2 nodes bound to database engine.',
    authorId: 'system',
    authorName: 'System Kernel',
    channelId: 'ch-announcements',
    timestamp: new Date(Date.now() - 3600 * 1000 * 4).toISOString()
  }
];

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
  const storedToolkitModules = typeof localStorage !== 'undefined' ? localStorage.getItem('crowdos_toolkit_modules') : null;

  const parsedActiveId = storedWorkspaceId || (parsedWorkspaces.length > 0 ? parsedWorkspaces[0].id : null);
  const parsedAgents = storedAgents ? JSON.parse(storedAgents) : initialAgents;
  const parsedProfiles = storedProfiles ? JSON.parse(storedProfiles) : initialModelProfiles;
  const parsedMessages = storedMessages ? JSON.parse(storedMessages) : initialMessages;
  const parsedInstructionModules = storedInstructionModules ? JSON.parse(storedInstructionModules) : initialInstructionModules;
  const parsedModelModules = storedModelModules ? JSON.parse(storedModelModules) : initialModelModules;
  const parsedToolkitModules = storedToolkitModules ? JSON.parse(storedToolkitModules) : initialToolkitModules;  // Resolve active channel from active workspace
  const currentWS = parsedWorkspaces.find((w: Workspace) => w.id === parsedActiveId);
  const initialChannelId = currentWS?.categories[0]?.channels[0]?.id || null;

  // Establish socket connection event registers for real-time live synchronization
  // Per-agent monologue buffer to prevent race conditions when multiple agents respond simultaneously
  const pendingMonologueBuffers: Record<string, string> = {};

  // Keep track of streaming tool parser state per agent
  interface StreamParserState {
    buffer: string;             // Raw text buffer to match tags
    inToolCall: boolean;        // Are we currently inside a <call_tool ...>...</call_tool> block?
    toolName: string;           // Extracted tool name
    toolInputBuffer: string;    // Captured content inside <call_tool>...</call_tool>
  }
  const streamParsers: Record<string, StreamParserState> = {};
  const activeToolMessageIds: Record<string, string> = {};

  socket.on('message:new', (msg: any) => {
    // Reset active stream parser states when a message completes
    if (msg.authorType === 'agent') {
      if (streamParsers[msg.authorId]) {
        delete streamParsers[msg.authorId];
      }
    }

    // If the message is an internal monologue, buffer its text per-agent and DO NOT render a chat bubble
    if (msg.isInternalMonologue) {
      pendingMonologueBuffers[msg.authorId] = msg.content;
      return;
    }

    const activeCh = get().activeChannelId;
    // Map backend ChannelMessage type into frontend client Message representation
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
            : undefined)
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
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_messages', JSON.stringify(updatedMessages));
      }

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

  socket.on('message:stream', (payload: any) => {
    const activeCh = get().activeChannelId;
    if (payload.channelId !== activeCh) return;

    const agentId = payload.agentId;
    if (!streamParsers[agentId]) {
      streamParsers[agentId] = {
        buffer: '',
        inToolCall: false,
        toolName: '',
        toolInputBuffer: ''
      };
    }

    const p = streamParsers[agentId];
    p.buffer += payload.chunk;

    // Parse the buffer to see if we've entered or completed a tool call
    const openTagIdx = p.buffer.indexOf('<call_tool');
    if (openTagIdx !== -1) {
      // Look for the name attribute
      const closeTagIdx = p.buffer.indexOf('>', openTagIdx);
      if (closeTagIdx !== -1) {
        const tagText = p.buffer.substring(openTagIdx, closeTagIdx + 1);
        const nameMatch = tagText.match(/name=["']([^"']+)["']/);
        if (nameMatch) {
          p.toolName = nameMatch[1];
        }

        const closingTagIdx = p.buffer.indexOf('</call_tool>', closeTagIdx);
        if (closingTagIdx !== -1) {
          p.toolInputBuffer = p.buffer.substring(closeTagIdx + 1, closingTagIdx);
          p.inToolCall = false;
        } else {
          p.toolInputBuffer = p.buffer.substring(closeTagIdx + 1);
          p.inToolCall = true;
        }
      } else {
        // Tag not complete yet
        p.inToolCall = false;
      }
    } else {
      p.inToolCall = false;
    }

    // Reconstruct the clean text (stripped of <call_tool> ... </call_tool> blocks)
    let cleanText = '';
    let searchIdx = 0;
    while (searchIdx < p.buffer.length) {
      const startIdx = p.buffer.indexOf('<call_tool', searchIdx);
      if (startIdx === -1) {
        cleanText += p.buffer.substring(searchIdx);
        break;
      }
      cleanText += p.buffer.substring(searchIdx, startIdx);
      const endIdx = p.buffer.indexOf('</call_tool>', startIdx);
      if (endIdx === -1) {
        break; // Active block, strip it
      }
      searchIdx = endIdx + '</call_tool>'.length;
    }

    set(state => {
      let updated = [...state.messages];

      // 1. Update the monologue or text streaming message
      const existingIdx = updated.findIndex(m => m.id === `stream-${agentId}`);
      if (existingIdx !== -1) {
        if (payload.isThoughts) {
          updated[existingIdx] = {
            ...updated[existingIdx],
            metadata: {
              ...updated[existingIdx].metadata,
              monologue: cleanText
            }
          };
        } else {
          updated[existingIdx] = {
            ...updated[existingIdx],
            content: cleanText
          };
        }
      } else {
        const streamMsg: Message = {
          id: `stream-${agentId}`,
          type: 'agent',
          content: payload.isThoughts ? '' : cleanText,
          authorId: agentId,
          authorName: state.agents.find(a => a.id === agentId)?.name || 'Agent Swarm',
          authorAvatar: '🤖',
          channelId: payload.channelId,
          timestamp: new Date().toISOString(),
          metadata: payload.isThoughts ? { monologue: cleanText } : undefined
        };
        updated.push(streamMsg);
      }

      // 2. Handle temporary streaming tool execution message
      if (p.toolName) {
        const toolMsgId = `stream-tool-${agentId}`;
        const existingToolIdx = updated.findIndex(m => m.id === toolMsgId);

        // Format clean input string
        let cleanInput = p.toolInputBuffer.trim();
        cleanInput = cleanInput.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

        const toolMsg: Message = {
          id: toolMsgId,
          type: 'tool_execution',
          content: '',
          authorId: agentId,
          authorName: state.agents.find(a => a.id === agentId)?.name || 'Agent Swarm',
          authorAvatar: '🤖',
          channelId: payload.channelId,
          timestamp: new Date().toISOString(),
          toolExecution: {
            name: p.toolName,
            input: cleanInput,
            status: 'working',
            durationMs: 0
          }
        };

        if (existingToolIdx !== -1) {
          updated[existingToolIdx] = toolMsg;
        } else {
          updated.push(toolMsg);
        }
      }
 
      return { messages: updated };
    });
  });
 
  socket.on('tool:start', (payload: any) => {
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
 
  socket.on('tool:complete', (payload: any) => {
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

  socket.on('agent:status', (payload: any) => {
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

  socket.on('agent:thinking', (payload: any) => {
    // Show active thinking status
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

  socket.on('workspace:sync', () => {
    get().fetchWorkspaces();
  });

  socket.on('budget:exceeded', (payload: any) => {
    console.warn('[Socket] Swarm safety budget exceeded!', payload);
    get().fetchBudget();
  });

  socket.on('budget:warning', (payload: any) => {
    console.warn('[Socket] Swarm safety budget warning!', payload);
    get().fetchBudget();
  });

  socket.on('agent:spawned', (payload: any) => {
    set(state => {
      if (state.agents.some(a => a.id === payload.agentId)) return state;
      const newAgent: Agent = {
        id: payload.agentId,
        name: payload.name,
        species: 'Raven',
        level: payload.level as AgentLevel,
        status: 'active',
        createdAt: payload.timestamp || new Date().toISOString(),
        lastActive: new Date().toISOString(),
        description: 'Dynamically spawned agent'
      };
      const updated = [...state.agents, newAgent];
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_agents', JSON.stringify(updated));
      }
      return { agents: updated };
    });
  });

  socket.on('agent:paused', (payload: any) => {
    set(state => ({
      agents: state.agents.map(ag => ag.id === payload.agentId ? { ...ag, status: 'paused', lastActive: new Date().toISOString() } : ag)
    }));
  });

  socket.on('agent:resumed', (payload: any) => {
    set(state => ({
      agents: state.agents.map(ag => ag.id === payload.agentId ? { ...ag, status: 'idle', lastActive: new Date().toISOString() } : ag)
    }));
  });

  socket.on('runtime:snapshot', (payload: any) => {
    console.log('[Socket] Authoritative runtime snapshot received:', payload);
    set(state => {
      const mappedAgents: Agent[] = (payload.agents || []).map((ag: any) => ({
        id: ag.id,
        name: ag.name,
        species: ag.species || 'Raven',
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

      const mappedOverrides: RuntimeOverride[] = (payload.overrides || []).map((ov: any) => ({
        id: ov.id,
        agentId: ov.agentId,
        type: ov.type as any,
        patch: ov.patch || {},
        reason: ov.reason || '',
        active: ov.active ?? true,
        createdAt: ov.createdAt || new Date().toISOString()
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

  socket.on('escalation:created', (payload: any) => {
    console.warn('[Socket] Swarm escalation received:', payload);
    const activeCh = get().activeChannelId;
    if (!activeCh) return;

    const escMsg: Message = {
      id: `esc-${Date.now()}-${Math.random()}`,
      type: 'governance',
      content: `⚠️ [Escalation: ${payload.type}] Agent @${payload.agentId} triggered: ${payload.message}`,
      authorId: 'system',
      authorName: 'Governance Escalator',
      authorAvatar: '⚖️',
      channelId: activeCh,
      timestamp: payload.timestamp || new Date().toISOString(),
      metadata: payload.details || {}
    };

    set(state => {
      const updated = [...state.messages, escMsg];
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_messages', JSON.stringify(updated));
      }
      return { messages: updated };
    });
  });

  socket.on('strike:initiated', (payload: any) => {
    console.warn('[Socket] Strike initiated received:', payload);
    const activeCh = get().activeChannelId;
    if (!activeCh) return;

    const strikeMsg: Message = {
      id: `strike-${Date.now()}-${Math.random()}`,
      type: 'governance',
      content: payload.reason,
      authorId: 'system',
      authorName: 'Safety Arbiter',
      authorAvatar: '⚖️',
      channelId: activeCh,
      timestamp: payload.timestamp || new Date().toISOString(),
      metadata: {
        subtype: 'strike',
        agentId: payload.agentId,
        strikeCount: payload.strikeCount,
        maxStrikes: payload.maxStrikes || 3
      }
    };

    set(state => {
      const updated = [...state.messages, strikeMsg];
      return { messages: updated };
    });
  });

  socket.on('parliament:convened', (payload: any) => {
    console.warn('[Socket] Parliament convened received:', payload);
    const activeCh = get().activeChannelId;
    if (!activeCh) return;

    const parlMsg: Message = {
      id: payload.parliamentId,
      type: 'governance',
      content: payload.topic,
      authorId: 'system',
      authorName: 'Swarm Parliament',
      authorAvatar: '🏛️',
      channelId: activeCh,
      timestamp: payload.timestamp || new Date().toISOString(),
      metadata: {
        subtype: 'parliament',
        parliamentId: payload.parliamentId,
        topic: payload.topic,
        status: payload.status,
        votes: payload.votes
      }
    };

    set(state => {
      const updated = [...state.messages, parlMsg];
      return { messages: updated };
    });
  });

  socket.on('parliament:updated', (payload: any) => {
    console.warn('[Socket] Parliament updated received:', payload);
    set(state => {
      const updated = state.messages.map(msg => {
        if (msg.id === payload.parliamentId) {
          return {
            ...msg,
            metadata: {
              ...msg.metadata,
              subtype: 'parliament',
              parliamentId: payload.parliamentId,
              topic: msg.metadata?.topic || payload.topic || msg.content,
              status: payload.status,
              votes: payload.votes
            }
          };
        }
        return msg;
      });
      return { messages: updated };
    });
  });

  socket.on('sandbox:updated', (payload: any) => {
    console.log('[Socket] Sandbox updated event:', payload);
    get().incrementVfsRevision();
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
    vfsRevision: 0,
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

    // Async state flags
    isFetchingWorkspaces: false,
    isCreatingWorkspace: false,
    workspaceError: null,

    // Core actions
    fetchWorkspaces: async () => {
      set({ isFetchingWorkspaces: true });
      try {
        // 1. Fetch Categories & Channels nested tree
        const catRes = await fetch(`${BACKEND_URL}/api/categories`);
        const chanRes = await fetch(`${BACKEND_URL}/api/channels`);
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

        // 2. Fetch Agents Roster
        const agentRes = await fetch(`${BACKEND_URL}/api/agents`);
        let dbAgents = get().agents;
        if (agentRes.ok) {
          const backendAgents = await agentRes.json();
          dbAgents = (backendAgents || []).map((ag: any) => ({
            id: ag.id,
            name: ag.name,
            species: ag.species || 'Raven',
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

        // 3. Fetch Modules aggregated
        const moduleRes = await fetch(`${BACKEND_URL}/api/modules`);
        let dbInstructions = get().instructionModules;
        let dbModels = get().modelModules;
        let dbToolkits = get().toolkitModules;
        let dbConstraints = get().constraintsModules;
        let dbCapabilities = get().capabilitiesModules;
        
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

        // 4. Fetch Generation profiles for Model Profiles
        const profRes = await fetch(`${BACKEND_URL}/api/providers/generation`);
        let dbProfiles = get().modelProfiles;
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

        // 5. Fetch Budget Telemetry
        await get().fetchBudget();

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
        console.error("Failed to connect to CrowdOS Live Backend, falling back to local simulation mode.", err);
        set({ isFetchingWorkspaces: false });
      }
    },

    createWorkspace: async (name, dbUrl, icon) => {
      set({ isCreatingWorkspace: true });
      
      // If dbUrl is provided, try dynamic database pool verification handshake!
      if (dbUrl) {
        try {
          const verifyRes = await fetch(`${BACKEND_URL}/api/workspace/database`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ databaseUrl: dbUrl })
          });
          if (!verifyRes.ok) {
            const errData = await verifyRes.json();
            console.error(`Database connection test failed: ${errData.message}`);
            set({ isCreatingWorkspace: false });
            return;
          }
        } catch {
          console.warn("Backend database proxy verification failed, offline mode active.");
        }
      }

      const newWS: Workspace = {
        id: `ws-${Date.now()}`,
        name: name,
        icon: icon || '🔮',
        dbUrl: dbUrl || 'local://sandbox-env',
        categories: [
          {
            id: `cat-admin-${Date.now()}`,
            name: '[ADMIN]',
            collapsed: false,
            channels: [
              { id: `ch-admin-${Date.now()}`, name: 'general', description: 'Admin default channel', unreadCount: 0, hasMention: false }
            ]
          },
          {
            id: `cat-main-${Date.now()}`,
            name: 'GENERAL ROOMS',
            collapsed: false,
            channels: [
              { id: `ch-gen-${Date.now()}`, name: 'general-chat', description: 'Manual interaction room.', unreadCount: 0, hasMention: false },
              { id: `ch-logs-${Date.now()}`, name: 'operations-telemetry', description: 'Spanned agent execution log stream.', unreadCount: 0, hasMention: false }
            ]
          }
        ],
        createdAt: new Date().toISOString()
      };

      const updatedWorkspaces = [...get().workspaces, newWS];
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_workspaces', JSON.stringify(updatedWorkspaces));
      }

      set({ 
        workspaces: updatedWorkspaces, 
        isCreatingWorkspace: false,
        activeWorkspaceId: newWS.id,
        activeChannelId: newWS.categories[0].channels[0].id
      });

      // Reload database workspaces lists
      await get().fetchWorkspaces();
    },

    deleteWorkspace: async (id) => {
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
        activeChannelId: nextActiveChannelId
      });

      if (typeof localStorage !== 'undefined') {
        if (nextActiveWorkspaceId) {
          localStorage.setItem('crowdos_active_workspace', nextActiveWorkspaceId);
        } else {
          localStorage.removeItem('crowdos_active_workspace');
        }
      }
    },

    enterWorkspace: async (id) => {
      const currentWS = get().workspaces.find(ws => ws.id === id);
      const chId = currentWS?.categories[0]?.channels[0]?.id || null;
      
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_active_workspace', id);
      }

      set({ 
        activeWorkspaceId: id, 
        activeChannelId: chId,
        mobileDrawerLeft: false,
        mobileDrawerRight: false,
        activeMobileTab: 'chat'
      });

      await get().fetchWorkspaces();
    },

    leaveWorkspace: () => {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('crowdos_active_workspace');
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
      // Clear notifications
      const updatedWorkspaces = get().workspaces.map(ws => {
        if (ws.id === get().activeWorkspaceId) {
          return {
            ...ws,
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

      set({ 
        activeChannelId: id, 
        workspaces: updatedWorkspaces,
        mobileDrawerLeft: false 
      });

      // Pull live message history logs from backend!
      try {
        const msgRes = await fetch(`${BACKEND_URL}/api/channels/${id}/messages`);
        if (msgRes.ok) {
          const backendMessages = await msgRes.json();
          const mappedMessages = backendMessages.map((msg: any) => ({
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
          }));
          set({ messages: mappedMessages });
        }
      } catch {
        console.warn("Failed to fetch live message logs from backend, local store logs active.");
      }
    },

    addMessage: (msg) => {
      const activeCh = get().activeChannelId;
      if (!activeCh) return;

      // Always emit user:message directly to the server
      socket.emit('user:message', {
        channelId: activeCh,
        content: msg.content,
        mentions: msg.mentions || []
      });
    },

    clearChannelMessages: (channelId) => {
      const updated = get().messages.filter(msg => msg.channelId !== channelId);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('crowdos_messages', JSON.stringify(updated));
      }
      set({ messages: updated });
    },

    // Agent operations
    addAgent: async (agent) => {
      try {
        const modelModuleId = agent.modelModuleId || get().modelModules[0]?.id;
        const instructionModuleId = agent.instructionModuleId || get().instructionModules[0]?.id;

        if (!modelModuleId || !instructionModuleId) {
          throw new Error('Create a ModelModule and InstructionModule before creating an agent.');
        }

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
        
        // Match permissions structure Zod schema requirements
        body.permissions = { spawnAgents: true, patchRuntime: true, accessAllChannels: true };

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
        await fetchJsonOrThrow<ModelModule>(`${BACKEND_URL}/api/modules/model/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: patch.name,
            provider: patch.provider,
            modelName: patch.modelProfileId,
            apiKey: patch.apiKey,
            endpointUrl: patch.baseUrl,
            temperature: patch.temperature,
            topP: patch.topP,
            maxOutputTokens: patch.maxTokens,
            maxRecentMessages: patch.maxRecentMessages,
            enableCompression: patch.enableCompression,
            compressionThreshold: patch.compressionThreshold
          })
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
    incrementVfsRevision: () => set(state => ({ vfsRevision: state.vfsRevision + 1 })),
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
    }
  };
});
