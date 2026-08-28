# State Management — Zustand Store

**File:** \stores/crowd-os-store.ts\ (1599 lines)

---

## Architecture

Single monolithic Zustand store. All ~70 actions and ~20 state slices in one \create<CrowdOSState>()\ call.

### Data Entities
- workspaces[], agents[], messages[], modelProfiles[]
- instructionModules[], modelModules[], toolkitModules[]
- runtimeOverrides[], tools[], roles[], archivedChannels[]

### Budget Telemetry
- globalSoftCap (number), perProviderBudget (Record), totalTokensConsumed (number)

### UI State
- activeWorkspaceId, activeChannelId, selectedAgentId, selectedSandboxFile
- rightSidebarOpen, leftSidebarCollapsed, settingsModalOpen, agentProfileModalOpen
- workspaceSettingsTab, chatSearchQuery

### Mobile State
- activeMobileTab, mobileDrawerLeft, mobileDrawerRight

### Async Flags
- isFetchingWorkspaces, isCreatingWorkspace, workspaceError

---

## Key Patterns

### 1. Socket-First Sync
Socket listeners registered inside create() at init:
- \message:new\ -> appends to messages[], increments unread
- \message:stream\ -> appends chunks to stream message
- \gent:status\ / \gent:thinking\ -> updates agent status
- \workspace:sync\ -> triggers fetchWorkspaces()
- \udget:exceeded\ / \udget:warning\ -> triggers fetchBudget()

### 2. Offline Fallback
Every API call wrapped in try/catch. On failure:
- Local state mutations applied
- Mock agent responses simulated via setTimeout chain (800ms/1000ms/1200ms delays)

### 3. localStorage Persistence
Keys: crowdos_active_workspace, crowdos_workspaces, crowdos_agents, crowdos_model_profiles, crowdos_messages
Hydrated on store init.

---

## Initial Seed Data

| Entity | Count | Details |
|---|---|---|
| Workspaces | 1 | CrowdOS Workspace, 3 categories, 6 channels |
| Agents | 5 | Archon Apex (L0), Raven Architect (L1), Crow Orchestrator (L2), Sparrow Runner (L3), Pigeon Gatherer (L3) |
| Messages | 1 | System bootstrap |
| ModelProfiles | 3 | Gemini Pro, Gemini Flash, Claude 3.5 |
| InstructionModules | 4 | L0 surveillance, L1 admin, L2 coordinator, L3 coder |
| ModelModules | 2 | Deep Reasoning, Speed Runner |
| ToolkitModules | 2 | Full Admin Gear, Isolated Exec Deck |
| Tools | 5 | Web Search, Sandbox Exec, Repo Reader, DB Query, Sub-Agent Spawn |
| Roles | 4 | L0 Monitor, L1 Admin, L2 Coordinator, L3 Worker |
