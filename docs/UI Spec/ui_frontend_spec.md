# CrowdOS — UI/Frontend Specification

This document serves as the official **UI/Frontend Specification** for the **CrowdOS** multi-agent orchestration platform. It is designed to guide frontend developers in transitioning the current high-fidelity, mock-data client shell into a fully modular, real-time, socket-integrated orchestration interface.

---

## 1. Architectural System Overview

CrowdOS is built as a single-user cognitive workspace. The frontend follows a high-fidelity **Discord-like layout** merged with **corporate hierarchy indicators**.

### 1.1 Tech Stack
*   **Core**: React 19 + TypeScript + Vite 6
*   **Styling**: Tailwind CSS v4 + `@tailwindcss/vite` + CSS Custom Properties (OKLCH color space)
*   **Component Base**: Radix UI Primitives (via Custom shadcn/ui "New York" template)
*   **State Management**: Zustand 5 (Single monolithic store for real-time reactive updates)
*   **Icons**: Lucide React
*   **Client-Side Routing**: Single-Page App (SPA) utilizing conditional rendering via Zustand state (`activeWorkspaceId`) rather than browser history URLs.

### 1.2 Dual-Architecture & Directory Alignment
The project currently holds legacy Next.js files (under `app/`, `next.config.mjs`) but runs actively on the **Vite SPA engine** (`index.html` → `src/main.tsx` → `src/App.tsx`). 

> [!IMPORTANT]
> All active frontend application code resides at the **root level of the package** (`packages/client/` directories: `/components`, `/stores`, `/types`, `/hooks`, `/lib`), whereas `/src` contains the entry point (`main.tsx`, `App.tsx`, and `styles.css`). Do NOT use the empty placeholder folders inside `/src/components` or `/src/stores`.

```
packages/client/
├── index.html                   # Active Vite Entry Point
├── vite.config.ts               # Active Bundler Configuration
├── src/
│   ├── main.tsx                 # ReactDOM mounting point
│   ├── App.tsx                  # Base layout router
│   └── styles.css               # Active Global CSS Stylesheet (OKLCH variables)
├── components/                  # Active UI Components (58 Radix UI components + custom)
│   ├── portal/                  # Entry WorkspacePortal (DB test, create workspace)
│   ├── ui/                      # shadcn primitives (button, dialog, select, etc.)
│   └── workspace/               # Core application modules
├── stores/                      # Zustand Stores (crowd-os-store.ts)
├── types/                       # TypeScript Types (crowd-os.ts)
└── hooks/                       # Custom react hooks (use-mobile, use-toast)
```

---

## 2. Design System & Premium Aesthetics

CrowdOS uses a customized **Discord Dark** inspired theme based on the `oklch` color space. Surfaces, roles, status states, and active layers are strictly driven by CSS variables defined in `src/styles.css`.

### 2.1 Color Tokens (OKLCH System)
The CSS custom variables map directly onto Tailwind utility classes:

| Variable Name | OKLCH Value | UI Role / Usage |
| :--- | :--- | :--- |
| `--background` | `oklch(0.12 0.01 250)` | Core workspace background (Deep charcoal black) |
| `--sidebar` | `oklch(0.15 0.01 250)` | Left navigation panel surface |
| `--muted` | `oklch(0.24 0.02 250)` | Unfocused items, backgrounds for input cards |
| `--accent` | `oklch(0.58 0.23 260)` | Branding / Discord indigo (Primary buttons, active indicators) |
| `--agent-active` | `oklch(0.68 0.19 145)` | **Active / Working**: Processing, reasoning, typing (🟢 Green) |
| `--agent-thinking` | `oklch(0.79 0.16 85)` | **Thinking**: Waiting on model response (🟡 Yellow) |
| `--agent-sleeping` | `oklch(0.50 0.00 0)` | **Offline / Sleep**: Idle or dismissed state (⚫ Gray) |
| `--role-admin` | `oklch(0.63 0.22 25)` | L0/L1 Authority color highlight (🔴 Red-orange) |
| `--role-coord` | `oklch(0.58 0.23 260)` | L2 Manager Authority color highlight (🔵 Indigo) |
| `--role-worker` | `oklch(0.78 0.18 140)` | L3 worker / supervisor color highlight (🟢 Jade green) |

### 2.2 Micro-Animations & Status Indicators
*   **Presence Dot (`PresenceIndicator.tsx`)**: Circular status indicator with soft pulsing animations.
    *   `thinking` state triggers a continuous keyframe pulse:
        ```css
        @keyframes pulse-glow {
          0%, 100% { opacity: 0.6; transform: scale(0.95); }
          50% { opacity: 1; transform: scale(1.08); filter: drop-shadow(0 0 4px var(--agent-thinking)); }
        }
        ```
