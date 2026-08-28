# 🎨 Deep Planning: Pillar 3 — Agent Studio, Lego-Style Manifest Builder & Developer Experience

> **Document ID:** DEEP_PLAN_PILLAR_3_AGENT_STUDIO_AND_DX  
> **Status:** Approved Architecture Specification  
> **Target Version:** CrowdOS Modular 2.0  
> **Owner:** AI Agent Systems Architect & Frontend/DX Team  

---

## 1. Executive Summary & Objective

A modular backend architecture is only as powerful as its usability. If developers and operators must manually edit database tables or JSON configs to swap out tools, modify instruction stacks, or connect MCP servers, the system fails the "plug-and-play" promise.

The goal of **Pillar 3** is to build the **CrowdOS Agent Studio & Developer Experience (DX) Suite**:
1. A visual **Lego-Style Agent Manifest Builder** where operators configure agents by snapping together modular cognitive slots (Model, Instructions, Skills, Tools, Constraints, Memory).
2. A **Module Warehouse** for browsing, previewing, testing, and managing reusable cognitive bricks across workspaces.
3. An interactive **Skill & Tool Forge** with built-in MCP server discovery and OpenAPI/JS dynamic tool testing.
4. An **Agent Playground & Live Inspector** for simulating prompt assembly, inspecting token breakdowns, streaming intermediate reasoning thoughts, and debugging tool invocations in real-time.
5. **Zero-Downtime Hot-Swapping** via real-time WebSocket protocol (workspace:sync, gent:patch).

---

## 2. The Slot-Based Agent Manifest Model (UI Metaphor)

In the Agent Studio UI, an Agent is represented as an interactive **Modular Rack** with dedicated slots:

`
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              AGENT STUDIO: @Raven (L1 CEO)                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [🧠 Model Slot]         │  Gemini 2.0 Flash ▾  (Temp: 0.7, MaxTokens: 4096)  [Test]   │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ [📜 Instruction Stack]   │  1. ⚓ Base Persona (CrowdOS Executive)           [Edit] [x] │
│                         │  2. 🏢 Enterprise Governance Rules                [Edit] [x] │
│                         │  3. 📝 ReAct Sentinel Formatting Protocol         [Edit] [x] │
│                         │  [+ Drag & Drop New Instruction Brick from Warehouse]        │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ [🎯 Skills Pack]        │  • ⚡ Database Architecture Specialist           [Config][x]│
│                         │  • 🔍 Multi-Sector Research & Indexing          [Config][x]│
│                         │  [+ Add Skill Pack]                                          │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ [🛠️ Tools & MCP]        │  • 📁 VFS Workspace File System (Native)         [Active]    │
│                         │  • 🐙 GitHub MCP Server (14 Tools Connected)     [Active]    │
│                         │  • 💾 Continuum Memory Note Vault (3 Tools)      [Active]    │
│                         │  [+ Mount Tool / Connect MCP Server]                         │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ [🛡️ Constraints & Rules]│  • 🚫 Block Destructive Bash Commands             [Strict]   │
│                         │  • 🔒 Enforce Category Owner Permissions         [Active]   │
├─────────────────────────┼──────────────────────────────────────────────────────────────┤
│ [💾 Memory Adapter]     │  • Continuum Multi-Lane Vault (Top-K: 10)                    │
│                         │  • Sliding Window History (Recent: 30 Turns)                 │
└─────────────────────────┴──────────────────────────────────────────────────────────────┘
`

---

## 3. Frontend Component Architecture (Vite + React + Tailwind)

`
packages/client/src/
├── components/
│   ├── studio/
│   │   ├── AgentStudioCanvas.tsx         # Main interactive slot rack
│   │   ├── ModelSlotCard.tsx             # Provider selection, API key & params
│   │   ├── InstructionStackEditor.tsx    # Drag-and-drop reorderable instruction layers
│   │   ├── SkillPickerModal.tsx          # Catalog modal for attaching skills
│   │   ├── ToolMcpManager.tsx            # Tool selector & MCP connection status
│   │   ├── ConstraintGuardEditor.tsx     # Negative rules & permission switches
│   │   └── MemoryConfigCard.tsx          # Multi-lane & sliding window tuning
│   ├── warehouse/
│   │   ├── ModuleWarehouseView.tsx       # Grid view of all reusable bricks
│   │   ├── InstructionModuleEditor.tsx   # Markdown editor with live token estimation
│   │   ├── DynamicToolCreator.tsx        # JavaScript / OpenAPI tool editor + test runner
│   │   ├── McpServerConnector.tsx        # Form to add npx / SSE MCP servers
│   │   └── SkillPackageBuilder.tsx       # Composite skill authoring suite
│   └── inspector/
│       ├── AgentPlayground.tsx           # Real-time chat testing sandbox
│       ├── PromptContextInspector.tsx    # Raw compiled prompt debugger (Tabbed XML view)
│       └── ExecutionTimeline.tsx         # ReAct iterations, thoughts, and tool durations
`

