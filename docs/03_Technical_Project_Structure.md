# 🏗️ CrowdOS — Technical Project Structure

> **Status:** 📋 Updated — CrowdOS Modular Architecture
> **Last Updated:** 2026-05-20
> **Source:** CrowdOS Cognitive Agent Specs Bundle + existing docs/

---

## 1. High-Level Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Frontend (Vite + React + TS)                    │
│  ┌───────────────┐  ┌───────────────────┐  ┌───────────────────┐    │
│  │ Discord-like  │  │  Socket.io Client │  │  REST API Client  │    │
│  │     UI        │  │  (Real-time)      │  │  (CRUD)           │    │
│  └──────┬────────┘  └─────────┬─────────┘  └─────────┬─────────┘    │
└─────────┼─────────────────────┼───────────────────────┼─────────────┘
          │ WebSocket           │                       │ HTTP
┌─────────┼─────────────────────┼───────────────────────┼─────────────┐
│         ▼                     ▼                       ▼             │
│  ┌───────────────┐  ┌───────────────────┐  ┌───────────────────┐    │
│  │ Socket.io     │  │   EventBroker     │  │   REST API        │    │
│  │ Server        │◄─┤  (EventEmitter)   │◄─┤   Layer           │    │
│  └───────────────┘  └─────────┬─────────┘  └───────────────────┘    │
│                               │                                      │
│         ┌─────────────────────┼──────────────────────┐               │
│         ▼                     ▼                      ▼               │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────┐         │
│  │  Modules    │  │   Agent        │  │   Runtime          │         │
│  │  Registry   │  │   Registry     │  │   Engine           │         │
│  │  (5 types)  │  │   (Identity)   │  │   + Overrides      │         │
│  └─────────────┘  └────────────────┘  └───────────────────┘         │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────┐         │
│  │   Spawn     │  │   Router /     │  │   Memory          │         │
│  │   Manager   │  │   Dispatcher   │  │   Builder         │         │
│  └─────────────┘  └────────────────┘  └───────────────────┘         │
│  ┌─────────────┐  ┌────────────────┐  ┌───────────────────┐         │
│  │  Channel    │  │  Token Tracker │  │  Index Builder    │         │
│  │  Controller │  │  Loop Arbiter  │  │  Scheduler        │         │
│  └─────────────┘  └────────────────┘  └───────────────────┘         │
│          ┌────────────────────┬──────────────────────┐               │
│          ▼                    ▼                      ▼               │
│  ┌──────────────┐  ┌───────────────────┐                             │
│  │ Tool         │  │  LLM Adapters     │                             │
│  │ Executor     │  │  (Agnostic)       │                             │
│  └──────┬───────┘  └───────────────────┘                             │
│         │           Backend (Node.js + TS)                           │
│         ▼                                                            │
│  ┌──────────────┐                                                    │
│  │ Tool         │                                                    │
│  │ Registry     │                                                    │
│  └──────────────┘                                                    │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                  ┌────────▼─────────┐
                  │   PostgreSQL     │
                  │   + pgvector     │
                  └──────────────────┘