*   **Thinking Dots**: Message bubbles from agents in `thinking` state render a stylized three-dot bouncing loading container.
*   **Mobile Slide Drawers (`MobileDrawer.tsx`)**: Transitions use `transform: translate3d(...)` triggered via Radix primitives for GPU-accelerated 60fps sliding behaviors.

---

## 3. UI Component Specifications & Current Implementations

The client shell uses **three primary desktop panels** (Sidebar, Chat Area, Right Profile Sidebar) plus a full-screen entry Portal.

```
+-----------------------------------------------------------------------------+
|  PORTAL (If activeWorkspaceId is null)                                      |
|  [🌐 Workspace Portal] - Join Existing Workspace (test DB URL) or Create    |
+-----------------------------------------------------------------------------+
|  WORKSPACE UI (If activeWorkspaceId is set)                                 |
|  +--------------------+--------------------------------+-----------------+  |
|  | WORKSPACE SIDEBAR  | MAIN CHAT AREA                 | RIGHT SIDEBAR   |  |
|  |                    | [#general]                     | [Agent List]    |  |
|  | - Server Header    |                                |                 |  |
|  |   Dropdown         | - Message Stream               | - Coordinators  |  |
|  | - Category Tree    |   - Human Message              |   (L1/L2)       |  |
|  | - Channels List    |   - Agent Message (Monologue)  | - Workers (L3)  |  |
|  |                    |   - Delegation Card            |   (Status Dots) |  |
|  |                    |   - Tool Execution Badge       |                 |  |
|  |                    | - Rich Message Composer        |                 |  |
|  +--------------------+--------------------------------+-----------------+  |
+-----------------------------------------------------------------------------+
```

### 3.1 Portal View (`WorkspacePortal.tsx`)
A full-screen onboarding component for managing workspace profiles.
*   **Features**:
    *   **Join Workspace**: Input `DATABASE_URL` with an active "Test Connection" trigger. Connecting tests backend database visibility and pulls workspace settings.
    *   **Workspace Creation**: Emoji selector, Name, and optional initialization parameters.
    *   **Storage Fallback**: When the backend is offline, simulates creation and caches configuration lists inside browser `localStorage`.

### 3.2 Left Navigation Panel (`WorkspaceSidebar.tsx`)
A structured channel panel replicating Discord's design.
*   **Features**:
    *   **Workspace Dropdown**: Access to Settings Modal, Category/Channel creation, Workspace ID clipboard helper, and "Leave Workspace" flow.
    *   **Category Tree**: Collapsible custom sections (e.g., "Software Engineering", "Operations"). Clicking categories collapses the nested channels list.
    *   **Channel List**: Specialized icon markers for channel types (Hash `ch-` for chat rooms, Lock for restricted, etc.). Renders reactive **unread badges** (foreground dot) and **mention counts** (red badge).

### 3.3 Central Chat Panel (`MainChatArea.tsx`)
The interaction canvas where operations logs, user commands, and multi-agent monologue lines render sequentially.
*   **Component Composition**:
    *   **Channel Header**: Title, description, and toggles for settings/right sidebar.
    *   **Chat Input Composer (`ChatInput.tsx`)**: Auto-expanding input area that captures user commands. Focuses on preventing locking during heavy agent-to-agent processing streams.
    *   **Message Router (`message.tsx`)**: Resolves incoming messages by their `type` discriminator and routes to specialized bubbles:
        *   `human`: Left-accented card indicating operator instructions.
        *   `agent`: Thematic border container featuring the agent's species indicator, level tag, and optional *Internal Monologue* collapsible panel.
        *   `system`: Centered, low-impact status logs (e.g. "@ResearchLead joined the room").
        *   `delegation`: Renders structured visual cards linking parent-to-child agents, showing the underlying task description, cost tracking, token usages, and status badges.
        *   `tool_execution`: Collapsible execution log detail listing the targeted tool (e.g. `web-search`), parameters payload, status (running/success/error), and execution time in milliseconds.

### 3.4 Right Profile Sidebar (`RightSidebar.tsx`)
The roster panel showing participating workspace entities.
*   **Features**:
    *   **Categorized List**: Groups agents into *Coordinators* (L1 CEO / L2 Managers) and *Workers* (L3 ephemerals).
    *   **Real-time status dots**: Employs the `PresenceIndicator` pulsing states.
    *   **Statistics Panel**: Shows total active tasks, workspace-level token count usage, and budget progress.

---

## 4. Feature Enhancements & Transition to Modular Architecture

To align with the backend's module-first, identity-only agent architecture (defined in `DEVELOPMENT_BOARD.md` Phase 2-4), several frontend modifications must be executed.

### 4.1 Transition: Flat Agent Config ➔ Reusable Modules
Currently, the `Agent` interface in `types/crowd-os.ts` uses legacy flat structures (`skills`, `tools`, inline `model`, etc.). The frontend must transition to referencing **reusable modules** inside the database:

