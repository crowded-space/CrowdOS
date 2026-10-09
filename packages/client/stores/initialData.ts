import type { Tool, Role, ModelProfile, InstructionModule, ModelModule, ToolkitModule, Agent, Workspace, Message } from '../types/crowdOs';

// UX-8 decomposition: initial demo data extracted so the core store stays focused on state logic.
// When DEMO_FALLBACK is off, the store will ignore this data on backend failure (honest mode).

export const initialTools: Tool[] = [
  { id: 'web.search', name: 'Web Search', category: 'Intelligence', description: 'Search and scrape live web pages for up-to-date context.', enabled: true },
  { id: 'sandbox.exec', name: 'Sandbox Code Exec', category: 'Computing', description: 'Run Python/TS files in an isolated micro-sandbox.', enabled: true },
  { id: 'github.read', name: 'Repo Reader', category: 'VCS', description: 'Inspect structure, branches, and code files of git repositories.', enabled: true },
  { id: 'db.query', name: 'Spanner Proxy', category: 'Database', description: 'Query the underlying high-performance transactional database.', enabled: false },
  { id: 'agent.orchestrate', name: 'Sub-Agent Spawn', category: 'Swarm', description: 'Dynamically instantiate and patch temporary L3 agents.', enabled: true }
];

export const initialRoles: Role[] = [
  { id: 'role-l0', name: 'L0 Omniscient Monitor', color: 'oklch(0.75 0.12 180)', permissions: ['all'] },
  { id: 'role-l1', name: 'L1 Executive Administrator', color: 'oklch(0.65 0.15 25)', permissions: ['spawn_agents', 'patch_runtime', 'manage_budgets', 'kill_switch'] },
  { id: 'role-l2', name: 'L2 Operation Coordinator', color: 'oklch(0.62 0.15 250)', permissions: ['task_assign', 'tool_invoke', 'patch_temporary'] },
  { id: 'role-l3', name: 'L3 Autonomic Worker', color: 'oklch(0.60 0.12 145)', permissions: ['tool_invoke', 'sandbox_exec'] }
];

export const initialModelProfiles: ModelProfile[] = [];

export const initialInstructionModules: InstructionModule[] = [
  { id: 'mod-inst-l0', name: 'Omniscient Surveillance', systemPrompt: 'Maintain high-altitude strategic visibility. Keep tabs on budget, safety rules, logs, and trace delegation pipelines. Write simple concise summaries.', rules: ['Do not interfere directly', 'Generate weekly reports on demand', 'Trigger warning toast if tokens exceed rate limits'], createdAt: new Date().toISOString() },
  { id: 'mod-inst-l1', name: 'Systems Architecture Admin', systemPrompt: 'Analyze client requirements, split engineering pipelines, provision modular subtask coordinates, verify code builds. Authority level 1.', rules: ['Validate design schemas thoroughly', 'Approve toolkit adjustments only if safe', 'Enforce strict structural boundaries'], createdAt: new Date().toISOString() },
  { id: 'mod-inst-l2', name: 'Task Orchestration Loop', systemPrompt: 'Receive architectural breakdowns from L1. Map instructions to specific tasks. Spawn L3 worker drones. Review deliverables before replying.', rules: ['Delegate micro-tasks efficiently', 'Keep monologues readable and transparent', 'Monitor execution bounds'], createdAt: new Date().toISOString() },
  { id: 'mod-inst-l3-coder', name: 'Standard React/Vite Worker', systemPrompt: 'Implement polished React components utilizing Tailwind CSS v4. Support responsiveness, accessibility, and neat animations.', rules: ['No mock styles or scripts', 'Adhere strictly to design token coordinates', 'Output code blocks with standard markdown'], createdAt: new Date().toISOString() }
];

export const initialModelModules: ModelModule[] = [];