```

---

## 2. Monorepo Directory Layout

```
.ThisCrowd/
├── .user idea/                           # ✅ User's original CrowdOS specs (source of truth)
│   └── crowdos_cognitive_agent_specs_bundle.md
│
├── docs/                                 # ✅ Design documents (updated for CrowdOS)
│   ├── 01_Project_Guideline_LV0_Vision.md
│   ├── 02_Project_Guideline_LV1_Architecture.md
│   ├── 03_Technical_Project_Structure.md     ◄── Dokumen ini
│   ├── LV2_Agent_Creation_UI.md
│   ├── LV2_Agent_Lifecycle_Engine.md
│   ├── LV2_Channel_Workspace_Routing.md
│   ├── LV2_Error_Handling_Recovery.md
│   ├── LV2_L3_Spawn_Protocol.md
│   ├── LV2_Mention_System.md
│   ├── LV2_Memory_and_Context.md
│   ├── LV2_Prompt_Assembly.md
│   ├── LV2_Router_Dispatch_Logic.md
│   ├── LV2_Testing_Strategy.md
│   ├── LV2_Tool_and_Scheduling.md
│   └── LV2_Workspace_Settings_Providers.md
│
├── packages/
│   ├── server/                            # Backend (Node.js + TypeScript)
│   │   ├── src/
│   │   │   ├── index.ts                   # Entry: HTTP server + Socket.io bootstrap
│   │   │   ├── config/
│   │   │   │   ├── env.ts                 # Environment variable loader
│   │   │   │   └── database.ts            # PostgreSQL connection + auto schema push
│   │   │   │
│   │   │   ├── modules/                   # 🧩 Cognitive Module System (CrowdOS)
│   │   │   │   ├── ModuleRegistry.ts      # Central module CRUD registry
│   │   │   │   ├── model.module.ts        # ModelModule CRUD
│   │   │   │   ├── instruction.module.ts  # InstructionModule CRUD
│   │   │   │   ├── toolkit.module.ts      # ToolkitModule CRUD
│   │   │   │   ├── constraints.module.ts  # ConstraintsModule CRUD
│   │   │   │   └── capabilities.module.ts # CapabilitiesModule CRUD
│   │   │   │
│   │   │   ├── core/                      # 🧠 Core Engine modules
│   │   │   │   ├── EventBroker.ts         # Decoupled Event Bus (EventEmitter wrapper)
│   │   │   │   ├── AgentRegistry.ts       # Agent List Office — CRUD agent identities
│   │   │   │   ├── RuntimeEngine.ts       # Runtime orchestration + override engine
│   │   │   │   ├── AgentSpawnManager.ts   # L3 pair lifecycle (spawn/batch/cleanup)
│   │   │   │   ├── Router.ts              # Bipolar L1 Dispatcher (decompose + route)
│   │   │   │   ├── ChannelController.ts   # Category/Channel CRUD, visibility, scoping
│   │   │   │   ├── MemoryBuilder.ts       # Dual-memory prompt assembler (XML + tiers)
│   │   │   │   ├── LoopArbiter.ts         # Turn-limit, similarity detect, escalation
│   │   │   │   ├── Scheduler.ts           # CRON / delayed message queue (node-cron)
│   │   │   │   ├── TokenTracker.ts        # Budget tracking, soft cap, usage reporting
│   │   │   │   └── IndexBuilder.ts        # L0 channel topic indexing (periodic CRON)
│   │   │   │
│   │   │   ├── agents/                    # Agent runtime logic
│   │   │   │   ├── BaseAgent.ts           # Abstract agent class
│   │   │   │   ├── L1Agent.ts             # CEO / Lead — Bipolar CoT, always standby
│   │   │   │   ├── L2Agent.ts             # Manager — idle→active, dual chatroom
│   │   │   │   ├── L3Worker.ts            # Stateless executor (template-spawned)
│   │   │   │   └── L3Supervisor.ts        # Stateful evaluator (task diffing, QA)
│   │   │   │
│   │   │   ├── adapters/                  # 🔌 LLM Provider Adapters
│   │   │   │   ├── IModelAdapter.ts       # Agnostic interface (generate/stream/embed)
│   │   │   │   ├── GeminiAdapter.ts
│   │   │   │   ├── OpenAIAdapter.ts
│   │   │   │   ├── AnthropicAdapter.ts
│   │   │   │   └── OllamaAdapter.ts
│   │   │   │
│   │   │   ├── tools/                     # 🔧 Agent Tool Functions
│   │   │   │   ├── registry.ts            # Tool registry (all definitions)
│   │   │   │   ├── executor.ts            # Tool executor (auth + safety + run)
│   │   │   │   ├── definitions/
│   │   │   │   │   ├── filesystem.ts      # Read/Write/List/Delete file
│   │   │   │   │   ├── bash.ts            # Execute command (+ safe variant)
│   │   │   │   │   ├── webSearch.ts       # Web search
│   │   │   │   │   ├── database.ts        # Query/Mutate DB
│   │   │   │   │   ├── agentDispatch.ts   # Bipolar dispatch, spawn pairs
│   │   │   │   │   ├── agentRegistry.ts   # Read agent registry
│   │   │   │   │   ├── runtimeOverride.ts # Apply/patch runtime overrides
│   │   │   │   │   ├── workspace.ts       # Create category/channel
│   │   │   │   │   ├── scheduler.ts       # Register CRON tasks
│   │   │   │   │   └── omniscient.ts      # L0 search_all_channels
│   │   │   │   └── safety/
│   │   │   │       ├── blacklist.ts       # Dangerous command blacklist
│   │   │   │       ├── whitelist.ts       # Safe command whitelist
│   │   │   │       └── pathGuard.ts       # Working directory restriction
│   │   │   │
│   │   │   ├── routes/                    # REST API endpoints
│   │   │   │   ├── agents.routes.ts       # CRUD /api/agents/*
│   │   │   │   ├── modules.routes.ts      # CRUD /api/modules/* (5 types)
│   │   │   │   ├── categories.routes.ts   # CRUD /api/categories/*
│   │   │   │   ├── channels.routes.ts     # CRUD /api/channels/*
│   │   │   │   ├── messages.routes.ts     # /api/messages/*
│   │   │   │   ├── runtime.routes.ts      # /api/runtime/overrides + states
│   │   │   │   ├── providers.routes.ts    # CRUD /api/providers/* (legacy alias)
│   │   │   │   ├── templates.routes.ts    # Agent preset/template CRUD
│   │   │   │   └── workspace.routes.ts    # /api/workspace/settings + budget
│   │   │   │
│   │   │   ├── sockets/                   # Socket.io event handlers
│   │   │   │   ├── index.ts               # Socket namespace setup
│   │   │   │   ├── chat.socket.ts         # Real-time message streaming
│   │   │   │   └── status.socket.ts       # Agent status dot broadcasts
│   │   │   │
│   │   │   ├── db/                        # Database layer (PostgreSQL)
│   │   │   │   ├── schema.ts             # Drizzle ORM table definitions
│   │   │   │   ├── migrations/
│   │   │   │   └── seed.ts               # Built-in presets seeding
│   │   │   │
│   │   │   └── types/                     # Shared TypeScript types
│   │   │       ├── agent.types.ts
│   │   │       ├── module.types.ts        # NEW: 5 module types
│   │   │       ├── runtime.types.ts       # NEW: RuntimeOverride + RuntimeState
│   │   │       ├── channel.types.ts
│   │   │       ├── event.types.ts
│   │   │       ├── message.types.ts
│   │   │       ├── provider.types.ts
│   │   │       ├── mention.types.ts
│   │   │       ├── task.types.ts
│   │   │       └── tool.types.ts
│   │   │
│   │   ├── tests/                         # Test files
│   │   │   ├── unit/
│   │   │   ├── integration/
│   │   │   └── mocks/
│   │   │       └── MockModelAdapter.ts
│   │   │
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── client/                            # Frontend (Vite + React + TS)
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── index.css
│       │   │
│       │   ├── components/
│       │   │   ├── layout/
│       │   │   │   ├── Sidebar.tsx             # Category/Channel tree navigation
│       │   │   │   ├── MemberList.tsx           # Agent list + status dots
│       │   │   │   ├── Header.tsx
│       │   │   │   └── MainLayout.tsx
│       │   │   ├── chat/
│       │   │   │   ├── ChatWindow.tsx           # Message feed (per channel)
│       │   │   │   ├── MessageBubble.tsx         # Message + mention highlighting
│       │   │   │   ├── InputBar.tsx              # Input + @mention autocomplete
│       │   │   │   ├── MentionDropdown.tsx       # Autocomplete popup
│       │   │   │   ├── TaskFileAttachment.tsx    # Task file viewer in chat
│       │   │   │   └── StatusDot.tsx             # 🟢🟡🌑 indicator
│       │   │   ├── agents/
│       │   │   │   ├── AgentCard.tsx             # Agent identity card
│       │   │   │   ├── AgentEditor.tsx           # Create/edit form (module composition)
│       │   │   │   ├── ModuleSelector.tsx        # NEW: Module picker for 5 types
│       │   │   │   ├── ToolSelector.tsx          # Checkbox tool permissions
│       │   │   │   └── PresetSelector.tsx        # Template picker
│       │   │   ├── modules/
│       │   │   │   ├── ModelModuleForm.tsx       # NEW: Model module CRUD
│       │   │   │   ├── InstructionModuleForm.tsx # NEW: Instruction module CRUD
│       │   │   │   ├── ToolkitModuleForm.tsx     # NEW: Toolkit module CRUD
│       │   │   │   ├── ConstraintsModuleForm.tsx # NEW: Constraints module CRUD
│       │   │   │   └── CapabilitiesModuleForm.tsx# NEW: Capabilities module CRUD
│       │   │   └── settings/
│       │   │       ├── GenerationModelForm.tsx   # Generation model profile
│       │   │       ├── EmbeddingModelForm.tsx    # Embedding model profile
│       │   │       ├── IndexingModelForm.tsx     # Indexing model profile
│       │   │       ├── DatabaseForm.tsx          # DATABASE_URL input
│       │   │       ├── BudgetMonitor.tsx         # Token usage bars + budgeting
│       │   │       └── WorkspaceSettings.tsx     # Settings container
│       │   │
│       │   ├── pages/
│       │   │   ├── ChannelPage.tsx
│       │   │   ├── AgentOfficePage.tsx
│       │   │   ├── ModuleWorkshopPage.tsx        # NEW: Module management page
│       │   │   └── SettingsPage.tsx
│       │   │
│       │   ├── hooks/
│       │   │   ├── useSocket.ts
│       │   │   ├── useAgents.ts
│       │   │   ├── useModules.ts                 # NEW: Module hooks
│       │   │   ├── useChannels.ts
│       │   │   └── useMention.ts
│       │   │
│       │   ├── services/
│       │   │   ├── api.ts
│       │   │   └── socket.ts
│       │   │
│       │   ├── stores/                           # Zustand (Socket-first sync)
│       │   │   ├── agentStore.ts
│       │   │   ├── moduleStore.ts                # NEW: Module store
│       │   │   ├── runtimeStore.ts               # NEW: Runtime overrides store
│       │   │   ├── channelStore.ts
│       │   │   ├── providerStore.ts
│       │   │   └── uiStore.ts
│       │   │
│       │   └── types/
│       │       └── index.ts
│       │
│       ├── tests/
│       │   └── e2e/
│       ├── public/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── tailwind.config.ts
│
├── package.json                               # Root npm workspaces
├── tsconfig.base.json
├── .env.example
├── .gitignore
├── README.md
└── AGENTS.md
```

---

## 3. Core TypeScript Interfaces

### 3.1 Agent Profile (Identity-Only)

```typescript
type AuthorityLevel = 0 | 1 | 2 | 3;
type AgentStatus = 'active' | 'idle' | 'offline';
type MemorySharingPolicy = 'none' | 'horizontal' | 'vertical' | 'full';
type L3Subtype = 'worker' | 'supervisor';

