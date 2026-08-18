# CrowdOS Currently Implemented Client — Complete Specification

> **Purpose**: This document exhaustively maps every component, behavior, state variable, event handler, rendering pattern, network/socket event, VFS mechanism, and design token in the `/packages/client` codebase. Written so that any agent can work with this implemented frontend without re-analyzing the source code.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Technology Stack](#2-technology-stack)
3. [Directory Structure](#3-directory-structure)
4. [Type System](#4-type-system)
5. [State Management — Zustand Store](#5-state-management--zustand-store)
6. [Application Shell — `App.tsx`](#6-application-shell--apptsx)
7. [Component Tree](#7-component-tree)
8. [Main Chat Area (CRITICAL)](#8-main-chat-area-critical)
9. [Message System](#9-message-system)
10. [Sidebar Components](#10-sidebar-components)
11. [Portal (Workspace Onboarding)](#11-portal-workspace-onboarding)
12. [Modals](#12-modals)
13. [UI Primitives](#13-ui-primitives)
14. [Mobile Components](#14-mobile-components)
15. [File Explorer & Sandbox (VFS)](#15-file-explorer--sandbox-vfs)
16. [Settings Tabs](#16-settings-tabs)
17. [Design System & Tokens](#17-design-system--tokens)
18. [Animations](#18-animations)
19. [Data Flow Summary](#19-data-flow-summary)
20. [Comparison & Key Differences (vs Target Frontend)](#20-comparison--key-differences-vs-target-frontend)

---

## 1. Project Overview

The currently implemented client (`@community-agent/client`) is a Discord-styled monorepo package designed to interact with a real-time Fastify and Socket.IO backend. It facilitates single-user interaction with a multi-agent orchestration swarm, managing:
- **Hierarchical Swarm Architecture**: Multi-level agent relationships (L0 Surveillance → L1 Exec Admin → L2 Coordinator → L3 Worker).
- **Cognitive Assemblies**: Modular component construction including Instruction prompts, Model variables, and Toolkit capabilities.
- **Dynamic Behavior Patches**: Instant runtime overrides allowing developers to live-patch agent directives, limits, and tools.
- **Authoritative Database Sync**: Workspace configuration, channel sectors, messages history, and cognitive presets are synced to a live PostgreSQL/Spanner database pool.
- **Integrated Virtual File System (VFS)**: Read, write, revert, and sync files inside a secure code sandbox directly from the UI.
- **Governance Audit Telemetries**: Real-time strike tracking, parliamentary consensuses, and safety cap logs.

---

## 2. Technology Stack

| Technology | Version | Purpose |
|---|---|---|
| React | ^19.0.1 | UI rendering framework |
| Vite | ^6.3.0 | Build compiler & dev server (port 3000) |
| TypeScript | ~5.8.2 | Type safety & definitions compiler |
| Tailwind CSS | ^4.1.14 | Styling layout (v4 architecture) |
| Zustand | ^5.0.13 | Local state manager & backend syncer |
| socket.io-client | ^4.8.1 | Real-time WebSocket connection engine |
| motion | ^12.23.24 | Smooth transitions & animations (`motion/react`) |
| lucide-react | ^0.546.0 | Modern SVG iconography |
| @google/genai | ^1.29.0 | Client-side Gemini SDK integration (devDependency) |

**Path Alias**: `@/*` maps to `/packages/client/*` (configured in `tsconfig.json` and `vite.config.ts`).
**Backend Proxy**: Proxies `/api` and `/socket.io` to `http://localhost:3001` (with WebSockets active).

---

## 3. Directory Structure

```
packages/client/
├── public/                              # Static brand logos
│   ├── horizontal_logo_dark.png
│   ├── horizontal_logo_light.png
│   ├── icon_only_dark.png
│   └── icon_only_light.png
│
├── types/
│   └── crowd-os.ts                      # Authoritative domain typings
│
├── stores/
│   └── crowd-os-store.ts                # Authoritative Zustand state & WS layer (1948 lines)
│
├── src/
│   ├── config/
│   │   └── socket.ts                    # Socket.IO client setup
│   ├── App.tsx                          # Base layout gate shell
│   ├── main.tsx                         # Core React entry point
│   └── index.css                        # Tailwind v4 definitions, scrollbars, keyframes
│
├── components/
│   ├── ui/
│   │   └── crow-icon.tsx                # Custom SVGs crow sigils and wordmarks
│   ├── portal/
│   │   └── WorkspacePortal.tsx          # Step-by-step DB verifier & launcher
│   └── workspace/
│       ├── main-chat-area.tsx           # Core chat layout & sandbox code viewer (718 lines)
│       ├── workspace-sidebar.tsx        # Left sidebar with channels, categories & JH user profile
│       ├── workspace-dropdown.tsx       # Accordion menu with workspace settings / leave portal
│       ├── right-sidebar.tsx            # Right sidebar with tier rosters & telemetry toggle
│       ├── file-explorer.tsx            # Sandbox VFS recursive tree explorer
│       │
│       ├── messages/
│       │   ├── message.tsx              # Router dispatches by type (includes strike & parliament)
│       │   ├── agent-message.tsx        # Agent balloon with expandable internal monologues
│       │   ├── human-message.tsx        # Amber Operator left border pill block
│       │   ├── system-message.tsx       # Monospace kernel alert banner
│       │   ├── delegation-message.tsx   # GitFork transfer card displaying tokens & gas cost
│       │   ├── tool-execution-message.tsx # Expandable tool schema & outfall JSON block
│       │   ├── mention-parser.tsx       # Regex bold and mention badge highlighter
│       │   └── attachments-view.tsx     # Photo lightbox & files grid
│       │
│       ├── modals/
│       │   ├── agent-profile-modal.tsx  # Dynamic behavior patcher form & DM composer
│       │   └── workspace-settings-modal.tsx # Mega tab console panel (140KB, 2561 lines)
│       │
│       ├── settings/
│       │   └── model-cards-tab.tsx      # Provider routing visual cascading panel
│       │
│       ├── mobile/
│       │   ├── bottom-nav.tsx           # Mobile footer buttons
│       │   └── mobile-drawer.tsx        # Slide left/right drawer templates
│       │
│       └── ui/
│           ├── presence-indicator.tsx   # OKLCH-colored status dots
│           └── status-badge.tsx         # Pill badge encapsulating agent states
```

---

## 4. Type System

**File**: `types/crowd-os.ts`

### Typings Mapping

#### `AgentStatus`
```ts
type AgentStatus = 'active' | 'idle' | 'thinking' | 'delegating' | 'executing' | 'sleeping' | 'paused' | 'offline' | 'working';
```

#### `AgentLevel`
```ts
type AgentLevel = 0 | 1 | 2 | 3; // L0 (Omniscient), L1 (Admin), L2 (Coordinator), L3 (Worker)
```

#### `Agent`
```ts
interface Agent {
  id: string;
  name: string;
  species: string; // Thematic tier (Falcon, Raven, Crow, Sparrow, Pigeon)
  level: AgentLevel;
  status: AgentStatus;
  avatar?: string;
  instructionModuleId?: string;
  modelModuleId?: string;
  toolkitModuleId?: string;
  constraintsModuleId?: string;
  capabilitiesModuleId?: string;
  parentId?: string; // Hierarchical supervision supervisor ID
  roleId?: string;
  isOmniscient?: boolean;
  createdAt: string;
  lastActive: string;
  description?: string;
}
```

#### `MessageType`
```ts
type MessageType = 'human' | 'agent' | 'system' | 'governance' | 'delegation' | 'tool_execution';
```

#### `DelegationInfo`
```ts
interface DelegationInfo {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  task: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  tokens: number;
  cost: number;
}
```

#### `ToolExecution`
```ts
interface ToolExecution {
  name: string;
  input: string; // JSON string input
  output?: string; // Result output
  durationMs: number;
  status: 'success' | 'error';
}
```

#### `Attachment`
```ts
interface Attachment {
  id: string;
  name: string;
  type: string; // MIME type (e.g. 'image/png')
  url: string;  // Base64 Data URL
  size?: number;
}
```

#### `Message`
```ts
interface Message {
  id: string;
  type: MessageType;
  content: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  channelId: string;
  timestamp: string;
  mentions?: string[];
  delegationInfo?: DelegationInfo;
  toolExecution?: ToolExecution;
  metadata?: Record<string, any>; // monologues cached as metadata.monologue
  attachments?: Attachment[];
}
```

#### `Channel`
```ts
interface Channel {
  id: string;
  name: string;
  description?: string;
  unreadCount: number;
  hasMention: boolean;
  categoryId?: string | null;
  type?: 'standard' | 'pair_private' | 'archived';
  position?: number;
  archivedAt?: string | null;
}
```

#### `Category`
```ts
interface Category {
  id: string;
  name: string;
  collapsed: boolean;
  channels: Channel[];
  position?: number;
}
```

#### `Workspace`
```ts
interface Workspace {
  id: string;
  name: string;
  icon: string; // CrowIconVariant index or simple emoji
  dbUrl?: string;
  categories: Category[];
  channels?: Channel[]; // Top-level channels outside categories
  createdAt: string;
}
```

#### `InstructionModule`
```ts
interface InstructionModule {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  persona?: string;
  rules?: string[]; // Defined as array in backend
  sandboxPath?: string;
  modelProfileId?: string;
  createdAt: string;
}
```

#### `ModelModule`
```ts
interface ModelModule {
  id: string;
  name: string;
  description?: string;
  modelProfileId: string; // References exact LLM name (e.g., gemini-2.5-pro)
  provider?: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  maxRecentMessages?: number;
  enableCompression?: boolean;
  compressionThreshold?: number;
  createdAt: string;
}
```

---

## 5. State Management — Zustand Store

**File**: `stores/crowd-os-store.ts`

### Zustand State Structure

Local storage caching is manually synchronized for `workspaces`, `agents`, `messages`, `modelProfiles`, `constraintsModules`, and `capabilitiesModules`.

#### Local Telemetry Slices
- `globalSoftCap`: number (default `1,000,000` tokens)
- `perProviderBudget`: Record<string, { softCap: number, used: number }>
- `totalTokensConsumed`: number
- `vfsRevision`: number (monitors sandbox edits)

#### Selection & UI States
- `activeWorkspaceId`: string | null (persisted in `crowdos_active_workspace`)
- `activeChannelId`: string | null
- `selectedAgentId`: string | null
- `selectedSandboxFile`: string | null
- `rightSidebarOpen`: boolean (default `true`)
- `leftSidebarCollapsed`: boolean (default `false`)
- `settingsModalOpen`: boolean (default `false`)
- `agentProfileModalOpen`: boolean (default `false`)
- `workspaceSettingsTab`: string (default `'overview'`)

#### Mobile Overlays
- `activeMobileTab`: `'chat'` | `'channels'` | `'agents'` | `'stats'` | `'settings'`
- `mobileDrawerLeft`: boolean
- `mobileDrawerRight`: boolean

---

### Real-Time WebSockets Synchronization

Upon importing `stores/crowd-os-store.ts`, a permanent WebSocket link is bound to the same origin through Vite's socket proxy via event handlers:

```ts
import { socket } from '../src/config/socket';
```

| Socket Event | Payload Schema | Action Performed |
|---|---|---|
| `message:new` | `msg: { id, content, authorType, authorId, authorName, channelId, timestamp, mentions: Array<{targetName}>, isInternalMonologue: boolean }` | **Monologue Buffer**: If `isInternalMonologue` is true, caches contents in `pendingMonologueText`. If false, creates a new chat message bubble, appends `monologue` as metadata, and resets buffer. Triggers unread highlights if channel is not active. |
| `message:stream` | `{ agentId, channelId, chunk, isThoughts: boolean }` | **Live Streaming**: Identifies streaming message by placeholder `stream-${agentId}`. Appends chunk to message `content` (if regular text) or message `metadata.monologue` (if thoughts). |
| `agent:status` | `{ agentId, status }` | Updates agent status state variable and overrides `lastActive` timestamp. |
| `agent:thinking` | `{ agentId }` | Shortcut triggering `status = 'thinking'` for visual indicators. |
| `workspace:sync` | None | Dispatches `fetchWorkspaces()` to reload categories/channels nested tree. |
| `budget:exceeded` | `payload` | Logs console warning and triggers `fetchBudget()` reload. |
| `agent:spawned` | `{ agentId, name, level, timestamp }` | Spawns a new L3 drone, injecting it into `agents` state and local storage. |
| `agent:paused` | `{ agentId }` | Overrides agent status to `'paused'`. |
| `agent:resumed` | `{ agentId }` | Overrides agent status to `'idle'`. |
| `runtime:snapshot` | `{ agents: Array, overrides: Array }` | Sets authoritative synced array of agents and runtime patches received from backend parser. |
| `escalation:created`| `{ type, agentId, message, timestamp, details }` | Adds a `'governance'` message bubble detailing structural swarm safety escalations. |
| `strike:initiated` | `{ agentId, reason, strikeCount, maxStrikes }` | Triggers safety warning and logs a safety strike warning banner. |
| `parliament:convened`| `{ parliamentId, topic, status, votes, timestamp }` | Convenes a parliamentary voting consensus card inline in active channel. |
| `parliament:updated` | `{ parliamentId, status, votes }` | Updates real-time consensus counts, vote bars, and ballots grid. |
| `sandbox:updated` | `payload` | Triggers VFS sync via `incrementVfsRevision()`. |

---

### Store Actions (51 total)

#### Workspace Sector Actions
- `fetchWorkspaces`: Recursive loader from Fastify `/api/categories` and `/api/channels`. Restores collapsible folder states, splits archived channels, and maps top-level sectors.
- `createWorkspace(name, dbUrl, icon)`: Handshakes with `/api/workspace/database` to verify integrity, provisions default `[ADMIN]` and `GENERAL ROOMS` channels, updates arrays.
- `deleteWorkspace(id)`: De-authorizes local cache, clears active pointers.
- `enterWorkspace(id)`: Enters active space, triggers deep synchronize.
- `leaveWorkspace()`: Logs out of space.
- `setActiveChannel(id)`: Clears unreads/mentions indicators. Fetches live REST message history from `/api/channels/${id}/messages` and overrides message list.

#### Messages Actions
- `addMessage(msg)`: Encapsulates operator input and emits `socket.emit('user:message', { channelId, content, mentions })` directly to backend WebSocket pipeline.
- `clearChannelMessages(channelId)`: Wipes logs within targeted sector.

#### Swarm Assembly CRUD Actions
All CRUD operations communicate with REST API backend endpoints:
- **Agents**: `/api/agents` (`POST` add, `PUT` update, `DELETE` remove). Includes permissions schemas payload.
- **Model Profiles**: `/api/providers/generation` (`POST` add, `PUT` edit, `DELETE` remove).
- **Instruction Modules**: `/api/modules/instruction` (`POST`, `PUT`, `DELETE`).
- **Model Modules**: `/api/modules/model` (`POST`, `PUT`, `DELETE`).
- **Toolkit Modules**: `/api/modules/toolkit` (`POST`, `PUT`, `DELETE`).
- **Constraints Modules**: `/api/modules/constraints` (`POST`, `PUT`, `DELETE`).
- **Capabilities Modules**: `/api/modules/capabilities` (`POST`, `PUT`, `DELETE`).

#### UI & Sidebar Toggles
- `toggleRightSidebar()` / `setRightSidebarOpen(boolean)`
- `toggleLeftSidebar()` / `setSettingsModalOpen(boolean)` / `setWorkspaceSettingsTab(tab)`
- `toggleCategoryCollapse(categoryId)`

#### Category & Channels REST Modifiers
- `createCategory(name)`: `POST /api/categories`
- `deleteCategory(id)`: `DELETE /api/categories/${id}`
- `createChannel(catId, name, desc)`: `POST /api/channels`
- `deleteChannel(id)`: `DELETE /api/channels/${id}`
- `archiveChannel(id, archive)`: `PATCH /api/channels/${id}` toggles type to `'archived'`.
- `reorderCategory(id, direction)`: Swaps position index and maps PUT calls to `/api/categories/${id}`.
- `reorderChannel(id, direction)`: Swaps position index and maps PATCH calls to `/api/channels/${id}`.

#### Runtime Patches (Overrides)
- `addRuntimeOverride(override)`: Spins unique ID, appends active overrides.
- `toggleRuntimeOverride(id, active)`: Activates or deactivates runtime patch.
- `deleteRuntimeOverride(id)`: Deletes patch.

#### Sandboxing (VFS)
- `setSelectedSandboxFile(file)`
- `incrementVfsRevision()`: Signals file explorer to reload directories.

#### Budgets & Safety Controls
- `fetchBudget()`: Restores budget cap telemetry from `/api/workspace/budget`.
- `updateBudget(cap, providers)`: `PUT /api/workspace/budget`.
- `resetBudget()`: `POST /api/workspace/budget/reset`.

---

## 6. Application Shell — `App.tsx`

**File**: `src/App.tsx`

Applies an onboarding gate. If `!activeWorkspaceId`, aborts shell load and mounts `WorkspacePortal` verifier full screen.

Once validated, renders 3-Panel desktop layout with responsive sliding mobile templates:

```
[div#crowd-os-root-shell] (w-screen h-screen, bg-[#0c0c0e], flex col)
├── [Main Work Area] (flex-1 flex overflow-hidden w-full relative)
│   ├── [WorkspaceSidebar] (Desktop static left panel, hidden md:flex w-[245px])
│   ├── [MainChatArea] (Flex-1 center console work area, min-w-0)
│   ├── [RightSidebar] (Desktop static right panel, hidden md:flex shrink-0)
│   │
│   ├── [MobileDrawer Left] (Slide left drawer containing WorkspaceSidebar)
│   └── [MobileDrawer Right] (Slide right drawer containing RightSidebar)
│
├── [BottomNav] (Sticky bottom nav footer, md:hidden)
├── [AgentProfileModal] (Globally mounted profiles detail window)
└── [WorkspaceSettingsModal] (Globally mounted settings console)
```

---

## 7. Component Tree

```
App
├── [GATE: !activeWorkspaceId]
│   └── WorkspacePortal
│       ├── Database verifier form & pseudo-terminal logs
│       └── CrowIcon Icon Picker
│
└── [GATE: activeWorkspaceId]
    ├── WorkspaceSidebar (Desktop & Mobile drawer instance)
    │   ├── WorkspaceDropdown (Accordion menu with leave option)
    │   └── Hash categories channels listing & JH user profile card
    │
    ├── MainChatArea
    │   ├── MessageRouter (Converts message types)
    │   │   ├── HumanMessage -> MentionParser & AttachmentsView
    │   │   ├── AgentMessage -> expandable monologues & MentionParser
    │   │   ├── SystemMessage -> banner layout
    │   │   ├── DelegationMessage -> GitFork cost display
    │   │   ├── ToolExecutionMessage -> expandable inputs & output logs
    │   │   └── Governance Alerts -> strike dots warning meter & parliament consensus vote bars
    │   │
    │   ├── SandboxCodeViewer (VFS text area editor with revert & save actions)
    │   └── Composer text area with Drag-and-drop file uploader & mention suggestions
    │
    ├── RightSidebar (Desktop & Mobile drawer instance)
    │   ├── Telemetry Dashboard (Channel vs Global metrics cards)
    │   ├── Tiered agents roster list
    │   └── FileExplorer VFS Recursive Tree Node
    │
    ├── BottomNav (Mobile footer)
    ├── AgentProfileModal (Runtime patches form & DM composer)
    └── WorkspaceSettingsModal (8-tab mega configuration console)
        └── ModelCardsTab (Dynamic failover map dashboard)
```

---

## 8. Main Chat Area (CRITICAL)

**File**: `components/workspace/main-chat-area.tsx`

Reads all layout states directly from the Zustand store. Has no custom component props.

### Inline VFS Text Editor: `SandboxCodeViewer`

Instead of target-frontend's simple mock highlights, the implemented client includes a fully active `SandboxCodeViewer` component embedded locally:

#### State Variables
- `content`: string (active text content of file)
- `originalContent`: string (cached copy to monitor changes)
- `isLoading`: boolean
- `isSaving`: boolean

#### REST Actions
- **On Mount / Path Change**: Fetches file contents via `GET /api/workspace/files/content?path={path}&workspaceId={workspaceId}`.
- **On Click Save**: Emits `POST /api/workspace/files/content` transmitting changed text, overriding `originalContent` on success.
- **Dirty Check**: Compares `content !== originalContent` to toggle "Revert" and "Save" button states.

---

### Input Composer Capabilities

The message input container features several advanced interactions:

#### Mentions Auto-Detection
On composer `onChange`, reads cursor position. If caret word starts with `@`, sets `showMentions = true`, filters agents array based on letters following `@`, and captures keyboard actions (`ArrowUp`/`ArrowDown` to navigate list, `Enter`/`Tab` to select, `Escape` to dismiss). Selecting an agent appends them as a chip in the composer and adds them to `selectedMentions`.

#### Drag & Drop File Uploads
Implements `onDragOver`, `onDragLeave`, and `onDrop`. Dropping files parses the list through `FileReader.readAsDataURL()`, caching them as staged Base64 `Attachment` objects in local state. They render as mini previews (image or file icons) in the staged attachments row.

#### Fast Trigger Shortcuts
Clicking the `PlusCircle` button opens an operational popover listing:
- **Add photos & files**: Triggers hidden native `<input type="file">`.
- **Recent files** (mock): Appends query logs, dispatch matrices, or SVG diagrams to attachments.
- **Create image**: Auto-fills composer with `@ImageGen create a futuristic neon-tinted workspace core layout representing CrowdOS operations: `.
- **Deep research**: Prepends `[DEEP RESEARCH] ` flag to text.
- **Web search**: Prepends `[WEB GROUNDED] ` flag to text.

---

### Consecutive Message Grouping

Consecutive messages from the same author inside the active channel are grouped into a single, clean visual thread if:
1. They are from the same `authorId`.
2. The message is NOT streaming (`!id.startsWith('stream-')`).
3. There is no active internal monologue metadata (`!current.metadata?.monologue`).
4. Neither message contains attachments.
5. They are sent less than 5 minutes (`300 seconds`) apart.

**Grouped Render**: Indented text-only block (`pl-[52px]`) without avatars, tags, or headers.
**Non-Grouped Render**: Renders full dispatch card via `MessageRouter`.

---

## 9. Message System

### Message Router
**File**: `messages/message.tsx`

Routes incoming types dynamically. Features specific governance panels:

#### Subtype: `'strike'`
Displays a warning panel (`#strike-warning`) featuring a safety strike progress meter. Renders a grid of strike boxes up to `maxStrikes`. Box is filled with amber glowing shadow if strike is recorded, otherwise dark zinc. Displays exact strike indexes, audited exception error reports, and timestamps.

#### Subtype: `'parliament'`
Displays a consensus ballot board (`#parliament-panel`). Shows the active voting topic, dynamic voting bar splits (teal glow bar representing approve counts, rose glow bar representing reject counts), and a grid displaying each agent's individual voting ballot card:
- **Approve**: Teal card with checkmark.
- **Reject**: Rose card with cross circle.
- **Pending**: Zinc card with spinning Loader spinner.

---

### Message Component Implementations

- **Agent Message (`agent-message.tsx`)**: Resolves border and badge styles based on hierarchical level. Implements expandable internal monologues (`metadata.monologue`). If monologue exists, overlays an "eye" button to show/hide thoughts, displaying them inside a custom indigo border. Avatar, name, and level badge are all clickable buttons triggering `openAgentProfileModal()`.
- **Human Message (`human-message.tsx`)**: Displays operator tag, left border strip (`border-l-4 border-amber-500`), and custom mention badges mapping all `@` tags.
- **System Message (`system-message.tsx`)**: Monospaced centermost banner displaying kernel alerts with a terminal icon.
- **Delegation Message (`delegation-message.tsx`)**: Renders hierarchical GitFork flow between supervisor and target subordinate agent, including task details, processed tokens, and gas cost.
- **Tool Execution Message (`tool-execution-message.tsx`)**: Renders tool execution telemetry (spinning setting gear icon, status, and duration). Expandable panel reveals monospaced code blocks detailing "INPUT SCHEMATICS" and "SYSTEM OUTFALL" with text selection active.
- **Mention Parser (`mention-parser.tsx`)**: Utilizes regex blocks to separate code segments (rendering them inside custom styled code boxes) from standard markdown. Parses bold formatting (`**`) and inline code backticks (`\``), and transforms all `@agent`, `@operator`, and `@role` mentions into styled pills.
- **Attachments View (`attachments-view.tsx`)**: Maps files grid. Image attachments render as aspect-video previews with hover overlay actions. Clicking an image launches a full-screen lightbox modal (`#lightbox-attachment-overlay`) with backdrop blur and zoom layout.

---

## 10. Sidebar Components

### Workspace Sidebar
**File**: `workspace-sidebar.tsx`

Renders the left navigation sidebar. Displays:
- `WorkspaceDropdown` header accordion.
- Top-level standard channels (where `categoryId` is null).
- Categories list with collapsible arrow buttons, category name, and create-channel shortcut.
- Channel selectors with unreads badge count and glowing rose mention dots.
- User profile footer bar (`#sidebar-user-section`) detailing operator avatar, name ("Juan Hamzah"), email, and console settings gear.

### Workspace Dropdown
**File**: `workspace-dropdown.tsx`

Renders the workspace selector dropdown wrapped in `<AnimatePresence>` motion blocks. Lists:
- **Workspace Settings**: Opens Settings modal to `'overview'`.
- **Create Category**: Opens Settings modal to `'channels'`.
- **Copy Workspace ID**: Writes ID to clipboard.
- **Leave Space Portal**: Calls `leaveWorkspace()` with red styling.

### Right Sidebar
**File**: `right-sidebar.tsx`

Swaps dynamically under motion transitions:
- If `rightSidebarOpen` is false: Renders VFS `<FileExplorer />`.
- If `rightSidebarOpen` is true: Renders Swarm Telemetries & Agents Roster.

#### Swarm Telemetries Dashboard
Provides a channel vs global toggle. Computes participant agents, channels count, token counts (adds a base of `421,035` global or `12,530` channel tokens plus actual message content length estimations), and estimated costs (`tokens * $0.000003`).

#### Agents Roster Tiers
Groups active agents by level:
- **Tier L0 — Surveillance**: Cyan text, displays Omniscient indicators.
- **Tier L1 — Executive Admin**: Rose text.
- **Tier L2 — Coordinators**: Indigo text.
- **Tier L3 — Workers**: Emerald text.

Clicking an agent row launches their profile modal.

---

## 11. Portal (Workspace Onboarding)

**File**: `portal/WorkspacePortal.tsx`

Provides a secure login check before entering the app workspace.

### Step 1: PostgreSQL URL Handshake

Requires testing and verifying a live PostgreSQL Connection URL before launching a workspace:
- Uses a POST request to `/api/workspace/database` to verify DB connection and schema integrity.
- Streams live verification log entries inside a monospaced terminal mock container, simulating connection phases (handshake, port check, auth, and schema validation).
- Displays validation status indicators (teal checkmark or rose error cross).

### Step 2: Workspace Setup

Once the database connection is verified, it unlocks Step 2:
- **Workspace Name**: Text input.
- **Workspace Icon**: Grid picker with 8 custom themed squircle/circle options.
- **Launch Workspace Button**: Triggers `createWorkspace()` and launches app.

Also displays "Existing Local Sessions" at the bottom to quickly resume cached workspaces.

---

## 12. Modals

### Agent Profile Modal
**File**: `modals/agent-profile-modal.tsx`

Provides comprehensive agent details, hierarchical mapping, direct DM composition, and a **Runtime Override Patcher Form**:

- **Active Patches (Runtime Overrides)**: Lists active runtime overrides, allowing users to toggle them via checkboxes or delete them to revert changes.
- **Patch Runtime Form**: Adds custom runtime overrides using a form:
  - **Instruction Patch**: Textarea to specify a temporary system prompt.
  - **Model Parameters Patch**: Input fields to configure temperature (0.0 to 2.0) and max output tokens.
  - **Toolkit Capabilities Patch**: Checkbox list to toggle individual whitelisted tools.
  - Requires specifying an **Audit Patch Reason** before applying.
- **Hierarchy Chain**: Maps supervisor agent and subordinate worker drones.
- **DM Composer**: Input footer that formats messages as `@{agent.name} {text}` and sends them to the active channel.

---

### Workspace Settings Modal
**File**: `modals/workspace-settings-modal.tsx`

A 140KB administration console organized into 8 tabs:

1. **Overview Tab (`overview`)**: Displays workspace identity cards, active VFS sectors, registered agent counts, and general metrics. Contains the "Delete Workspace" trigger.
2. **Agents Tab (`agents`)**: Fully manages agents. Implements **Mind Preset templates** (CEO Owl, Coder Sparrow, QA Pigeon, Writer Raven) to instantly pre-fill forms. Supports **Import/Export Mind** as `.json` files, agent duplication, and modular cognitive assembly mapping.
3. **Permissions & Roles Tab (`roles`)**: Renders custom roles with drag-and-drop ordering. Allows selecting a role to edit its name, pick one of 32 colors, and toggle any of the 10 role permissions.
4. **Tools Tab (`tools`)**: Toggles whitelisted sandbox tool status and displays total usage statistics.
5. **Model Modules Tab (`model_cards`)**: Renders model modules.
6. **Skills Manager Tab (`skills_manager`)**: Dual-pane cognitive modules editor:
  - **Skills Catalog**: Manage instruction modules, system prompts, VFS target paths, and associated model profiles.
  - **Toolkits Catalog**: Create and edit toolkit modules with whitelisted tools checkboxes and JSON schemas.
7. **Category & Channels Tab (`channels`)**: Fully configures sectors. Implements category collapsers, channel deletion, channel archiving (sets channel type to `'archived'`), and channel ordering buttons (up/down).
8. **Safety Policies Tab (`safety`)**: Configures safety parameters, including human approval gates, rate limiters, and emergency kill switches.

---

## 13. UI Primitives

### CrowIcon — `ui/crow-icon.tsx`

Renders the majestic noble crow sigil SVG, scaling it to `iconSize%`. Matches 8 CSS themes:

| Variant Name | Container Classes | Visual Tone |
|---|---|---|
| `crow-white-rounded` | `bg-[#111114] border-zinc-800 text-zinc-100` | Classic Dark |
| `crow-dark-rounded` | `bg-[#f4f4f5] border-zinc-200 text-[#09090b]` | Classic Light |
| `crow-indigo-circle` | `bg-gradient-br from-[#1d1e2e] to-indigo-950 text-[#5f7eff]` | Glowing Circle (Indigo) |
| `crow-amber-cyber` | `bg-gradient-b from-zinc-950 to-amber-955 text-amber-500` | Grid Cyberpunk (Amber) |
| `crow-cyan-radar` | `bg-[#0b1414] border-cyan-500/25 text-cyan-400` | Intelligence Neon (Cyan) |
| `crow-rose-governance`| `bg-gradient-br from-zinc-950 to-[#1e0a0f] text-rose-400` | Authority Crimson (Rose) |
| `crow-matrix-terminal`| `bg-zinc-950 border-emerald-500 text-emerald-400` | Monospace Green (Emerald) |
| `crow-cosmos` | `bg-[#140e28] border-indigo-500 text-indigo-300`| Deep Cosmic Space |

---

### PresenceIndicator — `ui/presence-indicator.tsx`

Uses **Tailwind arbitrary OKLCH expressions** for status dot colors and glow shadows:

- `active`: `bg-[oklch(0.65_0.18_145)] shadow-[0_0_8px_oklch(0.65_0.18_145/0.4)]` (Jade green)
- `idle`: `bg-[oklch(0.55_0.08_90)]` (Amber)
- `thinking`: `bg-[oklch(0.62_0.15_250)] animate-pulse shadow-[0_0_10px_oklch(0.62_0.15_250/0.5)]` (Indigo)
- `delegating`: `bg-[oklch(0.60_0.15_290)] shadow-[0_0_8px_oklch(0.60_0.15_290/0.4)]` (Purple)
- `executing`: `bg-[oklch(0.60_0.12_200)] shadow-[0_0_8px_oklch(0.60_0.12_200/0.4)]` (Teal)
- `working`: `bg-[oklch(0.60_0.12_200)] animate-pulse shadow-[0_0_8px_oklch(0.60_0.12_200/0.4)]` (Teal pulse)
- `paused`: `bg-[oklch(0.55_0.08_90)]` (Amber)
- `offline` / `sleeping`: `bg-zinc-500` (Gray)

---

### StatusBadge — `ui/status-badge.tsx`

Pill badge container displaying presence dots and capitalized status labels. Applies matching OKLCH colors, monospaced text, and active pulsing animations for `thinking` and `working` states.

---

## 14. Mobile Components

- **Bottom Navigation (`bottom-nav.tsx`)**: Sticky footer bar visible only below the `md` breakpoint. Renders a safe-area inset wrapper with 3 buttons: Channels (`setMobileDrawerLeft(true)`), Agents (`setMobileDrawerRight(true)`), and Settings (opens Settings modal).
- **Mobile Drawer (`mobile-drawer.tsx`)**: Adaptive sliding container. Slides in from left or right via `animate-slide-in-left` or `animate-slide-in-right` keyframes. Features a tap backdrop and close shortcut.

---

## 15. File Explorer & Sandbox (VFS)

**File**: `workspace/file-explorer.tsx`

Implements a recursive, dynamic Virtual File System (VFS) linked to the server sandbox:

### File Tree Recursion: `FileTreeNode`
Renders folder and file nodes. Folder clicks check if children are cached; if empty, it triggers a fetch request:
`GET /api/workspace/files?path={node.path}&workspaceId={workspaceId}`
The returned nodes are cached as child elements and rendered recursively. File clicks select the file path in the store, opening it in the editor.

### VFS Synchronization
The `FileExplorer` root element fetches root files from `/api/workspace/files?path=/&workspaceId={workspaceId}` on mount. It automatically re-fetches root files whenever the active workspace or `vfsRevision` changes.

---

## 16. Settings Tabs

### Model Modules Tab
**File**: `settings/model-cards-tab.tsx`

Integrates the model cards catalog editor:
- **Failover Cascade Flow Chart**: Displays provider priority fallbacks (Gemini Primary → Claude L2 Failover → Ollama Local L3).
- **Ping Metrics Grid**: Renders pings for Google (118ms), OpenAI (174ms), Anthropic (236ms), and Ollama (42ms).
- **Test Sync Connection Action**: Calls `POST /api/modules/model/${id}/test` to verify connection and displays successful or missing credentials. Features an offline fallback simulation.
- **Model Parameters form**: Toggles provider type, temperature, base proxy, and max output tokens.

---

## 17. Design System & Tokens

**File**: `src/index.css`

Features Tailwind v4 design token overrides:
- **Typography**: Inter (sans-serif) for general UI, JetBrains Mono (monospace) for logs and code blocks.
- **Color Palettes**:
  - `--color-brand-bg`: `#0A0A0B` (Base deep background)
  - `--color-brand-nav`: `#0E0E10` (Footer panels)
  - `--color-brand-sidebar`: `#111114` (Drawer overlays)
  - `--color-brand-card`: `#1C1C1F` (Portal layouts)
  - `--color-brand-border`: `#1F1F23` (Dark borders)
  - `--color-brand-border-muted`: `#2D2D32` (Interactive highlights)
  - `--color-brand-primary`: `#3359FF` (Indigo theme coordinates)
  - `--color-brand-primary-hover`: `#5575FF`

---

## 18. Animations

Keyframe animations defined in `index.css`:

```css
@keyframes slide-in-left {
  0% { transform: translateX(-100%); }
  100% { transform: translate(0); }
}

@keyframes slide-in-right {
  0% { transform: translateX(100%); }
  100% { transform: translate(0); }
}

@keyframes fade-in-up {
  0% { opacity: 0; transform: translateY(8px); }
  100% { opacity: 1; transform: translateY(0); }
}

@keyframes scale-in {
  0% { opacity: 0; transform: scale(0.96); }
  100% { opacity: 1; transform: scale(1); }
}

@keyframes slide-up {
  0% { opacity: 0; transform: translateY(12px); }
  100% { opacity: 1; transform: translateY(0); }
}

@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

Trigger classes are available as `.animate-slide-up`, `.animate-slide-in-left`, `.animate-slide-in-right`, `.animate-fade-in-up`, `.animate-scale-in`, and `.animate-fade`.

---

## 19. Data Flow Summary

```
[Operator Input] 
       │
       ▼
[addMessage Action] ──(socket.emit)──▶ [Fastify Backend Socket Router]
                                                  │
                                                  ▼
                                      [Swarm Cognitive Execution]
                                                  │
                                       (Streaming text/thoughts)
                                                  │
                                                  ▼
[Zustand socket.on registers] ◀──(Socket)── [Vite Proxy WS Tunnel]
       │
       ▼
[Message Stream Caches] 
       │
       ▼
[React Message Bubble Render]
```

---

## 20. Comparison & Key Differences (vs Target Frontend)

| Feature area | Target Frontend Spec (`/target-frontend`) | Implemented Client (`/packages/client`) |
|---|---|---|
| **Backend Integration** | Simulated in Zustand (800-4000ms setTimeout replies). | Real Fastify REST + Socket.io integration via Vite proxy. |
| **Monologues** | Visual only. | Buffered and streamed via WebSocket (`message:stream`, thought chunks). |
| **VFS Sandbox Code** | Read-only mocked Syntax Highlighter panel. | Dynamic recursive file tree; editing via `SandboxCodeViewer` using POST/GET endpoints. |
| **Onboarding Portal** | Simple tabs with mock connection logs. | Fully active PostgreSQL URL tester verifying schema integrity with live server connection handshakes. |
| **Governance Features** | Standard rose warning box. | Custom Safety Strike meters and Swarm Parliament ballot consensus cards. |
| **Model Telemetry** | Simple card crud profiles. | Telemetry cascades (Primary → Failover → Offline) with latency monitors and test sync connection actions. |
| **Cognitive Modules** | Simple CRUD models. | Support for Constraints and Capabilities modules. |