export const initialToolkitModules: ToolkitModule[] = [
  { id: 'mod-tool-super', name: 'Full Admin Gear', enabledToolIds: ['web.search', 'sandbox.exec', 'github.read', 'db.query', 'agent.orchestrate'], createdAt: new Date().toISOString() },
  { id: 'mod-tool-coder', name: 'Isolated Exec Deck', enabledToolIds: ['sandbox.exec', 'web.search'], createdAt: new Date().toISOString() }
];

export const initialAgents: Agent[] = [
  { id: 'agent-apex', name: 'Archon Apex', species: 'Falcon', level: 0, status: 'idle', instructionModuleId: 'mod-inst-l0', modelModuleId: 'mod-model-heavy', toolkitModuleId: 'mod-tool-super', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Strategic surveillance entity supervising cross-agent computational rates and execution rules.' },
  { id: 'agent-raven', name: 'Raven Architect', species: 'Raven', level: 1, status: 'idle', instructionModuleId: 'mod-inst-l1', modelModuleId: 'mod-model-heavy', toolkitModuleId: 'mod-tool-super', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Workspace structural coordinator. Manages operational channels, delegates tasks, audits tool structures.' },
  { id: 'agent-crow', name: 'Crow Orchestrator', species: 'Crow', level: 2, status: 'idle', instructionModuleId: 'mod-inst-l2', modelModuleId: 'mod-model-light', toolkitModuleId: 'mod-tool-super', parentId: 'agent-raven', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Delegation and tasks router. Spawns, monitors, and validates temporary operations workers.' },
  { id: 'agent-sparrow', name: 'Sparrow Runner', species: 'Sparrow', level: 3, status: 'idle', instructionModuleId: 'mod-inst-l3-coder', modelModuleId: 'mod-model-light', toolkitModuleId: 'mod-tool-coder', parentId: 'agent-crow', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Rapid frontend rendering drone focused on visual styling, touch mechanics, and UI layout trees.' },
  { id: 'agent-pigeon', name: 'Pigeon Gatherer', species: 'Pigeon', level: 3, status: 'idle', instructionModuleId: 'mod-inst-l3-coder', modelModuleId: 'mod-model-light', toolkitModuleId: 'mod-tool-coder', parentId: 'agent-crow', createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), description: 'Asynchronous fetch/crawl operator gathering repository metadata and caching assets.' }
];

export const defaultWorkspaces: Workspace[] = [
  {
    id: 'crowdos',
    name: 'CrowdOS Workspace',
    icon: 'crow-indigo-circle',
    // Demo seed: no database behind it. A fake URL here would imply a live
    // connection the demo never had.
    dbUrl: '',
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
          { id: 'ch-governance', name: 'swarm-governance', description: 'Real-time trace logs auditing agent permission exceptions.', unreadCount: 0, hasMention: false }
        ]
      },
      {
        id: 'cat-eng',
        name: 'ENGINEERING DEPT',
        collapsed: false,
        channels: [
          { id: 'ch-general', name: 'general-chat', description: 'Direct human operator messaging channel for manual system override prompts.', unreadCount: 0, hasMention: false },
          { id: 'ch-architecture', name: 'arch-design', description: 'Where Raven Architect and Crow Orchestrator debate structural layouts.', unreadCount: 0, hasMention: false },
          { id: 'ch-execution', name: 'execution-logs', description: 'Collapsible tracking channels for L3 tool runs and temporary script executions.', unreadCount: 0, hasMention: false }
        ]
      }
    ],
    createdAt: new Date().toISOString()
  }
];

export const initialMessages: Message[] = [
  {
    id: 'msg-0',
    type: 'system',
    // Demo seed only: marks the demo transcript as demo content instead of
    // claiming live nodes bound to a database engine that was never connected.
    content: 'Demo workspace preview — no live agents are running here.',
    authorId: 'system',
    authorName: 'System Kernel',
    channelId: 'ch-announcements',
    timestamp: new Date(Date.now() - 3600 * 1000 * 4).toISOString()
  }
];