interface AgentProfile {
  id: string;                          // Unique (mentionable @ID)
  name: string;                        // Display name (no spaces, use underscore)
  title: string;                       // Short role descriptor
  species?: string;                    // Thematic species (e.g., "raven", "crow", "owl")
  avatar?: string;                     // Avatar URL or color hex
  authorityLevel: AuthorityLevel;
  l3Subtype?: L3Subtype;
  
  // Module references (identity-only — references, not inline config)
  modelModuleId: string;               // FK → ModelModule
  instructionModuleId: string;         // FK → InstructionModule
  toolkitModuleId?: string;            // FK → ToolkitModule
  constraintsModuleId?: string;        // FK → ConstraintsModule
  capabilitiesModuleId?: string;       // FK → CapabilitiesModule
  
  // Authority
  memorySharingPolicy: MemorySharingPolicy;
  isOmniscient: boolean;               // L0 tag (for L1 only)
  fallbackAgentId?: string;            // L2 only — backup agent
  categoryPermissions?: string[];      // L1 only — accessible category IDs
  
  // Permissions (granular auth)
  permissions: {
    spawnAgents: boolean;
    patchRuntime: boolean;
    accessAllChannels: boolean;
  };
  
  status: AgentStatus;
  isTemplate: boolean;                 // Is this a preset/template?
  createdAt: Date;
  updatedAt: Date;
}
```

### 3.2 Cognitive Module System (5 Types)

```typescript
// ─── Model Module (LLM Configuration) ───────────────────────────────