```typescript
// Proposed Client-Side Module Interfaces
export interface InstructionModule {
  id: string;
  label: string;
  systemPrompt: string;
  persona?: string;
  rules?: string[];
  runtimePatchable: boolean;
}

export interface ToolkitModule {
  id: string;
  label: string;
  tools: string[]; // List of enabled tool IDs (e.g., 'file-system', 'terminal')
}

export interface ModelModule {
  id: string;
  label: string;
  provider: 'google' | 'openai' | 'anthropic';
  modelName: string; // Exact string, e.g., 'gemini-2.0-flash'
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}
```

The `Agent` type must be refactored to focus solely on **Identity** and foreign-key references to these modules:
```typescript
export interface Agent {
  id: string;
  name: string;
  species: string;
  level: 0 | 1 | 2 | 3;
  status: AgentStatus;
  avatarUrl?: string;
  instructionModuleId?: string;
  modelModuleId?: string;
  toolkitModuleId?: string;
  parentAgentId?: string; // For spawned L3 worker relationships
}
```

---

## 5. Mockup to Live: Feature Implementations

### 5.1 Model Profile (Model Cards) CRUD (Settings Modal)
Located under the "Model Cards" tab of the `WorkspaceSettingsModal.tsx` component.

```
+--------------------------------------------------------+
| Model Profiles CRUD                                    |
| [ + Create Model Profile ]                             |
|                                                        |
| +----------------------------------------------------+ |
| | Flagship Reasoning (anthropic)         [Edit] [Del] | |
| | Model: claude-sonnet-4-20250514                    | |
| | Key Configured: [Yes]    Base URL: (Default)       | |
| +----------------------------------------------------+ |
| | Gemini Flash Profile (google)          [Edit] [Del] | |
| | Model: gemini-2.0-flash                            | |
| | Key Configured: [Yes]    Base URL: (Default)       | |
| +----------------------------------------------------+ |
+--------------------------------------------------------+
```

*   **UI Form Requirements (`ModelCardForm.tsx`)**:
    *   **Provider Dropdown**: Google, OpenAI, Anthropic, Custom.
    *   **Exact Model Name Input**: Mono-spaced text field. System prompt validation blocks model modification side-effects.
    *   **API Key Field**: Obfuscated type (`password`), featuring a visibility toggle button.
    *   **Base URL (Optional)**: Support custom endpoints (essential for Ollama or local gateways).
    *   **Test Connection Button**: Triggers a POST to `/api/providers/test` sending input credentials. Animates a spinner, showing success checkmark or error tooltip on completion.

### 5.2 Agent Creation & Configuration UI
Currently, the settings modal contains a static list of agents. The system requires an **Agent Creation Form** mapping the modular structure.

```
+--------------------------------------------------------------------+
| Create New Agent                                                   |
|                                                                    |
| 1. IDENTITY                                                        |
|    Name: [ Arch_Builder       ] (No spaces, underscores only)      |
|    Species: [ Fox-type Architect  ]                                |
|    Authority Level: ( ) L1 CEO  (o) L2 Manager  ( ) L3 Worker      |
|                                                                    |
| 2. COGNITIVE ASSEMBLY                                              |
|    Instruction Module: [ Standard Coordinator  [v] ] [+ Create]    |
|    Model Module:       [ Flagship Reasoning    [v] ] [+ Create]    |
|    Toolkit Module:     [ Development Tools     [v] ] [+ Create]    |
|                                                                    |
| [ Cancel ]                                         [ Save Agent ]  |
+--------------------------------------------------------------------+
```

*   **Validation Rules**:
    *   **Agent Name**: Strictly alphanumeric plus underscores. No spaces permitted (breaks LLM @mention tokenization).
    *   **Module Selectors**: Renders a dropdown list of fetched modules. Features a `[+ Create New]` button that pops up the respective module editor in an inline drawer.
    *   **Access Scoping**: Multi-select checklist for assigning standard channels the agent joins upon initialization.

### 5.3 Runtime Override UI (Agent Profile Modals)
When viewing an agent's details in `AgentProfileModal.tsx`, active overrides must be managed dynamically to avoid mutating permanent configurations.

```
+------------------------------------------------------------+
| Agent Profile - ResearchLead                               |
| Species: Owl-type Coordinator    Level: L2                 |
|                                                            |
| +-- Active Runtime Overrides ----------------------------+ |
| | Type: Instruction Patch                                | |
| | Reason: Focus on Tailwind v4 CSS specs                 | |
| | [ Revert Override ]                                    | |
| +--------------------------------------------------------+ |
|                                                            |
| [ + Apply Custom Behavior Patch ]                          |
+------------------------------------------------------------+
```