---

## 4. Key Studio Subsystems & Features

### 4.1 Instruction Stack Editor (Drag & Drop Middleware Composition)
- Uses @dnd-kit/core to allow operators to reorder instruction bricks visually.
- Live token counter calculates prompt weight in real-time as layers are added.
- Quick toggle switch on each layer to enable/disable without deleting.

### 4.2 Tool & MCP Server Forge
- **1-Click MCP Connect**: Enter 
px -y @modelcontextprotocol/server-github and API token $\rightarrow$ CrowdOS runs probe, extracts all 14 tool schemas, and registers them into the active workspace catalog.
- **Dynamic JS Tool Tester**: In-browser Monaco editor for writing custom tools with built-in schema generator and mock payload execution test button.

### 4.3 Context & Token Inspector (The "X-Ray View")
- Provides a split-screen debug view:
  - **Left**: Live simulated conversation with agent.
  - **Right**: Real-time X-Ray showing:
    - Block-by-block token breakdown (Identity vs Instructions vs Skills vs Tools vs Memory vs History).
    - Raw compiled prompt sent to the LLM.
    - Demultiplexed stream: Thought stream in purple scratchpad, tool calls in terminal box, final response in standard message bubble.

---

## 5. Live Runtime Synchronization Protocol (WebSockets)

When an operator edits an agent in Agent Studio, changes are pushed instantly to the running server via Socket.io:

`mermaid
sequenceDiagram
    autonumber
    actor Dev as Operator (Agent Studio UI)
    participant UI as React Client Store
    participant Srv as registerSocketServer
    participant RE as RuntimeExecutor
    participant DB as PostgreSQL Database

    Dev->>UI: Drags new Instruction Module into Stack & Clicks Save
    UI->>Srv: emit("agent:update_manifest", { agentId, modelModuleId, instructionStack, tools, skills })
    Srv->>DB: Update agent_instruction_stacks & agent_tools
    Srv->>RE: Invalidate cached ContextPacket for agentId
    Srv->>UI: emit("agent:manifest_updated", { agentId, version: 2 })
    Srv->>UI: emit("workspace:sync", { scope: "agent_studio" })
    Note over Dev,Srv: Next user message immediately uses the new instruction stack with zero downtime!
`

---

## 6. REST API Endpoints Specification

| Method | Endpoint | Description | Payload / Query |
| :--- | :--- | :--- | :--- |
| GET | /api/studio/agents/:id/manifest | Get complete resolved manifest (Model, Stack, Skills, Tools, Memory) | None |
| PUT | /api/studio/agents/:id/manifest | Update agent slot attachments atomically | AgentManifestUpdateBody |
| POST | /api/studio/inspect-prompt | Dry-run context assembly without calling LLM | { agentId, channelId, userInput } |
| GET | /api/mcp/servers | List all configured MCP servers and live statuses | None |
| POST | /api/mcp/servers | Register and probe a new MCP server | { name, transport, command, args, url } |
| POST | /api/mcp/servers/:id/sync | Force re-discovery of MCP server tool definitions | None |
| POST | /api/tools/test-dynamic | Test execute a dynamic JS / OpenAPI tool | { scriptContent, parameters, testArgs } |

---

## 7. Implementation Steps & Verification Matrix

- [ ] **Step 3.1**: Create backend Studio API routes in packages/server/src/routes/studio.ts and outes/mcp.ts.
- [ ] **Step 3.2**: Implement AgentStudioCanvas and slot card components in packages/client/src/components/studio/.
- [ ] **Step 3.3**: Implement InstructionStackEditor with reorderable drag-and-drop layers.
- [ ] **Step 3.4**: Build ToolMcpManager and McpServerConnector for 1-click external tool discovery.
- [ ] **Step 3.5**: Build AgentPlayground and PromptContextInspector for real-time prompt debugging and thought streaming.
- [ ] **Step 3.6**: End-to-End Test: Assemble an agent from scratch in UI, attach GitHub MCP server, inspect compiled context, and verify real execution.