type ProviderEngine = 'google' | 'openai' | 'anthropic' | 'ollama' | 'custom';

interface ModelModule {
  id: string;                          // e.g., "google_001"
  label: string;                       // Display name
  provider: ProviderEngine;
  modelName: string;                   // Exact string — never modified by system
  apiKey?: string;
  endpointUrl?: string;
  
  // Generation parameters (sandbox)
  temperature: number;                 // 0.0–2.0
  topP: number;                        // 0.0–1.0
  maxOutputTokens: number;
  stopSequences: string[];
  
  // Context window config
  maxRecentMessages: number;           // Tier 2 sliding window (default: 30)
  enableCompression: boolean;          // Tier 3 summary (default: true)
  compressionThreshold: number;       // Start compress after N messages (default: 50)
  
  createdAt: Date;
  updatedAt: Date;
}

// ─── Instruction Module (System Prompt Template) ────────────────────

interface InstructionModule {
  id: string;                          // e.g., "architect_core"
  label: string;                       // Display name
  base: string[];                      // Array of instruction lines
  runtimePatchable: boolean;           // Can be overridden at runtime
  createdAt: Date;
  updatedAt: Date;
}

// ─── Toolkit Module (Tool Permissions Bundle) ───────────────────────

interface ToolkitModule {
  id: string;                          // e.g., "architect_toolkit"
  label: string;                       // Display name
  tools: string[];                     // Array of tool IDs
  createdAt: Date;
  updatedAt: Date;
}

// ─── Constraints Module (Safety Rules) ──────────────────────────────

interface ConstraintsModule {
  id: string;                          // e.g., "safe_reasoning_v2"
  label: string;                       // Display name
  rules: string[];                     // Safety constraint rules
  disallowedActions: string[];         // Explicitly forbidden actions
  createdAt: Date;
  updatedAt: Date;
}

// ─── Capabilities Module (Skill Declarations) ───────────────────────

interface CapabilitiesModule {
  id: string;                          // e.g., "reasoning_planner"
  label: string;                       // Display name
  skills: string[];                    // Declared skills/capabilities
  functionSchemas: object[];           // Optional JSON schemas for custom functions
  createdAt: Date;
  updatedAt: Date;
}
```

### 3.3 Runtime Override & State

```typescript
interface RuntimeOverride {
  id: string;
  targetAgentId: string;
  overrideType: 'runtime_patch' | 'temp_permission' | 'context_inject';
  instructionPatch?: {
    append?: string[];                 // Append instructions
    replace?: string[];                // Replace specific lines
  };
  permissionPatch?: {
    grantTools?: string[];             // Temporary tool grants
    revokeTools?: string[];            // Temporary tool revocations
  };
  createdBy: string;                   // Agent ID or "user"
  expiresAt?: Date;                    // Optional auto-expiry
  createdAt: Date;
}

