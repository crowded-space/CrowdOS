# Types, API & Socket Layer

---

## 1. Type System (types/crowd-os.ts, 168 lines)

### Core Entities
\\\
Agent           { id, name, species, level(0-3), status, instructionModuleId, modelModuleId, toolkitModuleId, parentId, roleId, isOmniscient }
Workspace       { id, name, icon, dbUrl, categories[], channels[] }
Channel         { id, name, description, unreadCount, hasMention }
Category        { id, name, collapsed, channels[] }
Message         { id, type, content, authorId, authorName, channelId, mentions?, delegationInfo?, toolExecution?, attachments? }
ModelProfile    { id, label, provider(google|openai|anthropic), modelName, apiKeyConfigured }
InstructionModule { id, name, systemPrompt, persona?, rules?, sandboxPath? }
ModelModule     { id, name, modelProfileId, provider?, temperature?, maxTokens?, apiKey? }
ToolkitModule   { id, name, enabledToolIds[], sandboxConfig? }
RuntimeOverride { id, agentId, type(instruction|model|toolkit), patch, reason?, expiresAt?, active }
Tool            { id, name, category, description, enabled, usageCount }
Role            { id, name, color, permissions[] }
\\\

### Union Types
\\\
AgentStatus  = 'active' | 'idle' | 'thinking' | 'delegating' | 'executing' | 'sleeping'
AgentLevel   = 0 | 1 | 2 | 3
MessageType  = 'human' | 'agent' | 'system' | 'governance' | 'delegation' | 'tool_execution'
ProviderType = 'google' | 'openai' | 'anthropic'
\\\

### Sub-types
\\\
DelegationInfo { id, fromAgentId, toAgentId, task, status, tokens, cost }
ToolExecution  { name, input, output?, durationMs, status }
Attachment     { id, name, type, url, size? }
\\\

---

## 2. REST API (all fetch() to http://localhost:3001)

### Database
POST /api/workspace/database   # Test/verify DB connection

### Workspace
GET  /api/workspace/budget      # Fetch budget telemetry
PUT  /api/workspace/budget      # Update global/per-provider budget
POST /api/workspace/budget/reset  # Reset counters

### Categories
GET    /api/categories          # List all
POST   /api/categories          # Create
DELETE /api/categories/:id      # Delete

### Channels
GET    /api/channels            # List all
POST   /api/channels            # Create
DELETE /api/channels/:id        # Delete
PATCH  /api/channels/:id        # Archive/restore (type: archived|standard)
GET    /api/channels/:id/messages  # Fetch messages

### Agents
GET    /api/agents              # List all
POST   /api/agents              # Create
PUT    /api/agents/:id          # Update
DELETE /api/agents/:id          # Delete

### Modules
GET    /api/modules             # List all (instruction/model/toolkit)
POST   /api/modules/instruction | /model | /toolkit
PUT    /api/modules/instruction/:id | /model/:id | /toolkit/:id
DELETE /api/modules/instruction/:id | /model/:id | /toolkit/:id
POST   /api/modules/model/:id/test  # Test model connection

### Providers (Model Profiles)
GET    /api/providers/generation
POST   /api/providers/generation
PUT    /api/providers/generation/:id
DELETE /api/providers/generation/:id

---

## 3. Socket Events

### Client -> Server
event: user:message
payload: { channelId, content, mentions[] }

### Server -> Client
event: message:new       -> Appends to messages[], updates unread/mentions
event: message:stream    -> Appends chunk to stream-{agentId} message
event: agent:status      -> Updates agent status + lastActive
event: agent:thinking    -> Sets agent status to 'thinking'
event: workspace:sync    -> Triggers full fetchWorkspaces()
event: budget:exceeded   -> Triggers fetchBudget()
event: budget:warning    -> Triggers fetchBudget()