*   **UI Elements**:
    *   **Override List**: Shows active temporary instructions or sandbox permission rules.
    *   **Revert Controls**: Clear button to send a POST/DELETE to `/api/runtime/overrides/:id` to quickly restore the default module configurations.
    *   **Expiration Badge**: Shows countdown timers for temporary patches configured with an `expiresAt` key.

### 5.4 Real-time Socket.io Integration
The application currently runs completely on local simulated state inside Zustand. The store (`crowd-os-store.ts`) must hook into real-time websocket streams.

```
+------------------------------------------------------------+
| Chat Window                                                |
|                                                            |
| [Agent] DocSpecialist: Working on structural layouts...    |
|                                                            |
| * Architect is thinking...                                 |
|   [===============================>            ] 72% Tokens|
+------------------------------------------------------------+
```

*   **Listeners Map (`useSocket.ts`)**:
    *   `message:new` ➔ Triggers `addMessage()` action, inserting new bubbles instantly into the message thread.
    *   `message:stream` ➔ Appends token updates to the active target bubble matching `messageId` for a typewriter effect.
    *   `agent:thinking` ➔ Mutates target agent status to `thinking` to trigger the `pulse-glow` presence indicator.
    *   `agent:status` ➔ Dynamic updates for online, idle, or sleeping states in both sidebars.
    *   `agent:spawned` / `agent:despawned` ➔ Ephemeral L3 Worker fade-in/fade-out animations in the channel roster list.
    *   `budget:warning` / `budget:exceeded` ➔ Triggers toast banners notifying the operator of budget caps.

### 5.5 @Mention Autocomplete Dropdown
The composer input must parse user inputs to autocomplete agent names.

```
  +-------------------------------+
  | Select Agent to Mention       |
  | @Architect     (L1 CEO)    🟢 |
  | @ResearchLead  (L2 Mgr)    🟡 |
  | @BackendWorker (L3 Dev)    ⚫ |
  +-------------------------------+
  [ Write a message... @Res       ]
```

*   **Keyboard Navigation**:
    *   Typing `@` fires the mention overlay at the input text caret position.
    *   Up/Down Arrow keys change selected indices.
    *   `Enter` replaces the text snippet with a styled mention tag: `@Architect` representing the structured payload format:
        ```json
        {
          "type": "agent",
          "targetId": "agent-1",
          "targetName": "Architect"
        }
        ```
    *   `Escape` closes the dropdown frame.

---

## 6. Mobile Layout & Responsive Support

To accommodate on-the-go workspace monitoring, the system provides a specialized **mobile view layout** that swaps the 3-panel layout for an overlay-drawer design.

```
  +-------------------------+
  | = #general          [+] | <-- Header: Burger toggles Left Drawer
  |-------------------------|
  |                         |
  |  Mobile Message Stream  |
  |                         |
  |-------------------------|
  | [Ch] [Chat] [Ag] [Set]  | <-- Bottom Navigation Bar (BottomNav)
  +-------------------------+
```

*   **Left Drawer**: Accessible via a hamburger button in the TopBar. Houses the `WorkspaceSidebar` tree in an overlay mode.
*   **Right Drawer**: Houses the `RightSidebar` containing active agents, showing status dots on swipe gestures.
*   **Bottom Navigation (`BottomNav.tsx`)**: Replaces complex workspace interactions with high-level nav tabs:
    1.  `channels` ➔ Slides the Left Drawer open.
    2.  `chat` ➔ Focuses the active channel's message stream.
    3.  `agents` ➔ Slides the Right Drawer roster open.
    4.  `settings` ➔ Displays workspace configuration.

---

## 7. Verification & Implementation Plan

To safely transition the client shell into active modular development, the execution should proceed sequentially:

### Phase A: Architecture Transition & Refactoring
*   [ ] Refactor `types/crowd-os.ts` to support the 3-module entity structure (`InstructionModule`, `ModelModule`, `ToolkitModule`).
*   [ ] Add `ModelProfile` field parameters directly into the Zustand store configurations.

### Phase B: Socket.io Client Implementation
*   [ ] Install `socket.io-client` package.
*   [ ] Create `/hooks/useSocket.ts` to manage event routing and hook store state actions directly to incoming socket emissions (`message:stream`, `agent:thinking`, `agent:status`).

### Phase C: Module-First UI Components
*   [ ] Implement the `ModelCardForm` testing API triggers and visual response flags.
*   [ ] Build the multi-select dropdown `ToolkitModuleSelector` showing granular sandboxed commands list.
*   [ ] Integrate the **Agent Creation Form** validating unique alphanumeric handles.

### Phase D: Interactions & polish
*   [ ] Build the carets-aware `@mention` overlay popup mapping keyboard index selections.
*   [ ] Implement collapsed internal monologue details toggle containers for agent message bubbles.