interface RuntimeState {
  sessionId: string;
  agentId: string;
  status: 'idle' | 'working' | 'paused' | 'offline';
  activeTask?: string;
  activeChannelId?: string;
  startedAt?: Date;
  overridesApplied: string[];          // IDs of active runtime overrides
  lastHeartbeat?: Date;
}
```

### 3.4 Category & Channel

```typescript
interface Category {
  id: string;
  name: string;
  ownedByAgentId?: string;             // L1 owner
  createdBy: string;                   // "user" or agent ID
  embeddingProfileId?: string;         // FK → EmbeddingModelProfile (optional)
  position: number;
  createdAt: Date;
}

interface Channel {
  id: string;
  categoryId: string | null;           // null = top-level (#general)
  name: string;
  type: 'standard' | 'pair_private' | 'archived';
  createdBy: string;
  position: number;
  createdAt: Date;
  archivedAt?: Date;
}
```

### 3.5 Messages & Mentions

```typescript
type MessageAuthorType = 'user' | 'agent' | 'system';

interface ChannelMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorLevel: AuthorityLevel | 'stakeholder';
  authorType: MessageAuthorType;
  content: string;
  mentions: MentionMetadata[];
  isInternalMonologue: boolean;
  sequenceNumber: number;              // Per-channel ordering guarantee
  timestamp: Date;
}

interface MentionMetadata {
  type: 'agent' | 'role';
  targetId: string;                    // Agent ID or auth level string
  targetName: string;
  position: number;                    // Char position in content
  flag: 'critical' | 'attention_boost' | 'escalation' | null;
}
```

### 3.6 Event Bus

```typescript
interface AgentEvent {
  eventId: string;
  type: 'task_assign' | 'task_complete' | 'mention' | 'escalation'
      | 'status_change' | 'spawn_request' | 'spawn_complete'
      | 'schedule_trigger' | 'budget_warning' | 'agent_pause'
      | 'runtime_override' | 'runtime_patch';
  channelId: string;
  fromAgentId: string;
  toAgentId: string;
  payload: Record<string, unknown>;
  timestamp: Date;
}
```

### 3.7 Task Files & Spawn Requests

```typescript
interface SpawnRequest {
  id: string;
  requestedBy: string;                 // L2 agent ID
  channelId: string;
  workerTemplateId: string;
  supervisorTemplateId: string;
  subtasks: SubtaskDefinition[];
  failurePolicy: 'retry' | 'escalate';
  maxRetries: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
}

interface SubtaskDefinition {
  id: string;
  title: string;
  instructions: string;
  priority: 'high' | 'medium' | 'low';
}

interface TaskFile {
  id: string;
  spawnRequestId: string;
  subtaskId: string;
  title: string;
  content: string;
  workerAgentId: string;
  supervisorAgentId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
}
```

### 3.8 Token Budget

```typescript
interface TokenBudget {
  globalSoftCap: number;
  perProviderBudget: Record<string, {
    softCap: number;
    used: number;
    resetPeriod: 'daily' | 'weekly' | 'monthly' | 'never';
    lastResetAt: Date;
  }>;
}

interface TokenUsageLog {
  id: string;
  agentId: string;
  channelId: string;
  modelProfileId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: Date;
}
```

### 3.9 Channel Index (L0 Knowledge)

```typescript
interface ChannelIndex {
  channelId: string;
  channelPath: string;                 // "Category A / #channel-name"
  topicSummary: string;
  lastIndexedAt: Date;
  messageCountSinceIndex: number;
}
```

### 3.10 LLM Adapter Interface

```typescript
interface StandardMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

