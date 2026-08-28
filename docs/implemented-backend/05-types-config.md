# Types, Config & Environment

---

## 1. Type Definitions (src/types/)

12 type files defining the full backend type system:

### agent.types.ts
AgentProfile { id, name, title, species?, avatar?, authorityLevel(0-3), l3Subtype?, modelModuleId, instructionModuleId, toolkitModuleId?, constraintsModuleId?, capabilitiesModuleId?, memorySharingPolicy, isOmniscient, fallbackAgentId?, categoryPerms, permissions, status, isTemplate, createdAt, updatedAt }

CreateAgentProfileInput { name, title, species?, avatar?, authorityLevel, modelModuleId, instructionModuleId, toolkitModuleId?, constraintsModuleId?, capabilitiesModuleId?, isOmniscient?, permissions?, memorySharingPolicy? }

UpdateAgentProfileInput { name?, title?, species?, avatar?, authorityLevel?, modelModuleId?, instructionModuleId?, toolkitModuleId?, isOmniscient?, permissions?, memorySharingPolicy? }

### message.types.ts
ChannelMessage { id, channelId, authorId, authorName, authorLevel, authorType(user|agent|system), content, mentions: MentionMetadata[], isInternalMonologue, sequenceNumber, timestamp }

### channel.types.ts
Category { id, name, ownedByAgentId?, channels: Channel[] }
Channel { id, categoryId?, name, type, position }
ChannelIndex { channelId, channelPath, topicSummary, lastIndexedAt, msgCountSinceIndex }
CompressedSummary { id, channelId, summary, coversUpToSeq, createdAt }

### module.types.ts
ModelModule { id, label, provider, modelName, apiKey?, endpointUrl?, temperature, topP, maxOutputTokens, stopSequences?, maxRecentMessages?, enableCompression?, compressionThreshold?, createdAt, updatedAt }

InstructionModule { id, label, base: string[], runtimePatchable, createdAt, updatedAt }

ToolkitModule { id, label, tools: string[], createdAt, updatedAt }

ConstraintsModule { id, label, rules: string[], disallowedActions: string[], createdAt, updatedAt }

CapabilitiesModule { id, label, skills: string[], functionSchemas: Record[], createdAt, updatedAt }

### provider.types.ts
GenerationModelProfile { id, label, provider, modelName, apiKey?, endpointUrl?, temperature, topP, maxOutputTokens, ... }

### runtime.types.ts
RuntimeOverride { id, targetAgentId, overrideType, instructionPatch?: InstructionPatch, permissionPatch?: PermissionPatch, createdBy, expiresAt?, createdAt }

RuntimeState { sessionId, agentId, status, activeTask?, activeChannelId?, startedAt?, overridesApplied: string[], errorInfo?, lastHeartbeat?, createdAt }

InstructionPatch { appendInstruction?: string, replaceBaseInstructions?: string[], temporaryRules?: string[] }

### task.types.ts
SubtaskDefinition { id, title, description, priority }
SpawnRequest { id, requestedBy, channelId, workerTemplate, spvTemplate, failurePolicy, maxRetries, subtasks: SubtaskDefinition[], status, createdAt }
TaskFile { id, spawnRequestId, subtaskId, title, content, workerAgentId, spvAgentId, status, createdAt }

### tool.types.ts
ToolDefinition { id, name, description, handlerId, jsonSchema, dangerLevel, authLevelRequired }
ToolCall { toolId, input, timestamp }

### mention.types.ts
MentionType: direct | implied | broadcast
MentionMetadata { agentId, agentName, mentionType, confidence, originalText }

### event.types.ts
BrokerEventMap — maps every event name to its payload type
SocketServerToClientEvents — same map for Socket.io typing
SocketClientToServerEvents — { userMessage: { channelId, content, mentions } }

### workspace.types.ts
Workspace { id, name, ownerId, status, rootPath, permissions, constraints, metadata, createdAt, updatedAt }
WorkspaceNode { id, workspaceId, path, name, type, mimeType, size, checksum, ... }

---

## 2. Environment Configuration (src/config/env.ts)

.env variables validated via Zod:

| Variable | Default | Description |
|---|--|--|
| PORT | 3001 | Server listen port |
| DATABASE_URL | postgresql://... | PostgreSQL connection string |
| CLIENT_ORIGIN | http://localhost:5173 | CORS origin |
| LOG_LEVEL | info | pino log level |

---

## 3. Database Connection (src/config/database.ts)

Singleton pattern:
- sqlClient: postgres.js instance (lazy init)
- dbInstance: Drizzle ORM wrapper (lazy init)
- getDb(): returns Drizzle instance, creates if needed
- getSqlClient(): returns raw postgres.js client
- ensurePgVectorExtension(): CREATE EXTENSION IF NOT EXISTS vector
- closeDatabaseConnection(): end all connections

---

## 4. Bootstrap & Seed

### bootstrap.ts
Raw SQL table creation for all enums and tables.
Used as fallback when drizzle-kit push is unavailable.

### seed.ts
Seeds default data matching the frontend seed:
- 5 agents (Archon Apex L0, Raven Architect L1, Crow Orchestrator L2, Sparrow Runner L3, Pigeon Gatherer L3)
- 2 model_modules (Deep Reasoning, Speed Runner)
- 4 instruction_modules (L0-L3)
- 2 toolkit_modules (Full Admin, Isolated Exec)
- 3 categories with 6 channels total
- 1 default workspace_settings entry
- 5 tool definitions (web.search, sandbox.exec, github.read, db.query, agent.orchestrate)
