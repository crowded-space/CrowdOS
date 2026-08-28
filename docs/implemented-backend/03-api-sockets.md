# API Endpoints & Socket Events

---

## Health

GET /health -> { status: "ok", service: "CrowdOS" }

---

## Agents (/api/agents)

GET  /api/agents              -> AgentProfile[]
     ?authorityLevel=0-3&status=...&isTemplate=true/false

GET  /api/agents/:id          -> AgentProfile | 404

POST /api/agents              -> 201 AgentProfile
Body: { name, title, species?, avatar?, authorityLevel, modelModuleId, instructionModuleId, toolkitModuleId?, constraintsModuleId?, capabilitiesModuleId?, isOmniscient?, permissions?, memorySharingPolicy? }

PUT  /api/agents/:id          -> AgentProfile
Body: { name?, title?, species?, avatar?, authorityLevel?, modelModuleId?, instructionModuleId?, toolkitModuleId?, isOmniscient?, permissions?, memorySharingPolicy? }

DELETE /api/agents/:id        -> 204 | 404

---

## Modules (/api/modules)

GET  /api/modules             -> { modelModules[], instructionModules[], toolkitModules[], constraintsModules[], capabilitiesModules[] }

Per-type CRUD (5 module types x 6 ops each):

GET    /api/modules/{type}           -> list
GET    /api/modules/{type}/:id       -> get by id | 404
POST   /api/modules/{type}           -> 201 created
PUT    /api/modules/{type}/:id       -> updated | 404
DELETE /api/modules/{type}/:id       -> 204 | 404
POST   /api/modules/model/:id/test   -> { success: boolean, message: string }

Module types: model, instruction, toolkit, constraints, capabilities

ModelModule fields: label, provider, modelName, apiKey?, endpointUrl?, temperature, topP, maxOutputTokens, stopSequences?, maxRecentMessages?, enableCompression?, compressionThreshold?

InstructionModule fields: label, base (string[]), runtimePatchable?

ToolkitModule fields: label, tools (string[])

ConstraintsModule fields: label, rules (string[]), disallowedActions (string[])

CapabilitiesModule fields: label, skills (string[]), functionSchemas (Record[])

---

## Legacy Providers (/api/providers)

GET  /api/providers           -> { generation[], embedding[], indexing[] }

Per-type CRUD (3 types x 6 ops):

GET    /api/providers/{type}           -> list
GET    /api/providers/{type}/:id       -> get | 404
POST   /api/providers/{type}           -> 201
PUT    /api/providers/{type}/:id       -> update | 404
DELETE /api/providers/{type}/:id       -> 204 | 404
POST   /api/providers/generation/:id/test -> { success, message }

Types: generation, embedding, indexing

---

## Categories (/api/categories)

GET    /api/categories         -> Category[] (with nested channels[])
POST   /api/categories         -> 201
Body: { name, createdBy, position? }

DELETE /api/categories/:id     -> 204 | 404

---

## Channels (/api/channels)

GET    /api/channels           -> Channel[]

POST   /api/channels           -> 201
Body: { categoryId?, name, createdBy?, position? }

PATCH  /api/channels/:id       -> Channel
Body: { name?, type? (standard|archived), position? }

DELETE /api/channels/:id       -> 204 | 404

---

## Messages (/api/channels/:channelId/messages)

GET /api/channels/:channelId/messages    -> ChannelMessage[]
     ?includeMonologue=true

---

## Workspace (/api/workspace)

GET  /api/workspace/settings           -> WorkspaceSettings
PUT  /api/workspace/settings           -> update workspace settings

GET  /api/workspace/budget             -> { globalSoftCap, perProviderBudget, providers: { used, softCap, resetPeriod }[] }
PUT  /api/workspace/budget             -> { globalSoftCap?, perProviderBudget? }
POST /api/workspace/budget/reset       -> 200 (resets all provider usage to 0)

POST /api/workspace/database           -> verify/hot-reload DB connection
Body: { databaseUrl }

---

## Socket Events

### Server -> Client (all forwarded via EventBroker -> Socket.io)

agent:status       { agentId, status: RuntimeStatus }
message:new        ChannelMessage
message:stream     { channelId, agentId, chunk }
agent:thinking     { agentId, channelId }
agent:spawned      { pairs: string[], channelId, batchNum }
agent:despawned    { agentId }
agent:paused       { agentId, reason }
runtime:override   { agentId, override: RuntimeOverride }
runtime:state      { agentId, state: RuntimeState }
escalation         { channelId, fromAgent, reason }
budget:warning     { profileId, usage, cap }
budget:exceeded    { profileId, pausedAgents }
workspace:sync     { }

### Client -> Server

user:message       { channelId, content, mentions: string[] }

### user:message Handler Flow
1. Parse mentions via MentionParser
2. Persist message to DB (with sequence number)
3. Emit message:new via EventBroker
4. If mentions exist: trigger mentioned agent's runtime
5. If no mentions + channel is #general: trigger all L0 agents
6. On error: broadcast system warning + escalation