interface GenerationResult {
  content: string;
  toolCalls?: ToolCall[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: 'stop' | 'tool_call' | 'length' | 'error';
}

interface StreamChunk {
  content?: string;
  toolCall?: Partial<ToolCall>;
  usage?: TokenUsage;
  done: boolean;
}

interface IModelAdapter {
  readonly provider: ProviderEngine;
  generate(messages: StandardMessage[], tools?: object[], config?: object): Promise<GenerationResult>;
  generateStream(messages: StandardMessage[], tools?: object[], config?: object): AsyncIterable<StreamChunk>;
  countTokens(messages: StandardMessage[]): Promise<number>;
  embed(texts: string[]): Promise<number[][]>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}
```

### 3.11 EventBroker Interface

```typescript
class EventBroker {
  emit(event: AgentEvent): void;
  on(type: AgentEvent['type'], channelId: string,
     handler: (event: AgentEvent) => void): string;     // returns listenerId
  onAny(handler: (event: AgentEvent) => void): string;
  off(listenerId: string): void;
  removeChannelListeners(channelId: string): void;
  getRecentEvents(channelId: string, limit?: number): AgentEvent[];
}
```

---

## 4. Database Schema (PostgreSQL + pgvector)

### 4.1 Module Tables (NEW — CrowdOS Modular System)

```
┌─────────────────────────┐  ┌─────────────────────────────┐
│     MODEL_MODULES       │  │    INSTRUCTION_MODULES       │
├─────────────────────────┤  ├─────────────────────────────┤
│ id              PK      │  │ id                PK        │
│ label                  │  │ label                       │
│ provider               │  │ base          TEXT[] (JSON) │
│ model_name             │  │ runtime_patchable  boolean  │
│ api_key                │  │ created_at                  │
│ endpoint_url           │  │ updated_at                  │
│ temperature            │  └─────────────────────────────┘
│ top_p                  │
│ max_output_tokens      │  ┌─────────────────────────────┐
│ stop_sequences   JSON  │  │      TOOLKIT_MODULES        │
│ max_recent_messages    │  ├─────────────────────────────┤
│ enable_compression     │  │ id                PK        │
│ compression_threshold  │  │ label                       │
│ created_at             │  │ tools      TEXT[] (JSON)    │
│ updated_at             │  │ created_at                  │
└─────────────────────────┘  │ updated_at                  │
                             └─────────────────────────────┘
┌─────────────────────────┐  ┌─────────────────────────────┐
│   CONSTRAINTS_MODULES   │  │   CAPABILITIES_MODULES      │
├─────────────────────────┤  ├─────────────────────────────┤
│ id              PK      │  │ id                PK        │
│ label                  │  │ label                       │
│ rules      TEXT[] (JSON)│  │ skills    TEXT[] (JSON)    │
│ disallowed_actions JSON │  │ function_schemas JSON      │
│ created_at             │  │ created_at                  │
│ updated_at             │  │ updated_at                  │
└─────────────────────────┘  └─────────────────────────────┘
```

### 4.2 Core Entity Tables

```
┌─────────────────────────┐  ┌─────────────────────────────┐
│          AGENTS         │  │     RUNTIME_OVERRIDES        │
├─────────────────────────┤  ├─────────────────────────────┤
│ id              PK      │  │ id                PK        │
│ name                    │  │ target_agent_id     FK      │
│ title                   │  │ override_type               │
│ species                 │  │ instruction_patch JSON      │
│ avatar                  │  │ permission_patch   JSON     │
│ authority_level         │  │ created_by                  │
│ l3_subtype              │  │ expires_at                  │
│                         │  │ created_at                  │
│ model_module_id    FK   │  └─────────────────────────────┘
│ instruction_module_id FK│
│ toolkit_module_id   FK  │  ┌─────────────────────────────┐
│ constraints_module_id FK│  │     RUNTIME_STATES          │
│ capabilities_module_idFK│  ├─────────────────────────────┤
│                         │  │ session_id     PK           │
│ memory_sharing_policy   │  │ agent_id        FK          │
│ is_omniscient           │  │ status                      │
│ fallback_agent_id   FK  │  │ active_task                 │
│ category_perms    JSON  │  │ active_channel_id  FK       │
│ permissions        JSON │  │ overrides_applied JSON      │
│ status                  │  │ last_heartbeat              │
│ is_template             │  │ created_at                  │
│ created_at              │  └─────────────────────────────┘
│ updated_at              │
└─────────────────────────┘

Remaining tables (unchanged from v1):
  - MESSAGES
  - CATEGORIES
  - CHANNELS
  - SPAWN_REQUESTS
  - TASK_FILES
  - SCHEDULED_TASKS
  - CHANNEL_INDEX
  - COMPRESSED_SUMMARIES
  - TOKEN_USAGE_LOG
  - GENERATION_MODEL_PROFILES (legacy, kept for backward compat)
  - EMBEDDING_MODEL_PROFILES
  - INDEXING_MODEL_PROFILES
  - TOOLS
  - AGENT_TOOLS
```

**Total tables: 20 (15 original + 5 module tables + runtime tables)**

---

## 5. REST API Endpoints

| Method | Path | Deskripsi |
|--------|------|-----------|
| **Agents** | | |
| `POST` | `/api/agents` | Buat agen baru (identity + module refs) |
| `GET` | `/api/agents` | Daftar semua agen (+ status) |
| `GET` | `/api/agents/:id` | Detail profil agen |
| `PUT` | `/api/agents/:id` | Update profil agen |
| `DELETE` | `/api/agents/:id` | Hapus agen |
| **Modules** | | **(NEW)** |
| `POST` | `/api/modules/model` | Buat ModelModule baru |
| `GET` | `/api/modules/model` | Daftar semua ModelModules |
| `PUT` | `/api/modules/model/:id` | Update ModelModule |
| `DELETE` | `/api/modules/model/:id` | Hapus ModelModule |
| `POST` | `/api/modules/instruction` | Buat InstructionModule |
| `GET` | `/api/modules/instruction` | Daftar InstructionModules |
| `PUT` | `/api/modules/instruction/:id` | Update InstructionModule |
| `DELETE` | `/api/modules/instruction/:id` | Hapus InstructionModule |
| `POST` | `/api/modules/toolkit` | Buat ToolkitModule |
| `POST` | `/api/modules/constraints` | Buat ConstraintsModule |
| `POST` | `/api/modules/capabilities` | Buat CapabilitiesModule |
| `GET` | `/api/modules` | Daftar semua modules (all types) |
| **Runtime** | | **(NEW)** |
| `POST` | `/api/runtime/overrides` | Buat runtime override |
| `GET` | `/api/runtime/overrides` | Daftar active overrides |
| `DELETE` | `/api/runtime/overrides/:id` | Hapus (expire) override |
| `GET` | `/api/runtime/states` | Daftar runtime states |
| `GET` | `/api/runtime/states/:agentId` | Runtime state per agent |
| **Templates** | | |
| `GET` | `/api/templates` | Daftar preset/templates |
| `POST` | `/api/templates` | Simpan agen sebagai template |
| `POST` | `/api/templates/:id/create` | Buat agen dari template |
| `POST` | `/api/templates/export` | Export config JSON |
| `POST` | `/api/templates/import` | Import config JSON |
| **Categories** | | |
| `POST` | `/api/categories` | Buat category baru |
| `GET` | `/api/categories` | Daftar semua categories |
| `PUT` | `/api/categories/:id` | Update category |
| `DELETE` | `/api/categories/:id` | Hapus category |
| **Channels** | | |
| `POST` | `/api/channels` | Buat channel baru |
| `GET` | `/api/channels` | Daftar semua channels |
| `GET` | `/api/channels/:id/messages` | Riwayat pesan |
| `POST` | `/api/channels/:id/messages` | Kirim pesan (trigger agen) |
| `PUT` | `/api/channels/:id/archive` | Archive channel |
| `DELETE` | `/api/channels/:id` | Hapus channel + semua data |
| **Providers** | | (Legacy alias for modules) |
| `POST` | `/api/providers/generation` | Buat generation model profile |
| `POST` | `/api/providers/embedding` | Buat embedding model profile |
| `POST` | `/api/providers/indexing` | Buat indexing model profile |
| `GET` | `/api/providers` | Daftar semua profiles (3 types) |
| `PUT` | `/api/providers/:id` | Update profile |
| `DELETE` | `/api/providers/:id` | Hapus profile |
| `POST` | `/api/providers/:id/test` | Test koneksi |
| **Workspace** | | |
| `GET` | `/api/workspace/settings` | Ambil konfigurasi |
| `PUT` | `/api/workspace/settings` | Update konfigurasi |
| `GET` | `/api/workspace/budget` | Token usage & budget status |
| `PUT` | `/api/workspace/budget` | Update budget config |
| `POST` | `/api/workspace/database` | Set DATABASE_URL + auto push |
| **Tools** | | |
| `GET` | `/api/tools` | Daftar tools yang tersedia |

---

## 6. Socket.io Events

### Server → Client
| Event | Payload | Deskripsi |
|-------|---------|-----------|
| `agent:status` | `{ agentId, status }` | Status dot change (🟢🟡🌑) |
| `message:new` | `ChannelMessage` | Pesan baru di channel |
| `message:stream` | `{ channelId, agentId, chunk }` | Streaming LLM token |
| `agent:thinking` | `{ agentId, channelId }` | Typing indicator |
| `agent:spawned` | `{ pairs, channelId, batchNum }` | L3 pairs di-spawn |
| `agent:despawned` | `{ agentId }` | L3 instance dimatikan |
| `agent:paused` | `{ agentId, reason }` | Agent di-pause (error/budget) |
| `runtime:override` | `{ agentId, override }` | Runtime override applied |
| `runtime:state` | `{ agentId, state }` | Runtime state change |
| `escalation` | `{ channelId, fromAgent, reason }` | Loop/failure alert |
| `budget:warning` | `{ profileId, usage, cap }` | 80% budget reached |
| `budget:exceeded` | `{ profileId, pausedAgents }` | Soft cap hit |

### Client → Server
| Event | Payload | Deskripsi |
|-------|---------|-----------|
| `user:message` | `{ channelId, content, mentions }` | User kirim pesan (dengan mention metadata) |

---

## 7. Dependency Stack

### Backend (`packages/server`)
| Package | Kegunaan |
|---------|----------|
| `typescript` | Bahasa |
| `express` atau `fastify` | HTTP framework — **⚠️ Belum diputuskan** |
| `socket.io` | Real-time WebSocket bridge |
| `@google/generative-ai` | Gemini adapter |
| `openai` | OpenAI adapter |
| `@anthropic-ai/sdk` | Anthropic adapter |
| `node-cron` | Task scheduling |
| `drizzle-orm` + `postgres` | ORM + PostgreSQL driver |
| `uuid` | ID generation |
| `zod` | Runtime validation |
| `pino` | Structured logging |
| `dotenv` | Environment config |
| `cors` | CORS middleware |
| `vitest` | Testing framework |

### Frontend (`packages/client`)
| Package | Kegunaan |
|---------|----------|
| `typescript` | Bahasa |
| `react` + `react-dom` | UI framework |
| `vite` | Build tool |
| `react-router-dom` | Client routing |
| `socket.io-client` | Real-time connection |
| `zustand` | State management (Socket-first sync) |
| `tailwindcss` | Utility CSS — **⚠️ Versi belum diputuskan** |
| `lucide-react` | Icon library |
| `axios` | HTTP client |
| `playwright` | E2E testing |

---

## 8. Resolved Technical Decisions

| Keputusan | Status |
|-----------|--------|
| Product name: **CrowdOS** (Cognitive Agent System) | ✅ Final |
| Architecture: ECS-inspired (Entity-Component-System) | ✅ Final |
| Modules: Model, Instruction, Toolkit, Constraints, Capabilities | ✅ Final |
| Agent = Identity only, all else is module references | ✅ Final |
| Runtime overrides are first-class persistent entities | ✅ Final |
| Database: PostgreSQL + pgvector | ✅ Final |
| Schema: Auto-push saat DATABASE_URL dimasukkan | ✅ Final |
| ORM: Drizzle ORM | ✅ Final |
| Tools: Conventional tool calling (native function calling) | ✅ Final |
| Tools: MCP protocol upgrade path preserved for future | 📝 Noted |
| User model: Single-user (multi-user = future) | ✅ Final |
| Logging: Structured logging (pino) + correlationId | ✅ Final |
| Frontend sync: Socket-first (bukan optimistic update) | ✅ Final |
| Concurrent agents: Sequential queue + turn acknowledgment | ✅ Final |
| LLM params: Di Model Module, bukan Agent Profile | ✅ Final |
| HTTP Framework: Express vs Fastify | ⚠️ Belum diputuskan |
| TailwindCSS version: v3 vs v4 | ⚠️ Belum diputuskan |

---

## 9. CrowdOS Implementation Roadmap

### Phase 1 — Foundation (5 features)
- [ ] Inisialisasi npm workspaces monorepo
- [ ] Bootstrap `packages/server` (HTTP + TS + PostgreSQL + Drizzle)
- [ ] Bootstrap `packages/client` (Vite + React + TS)
- [ ] Implementasi `EventBroker`
- [ ] Implementasi Socket.io bridge
- [ ] Auto schema push + pgvector extension
- [ ] Shell UI: sidebar (Category → Channel tree), `#general`, chat window

### Phase 2 — Module System & Agent Identity
- [ ] **5 Module types CRUD** (Model, Instruction, Toolkit, Constraints, Capabilities)
- [ ] `ModuleRegistry` service
- [ ] **Identity-only AgentRegistry** (agents reference modules, not contain them)
- [ ] Agent Creation UI (module composition editor)
- [ ] Module Workshop UI (create/manage 5 module types)
- [ ] Agent preset/template system (5 built-in presets)

### Phase 3 — LLM Integration
- [ ] `IModelAdapter` interface
- [ ] Adapters: Gemini, OpenAI, Anthropic, Ollama
- [ ] `MemoryBuilder` (XML-tagged dual memory + visibility matrix)
- [ ] Hybrid 3-tier token management (Pinned, Recent, Compressed)
- [ ] L1 agent: receive messages, generate LLM responses, streaming output

### Phase 4 — Runtime & Multi-Agent
- [ ] `RuntimeEngine` + `RuntimeOverride` system
- [ ] `RuntimeState` tracking + Socket.io broadcast
- [ ] Tool Registry + ToolExecutor setup + built-in tools
- [ ] Bipolar L1 Router (decompose + route via agent tool calling)
- [ ] `ChannelController` (Category system, permissions, archive/delete)
- [ ] `AgentSpawnManager` (L3 pair lifecycle, batch processing)
- [ ] Private pair channels + task file lifecycle
- [ ] `@mention` system (autocomplete, metadata, validation, flags)
- [ ] `LoopArbiter` (turn limits, similarity detection, escalation)

### Phase 5 — Safety, Budget & Polish
- [ ] Tool sandboxing (path guard, blacklist, whitelist)
- [ ] Supervisor tool limitations
- [ ] Error handling (7 failure types + escalation chain)
- [ ] `TokenTracker` (budget, usage bars, soft cap, notifications)
- [ ] `Scheduler` (CRON integration)
- [ ] L0 Omniscient: `IndexBuilder` + `search_all_channels` tool
- [ ] Structured logging (pino + correlationId)
- [ ] Unit + Integration tests (Vitest + MockAdapter)
- [ ] E2E tests (Playwright)

---

*Dokumen ini adalah Level 3 yang berfokus pada Struktur Teknis Proyek. Untuk Visi Produk lihat Level 0, untuk Arsitektur Teknis lihat Level 1, dan untuk detail fitur lihat dokumen LV2.*
