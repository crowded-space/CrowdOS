# Identifier Index - CrowdOS Project

> Purpose: Complete register of every type, interface, enum, class, component, store slice, route, socket event, DB table, tool definition, workspace primitive, and document across the monorepo.

---

## 1. Package: packages/shared - Shared Types & Events

### Module Schemas (shared/index.ts)

| Identifier | Kind | Description |
|---|---|---|
| ProviderEngine | type alias | `"google" \| "openai" \| "anthropic" \| "ollama" \| "custom"` |
| ProviderEngineSchema | Zod enum | Runtime validator |
| ModelModule | interface | LLM config: provider, modelName, temperature, topP, maxOutputTokens, stopSequences, maxRecentMessages, enableCompression, compressionThreshold |
| ModelModuleSchema | Zod object | Runtime validator |
| InstructionModule | interface | System prompt config: base string[], runtimePatchable |
| InstructionModuleSchema | Zod object | Runtime validator |
| ToolkitModule | interface | Tool permission set: tools string[] |
| ToolkitModuleSchema | Zod object | Runtime validator |
| ConstraintsModule | interface | Safety rules: rules string[], disallowedActions string[] |
| ConstraintsModuleSchema | Zod object | Runtime validator |
| CapabilitiesModule | interface | Skill declarations: skills string[], functionSchemas Record[] |
| CapabilitiesModuleSchema | Zod object | Runtime validator |

### Runtime Contracts (shared/index.ts)

| Identifier | Kind | Description |
|---|---|---|
| AgentStatus | type alias | 9-state: active, idle, thinking, delegating, executing, sleeping, working, paused, offline |
| AgentStatusSchema | Zod enum | Runtime validator |
| AgentRuntimeState | interface | sessionId, agentId, status, activeTask, activeChannelId, startedAt, overridesApplied, errorInfo, lastHeartbeat |
| AgentRuntimeStateSchema | Zod object | Runtime validator |
| SwarmState | interface | swarmId, name, status, members[], activeTasksCount |
| SwarmStateSchema | Zod object | Runtime validator |
| ConspiracyState | interface | conspiracyId, topic, members[], consensusReached |
| ConspiracyStateSchema | Zod object | Runtime validator |
| WorkspacePermissions | interface | network, shell, maxAgents |
| WorkspacePermissionsSchema | Zod object | Runtime validator |
| RuntimeConstraints | interface | networkAccess, shellExecution, memoryLimitMb, cpuLimit |
| RuntimeConstraintsSchema | Zod object | Runtime validator |
| WorkspaceRuntimeState | interface | 6-state workspace lifecycle status |
| WorkspaceRuntimeStateSchema | Zod object | Runtime validator |
| SandboxState | interface | sandboxId, workspaceId, status (idle/busy/crashed), activeProcesses[], memoryUsedMb, cpuUsagePercent |
| SandboxStateSchema | Zod object | Runtime validator |

### Event Schemas (shared/index.ts)

| Identifier | Kind | Description |
|---|---|---|
| AgentSpawnedEvent | type | agentId, name, level, workspaceId, timestamp |
| AgentLifecycleEvent | type | agentId, action (spawn/pause/resume/terminate/recover/handoff/delegate), workspaceId |
| EscalationEvent | type | id, type (warning/loop_detected/soft_cap_approaching/budget_exceeded/parliament_escalation), agentId, message, details |
| SandboxUpdatedEvent | type | sandboxId, workspaceId, path, changeType (create/modify/delete) |
| WorkspacePatchedEvent | type | workspaceId, patch, timestamp |
| RuntimeSnapshotEvent | type | Full snapshot: workspaces[], agents[], swarms[], escalations[], sandboxes[], overrides[], runtimeHealth |

### Runtime Events (shared/events/runtime-events.ts)

| Identifier | Kind | Description |
|---|---|---|
| RuntimeEvents | const object | Event string constants (32 events via Phase 7) |
| RuntimeEventType | type alias | Union of all event strings |

Events: AGENT_SPAWNED, AGENT_DESPAWNED, AGENT_PAUSED, AGENT_RESUMED, AGENT_LIFECYCLE, RUNTIME_STATE, RUNTIME_SNAPSHOT, RUNTIME_OVERRIDE, WORKSPACE_PATCHED, WORKSPACE_SNAPSHOT, SANDBOX_UPDATED, SANDBOX_STREAM, SANDBOX_PROCESS, SWARM_CREATED, SWARM_UPDATED, SWARM_TERMINATED, ESCALATION_CREATED, ESCALATION_UPDATED, ESCALATION_RESOLVED, BUDGET_WARNING, BUDGET_EXCEEDED, RUN_STATUS_CHANGED, RUN_QUEUED, RUN_COMPENSATIONS, INDEX_DEGRADED, SCHEDULED_TRIGGERED, APPROVAL_REQUESTED, APPROVAL_DECIDED, DELEGATION_START, DELEGATION_COMPLETED, ARTIFACT_CREATED, DIFF_CREATED, ARTIFACT_UPDATED

---

## 2. Package: packages/server - Backend

### 2.1 Type Definitions (server/src/types/)

#### agent.types.ts
| Identifier | Kind | Description |
|---|---|---|
| AuthorityLevel | type | `0 \| 1 \| 2 \| 3` (L0-L3) |
| AgentStatus | type alias | Re-export from RuntimeStatus: idle, working, paused, offline |
| MemorySharingPolicy | type | none, horizontal, vertical, full |
| L3Subtype | type | worker, supervisor |
| AgentAuthorityPermissions | interface | spawnAgents, patchRuntime, accessAllChannels |
| AgentProfile | interface | Core identity: id, name, title, species, avatar, authorityLevel, l3Subtype, 5 module refs, memorySharingPolicy, isOmniscient, fallbackAgentId, categoryPermissions, permissions, status, isTemplate |
| CreateAgentProfileInput | interface | Input for creating an agent |
| UpdateAgentProfileInput | interface | Partial update input |
| AgentRegistryFilters | interface | authorityLevel, status, isTemplate |

#### channel.types.ts
| Identifier | Kind | Description |
|---|---|---|
| ChannelType | type | standard, pair_private, archived |
| Category | interface | id, name, ownedByAgentId, createdBy, embeddingProfileId, position |
| Channel | interface | id, categoryId, name, type, createdBy, position, archivedAt |
| ChannelIndex | interface | channelId, channelPath, topicSummary, lastIndexedAt, messageCountSinceIndex |
| CompressedSummary | interface | id, channelId, summary, coversUpToSeq |

#### event.types.ts
| Identifier | Kind | Description |
|---|---|---|
| AgentStatusEventPayload | interface | agentId, status |
| MessageStreamEventPayload | interface | channelId, agentId, chunk |
| AgentThinkingEventPayload | interface | agentId, channelId |
| AgentSpawnedEventPayload | interface | pairs[], channelId, batchNum |
| AgentDespawnedEventPayload | interface | agentId |
| AgentPausedEventPayload | interface | agentId, reason |
| RuntimeOverrideEventPayload | interface | agentId, override |
| RuntimeStateEventPayload | interface | agentId, state |
| EscalationEventPayload | interface | channelId, fromAgent, reason |
| BudgetWarningEventPayload | interface | profileId, usage, cap |
| BudgetExceededEventPayload | interface | profileId, pausedAgents[] |
| UserMessageEventPayload | interface | channelId, content, mentions[] |
| BrokerEventMap | interface | 24 event type → payload mappings |
| BrokerEventType | type | keyof BrokerEventMap |
| BrokerEvent | interface | Generic event: eventId, type, channelId?, payload, timestamp |
| SocketServerToClientEvents | type | Mapped Socket.io server emit types |
| SocketClientToServerEvents | interface | user:message event |

#### mention.types.ts
| Identifier | Kind | Description |
|---|---|---|
| MentionType | type | agent, role |
| MentionFlag | type | critical, attention_boost, escalation, null |
| MentionMetadata | interface | type, targetId, targetName, position, flag |

#### message.types.ts
| Identifier | Kind | Description |
|---|---|---|
| MessageAuthorType | type | user, agent, system |
| ChannelMessage | interface | id, channelId, authorId, authorName, authorLevel, authorType, content, mentions[], isInternalMonologue, sequenceNumber, timestamp |

#### module.types.ts
| Identifier | Kind | Description |
|---|---|---|
| ProviderEngine | type | google, openai, anthropic, ollama, custom |
| ModelModule | interface | id, label, provider, modelName, apiKey?, endpointUrl?, temperature, topP, maxOutputTokens, stopSequences, maxRecentMessages, enableCompression, compressionThreshold |
| InstructionModule | interface | id, label, base string[], runtimePatchable |
| ToolkitModule | interface | id, label, tools string[] |
| ConstraintsModule | interface | id, label, rules string[], disallowedActions string[] |
| CapabilitiesModule | interface | id, label, skills string[], functionSchemas Record[] |
| ModuleType | type | model, instruction, toolkit, constraints, capabilities |
| ModuleUnion | type | Union of all 5 module interfaces |

#### provider.types.ts
| Identifier | Kind | Description |
|---|---|---|
| ProviderEngine | type | google, openai, anthropic, ollama, custom |
| GenerationModelProfile | interface | id, label, provider, modelName, apiKey?, endpointUrl?, temperature, topP, maxOutputTokens, stopSequences, maxRecentMessages, enableCompression, compressionThreshold |
| EmbeddingModelProfile | interface | id, label, provider, modelName, apiKey?, endpointUrl?, dimensions |
| IndexingModelProfile | interface | id, label, provider, modelName, apiKey?, endpointUrl? |

#### runtime.types.ts
| Identifier | Kind | Description |
|---|---|---|
| RuntimeOverrideType | type | runtime_patch, temp_permission, context_inject |
| InstructionPatch | interface | append?, replace? string[] |
| PermissionPatch | interface | grantTools?, revokeTools? string[] |
| RuntimeOverride | interface | id, targetAgentId, overrideType, instructionPatch?, permissionPatch?, createdBy, expiresAt? |
| RuntimeStatus | type | idle, working, paused, offline |
| RuntimeState | interface | sessionId, agentId, status, activeTask?, activeChannelId?, startedAt?, overridesApplied[], lastHeartbeat? |

#### task.types.ts
| Identifier | Kind | Description |
|---|---|---|
| SpawnFailurePolicy | type | retry, escalate |
| SpawnStatus | type | pending, in_progress, completed, failed |
| TaskPriority | type | high, medium, low |
| SubtaskDefinition | interface | id, title, instructions, priority |
| SpawnRequest | interface | id, requestedBy, channelId, workerTemplateId, supervisorTemplateId, subtasks[], failurePolicy, maxRetries, status |
| TaskFile | interface | id, spawnRequestId, subtaskId, title, content, workerAgentId, supervisorAgentId, status |
| ScheduledTask | interface | id, cronExpression, channelId, targetAgentId, taskPayload, isActive, nextRun? |

#### tool.types.ts
| Identifier | Kind | Description |
|---|---|---|
| ToolDangerLevel | type | low, medium, high |
| ToolDefinition | interface | id, name, description, handlerId, jsonSchema, dangerLevel, authLevelRequired |
| ToolCall | interface | id, toolId, name, arguments |
| TokenUsage | interface | promptTokens, completionTokens, totalTokens, provider? |

#### workspace.types.ts
| Identifier | Kind | Description |
|---|---|---|
| WorkspaceStatus | type | CREATED, INITIALIZING, ACTIVE, PAUSED, TERMINATED, ARCHIVED |
| WorkspaceScope | type | private, shared, readonly, ephemeral |
| ArtifactType | type | reasoning_trace, execution_log, analysis_report, generated_component, task_result, runtime_snapshot |

| WorkspacePermissions | interface | network, shell, maxAgents |
| RuntimeConstraints | interface | networkAccess, shellExecution, memoryLimitMb, cpuLimit |
| FilesystemPermissions | interface | read, write, execute |
| Workspace | interface | id, name, ownerId, status, rootPath, permissions, constraints, metadata |




| Artifact | interface | id, workspaceId, producerAgent, artifactType, path?, semanticTags[], metadata |
| CreateWorkspaceInput | interface | name, ownerId?, permissions?, constraints?, metadata? |
| MountAgentInput | interface | agentId, scope?, permissions? |
| RegisterArtifactInput | interface | producerAgent, artifactType, path?, semanticTags?, metadata? |

#### index.ts barrel
| Identifier | Kind | Description |
|---|---|---|
| StandardMessage | interface | role + content for LLM |
| GenerationResult | interface | content + toolCalls + usage + finishReason |
| StreamChunk | interface | Streaming LLM response |
| TokenBudget | interface | globalSoftCap + perProviderBudget |
| TokenUsageLog | interface | id, agentId, channelId, modelProfileId, promptTokens, completionTokens, totalTokens, timestamp |

### 2.2 Database Schema (server/src/db/schema.ts) — 38 tables + relations (Phase 7)

| Table | Key Columns |
|---|---|
| model_modules | id (pk), label, provider, modelName, apiKey, endpointUrl, temperature, topP, maxOutputTokens, stopSequences (jsonb), maxRecentMessages, enableCompression, compressionThreshold |
| instruction_modules | id (pk), label, base (jsonb[]), runtimePatchable |
| toolkit_modules | id (pk), label, tools (jsonb[]) |
| constraints_modules | id (pk), label, rules (jsonb[]), disallowedActions (jsonb[]) |
| capabilities_modules | id (pk), label, skills (jsonb[]), functionSchemas (jsonb[]) |
| agents | id (pk), name, title, species, avatar, authorityLevel, l3Subtype, modelModuleId (fk), instructionModuleId (fk), toolkitModuleId (fk), constraintsModuleId (fk), capabilitiesModuleId (fk), memorySharingPolicy, isOmniscient, fallbackAgentId, categoryPermissions (jsonb), permissions (jsonb), status, isTemplate |
| agent_tools | agentId (fk) + toolId (fk) composite pk |
| tools | id (pk), name (unique), description, handlerId, jsonSchema, dangerLevel, authLevelRequired |
| runtime_overrides | id (pk), targetAgentId, overrideType, instructionPatch (jsonb), permissionPatch (jsonb), createdBy, expiresAt |
| runtime_states | sessionId (pk), agentId, status, activeTask, activeChannelId, startedAt, overridesApplied (jsonb), errorInfo (jsonb), lastHeartbeat |
| generation_model_profiles | id (pk), label, provider, modelName, apiKey, endpointUrl, temperature, topP, maxOutputTokens, stopSequences (jsonb), maxRecentMessages, enableCompression, compressionThreshold |
| embedding_model_profiles | id (pk), label, provider, modelName, apiKey, endpointUrl, dimensions |
| indexing_model_profiles | id (pk), label, provider, modelName, apiKey, endpointUrl |
| categories | id (pk), name, ownedByAgentId (fk), embeddingProfileId (fk), createdBy, position |
| channels | id (pk), categoryId (fk), name, type (standard/pair_private/archived), createdBy, position, archivedAt |
| messages | id (pk), channelId (fk), authorId, authorName, authorLevel, authorType, content, mentions (jsonb[]), isInternalMonologue, sequenceNumber (unique per channel) |
| spawn_requests | id (pk), requestedBy (fk), channelId (fk), workerTemplateId (fk), supervisorTemplateId (fk), failurePolicy, maxRetries, subtasks (jsonb[]), status |
| task_files | id (pk), spawnRequestId (fk), subtaskId, title, content, workerAgentId (fk), supervisorAgentId (fk), status |
| scheduled_tasks | id (pk), cronExpression, channelId (fk), targetAgentId (fk), taskPayload (jsonb), isActive, nextRun |
| token_usage_log | id (pk), agentId (fk), channelId (fk), modelModuleId (fk), `runId` (fk runs.id, nullable, Phase 7 cost ledger), promptTokens, completionTokens, totalTokens, timestamp + indexes `token_usage_log_timestamp_idx`, `token_usage_log_run_idx` |
| channel_index | channelId (pk/fk), channelPath, topicSummary, lastIndexedAt, `lastSeq` (int, Phase 3 delta), `status` (ok/degraded), `lastError`, msgCountSinceIndex |
| compressed_summaries | id (pk), channelId (fk), summary, coversUpToSeq |
| workspace_settings | id (pk), globalSoftCap, perProviderBudget (jsonb) |
| workspaces | id (pk), name, ownerId, status, rootPath, permissions (jsonb), constraints (jsonb), metadata (jsonb) |
| workspace_nodes | id (pk), workspaceId (fk), path (unique per ws), name, type, mimeType, size, checksum, createdBy, updatedBy, metadata (jsonb) |
| workspace_events | id (pk), workspaceId (fk), type, agentId, path, payload (jsonb) |
| workspace_agents | id (pk), workspaceId (fk), agentId (fk), scope, permissions (jsonb) |
| artifacts | id (pk), workspaceId (fk), producerAgent, artifactType (`reasoning_trace`..`diff`/`report`/`citations` Phase 5), path, semanticTags (text[]), metadata (jsonb), `runId` (fk runs.id), `beforeHash`, `afterHash`, `patch`, `contentRef` |
| runs | id (uuid pk), parent_run_id (fk runs.id), agent_id, channel_id, workspace_id, runtime_type, status (17 states: created→completed/failed/cancelled etc), error_code, checkpoint_seq, checkpoint (jsonb watermark+completedCallIds), createdAt/updatedAt |
| runs_compensation | id (pk), run_id (fk runs.id), seq, tool_name, target_path, inverse_op (jsonb delete/restore), createdAt |
| api_keys | id (uuid pk), key_hash (unique, scrypt), label, role (admin/operator/viewer), createdAt, lastUsedAt, revokedAt |
| durable_events | seq (bigserial pk), eventId, type, channelId, agentId, payload (jsonb), createdAt + index `durable_events_channel_seq_idx` |
| channel_sequences | channel_id (pk/fk channels.id), last_seq (bigint), updatedAt |
| swarm_tasks | id (pk), run_id (fk runs.id), depends_on (jsonb[]), assignee_template, status (pending/running/completed/failed/blocked), output_ref, createdAt/updatedAt |
| delegations | id (pk), parent_run_id (fk runs.id), child_run_id (fk runs.id), depth, summary, createdAt |
| approval_requests | id (pk), run_id (fk runs.id), tool_name, args_preview (jsonb), risk_class (install/network/destructive/git_push/db_write/general), status (pending/approved/denied/expired), requested_by, decided_by, expiresAt, scope, createdAt/decidedAt |
| agent_memory_notes | id (pk), agentId (fk), channelId (fk), noteType, noteTimestamp, importanceScore, confidence, sourceType, emotionalValence, accessCount, lastAccessed, links (jsonb), contradictionFlags (jsonb), lifecycleStatus, archivedAt, suppressUntil, hook, brief, observed, interpreted, feltSense, futureRelevance, uncertainty, detailed, `embedding` (text json + `embedding_vec vector(1536)` Phase 7), `embeddingModel`, `embeddingUpdatedAt` |
| memory_update_log | id (pk), agentId, noteId (fk), timestamp, reason, fieldsChanged (jsonb), previousValues (jsonb) |
| agent_tools | agentId+toolId composite pk |
| channel_sequences | channel_id (pk) see above (duplicate entry collapsed) |

### 2.3 Core Engine (server/src/core/)

| Class/Module | File | Key Methods / Exports |
|---|---|---|
| AgentRegistry | AgentRegistry.ts | list(filters), getById(id), create(input), update(id, input), delete(id) |
| EventBroker | EventBroker.ts | emit(type, payload, options?), on(type, channelId?, handler), onAny(handler), off(listenerId), removeChannelListeners(channelId), getRecentEvents(channelId, limit?) |
| AgentSpawnManager | AgentSpawnManager.ts | dispatchAgent(broker, requestedByAgentId, originChannelId, params) → AggregationReport |
| MemoryBuilder | MemoryBuilder.ts | buildPrompt(input) → PromptAssemblyResult |
| L0Runtime | L0Runtime.ts | execute(broker, channelId, agent, userMsgContent) — real Google LLM calls via compileGoogleEndpoint + fetch, handles Gemma thoughts/streaming/token tracking/loop detection |
| L1Runtime | L1Runtime.ts | execute(broker, channelId, l1Agent, userMsgContent) |
| L2Runtime | L2Runtime.ts | execute(broker, channelId, l2Agent, userMsgContent) |
| LibrarianRuntime | LibrarianRuntime.ts | execute(broker, channelId, librarianAgent, userMsgContent), indexChannel(broker, agent, targetChannelId) |
| LoopArbiter | LoopArbiter.ts | checkLoop(broker, agent, channelId, newMessage) → boolean |
| IndexBuilder | IndexBuilder.ts | incrementMessageCount(channelId), reindexStaleChannels(broker) |
| PromptFormatter | PromptFormatter.ts | formatMessageForAgent(message, recipientAgentName?) |
| MentionParser | MentionParser.ts | parseMentions(content) → MentionMetadata[] |
| TokenTracker | TokenTracker.ts | trackUsage(broker, agent, channelId, modelModuleId, promptTokens, completionTokens) → boolean |
| modelRouter | modelRouter.ts | isGemmaModel, validateGemmaModel, parseGemmaThoughts, compileGoogleEndpoint |
| validation | validation.ts | validatorCompiler (Fastify Zod schema compiler) |
| errors | errors.ts | setupErrorHandler(app) (Fastify error handler) |
| AgentErrors | AgentErrors.ts | AgentError class, EscalationChain.escalate(), AgentErrorType (7 types), EscalationChain class |

### 2.4 Routes (server/src/routes/) — Fastify

| Router | File | Paths | Methods |
|---|---|---|---|
| registerRoutes | index.ts | - | Registers all sub-routers |
| agentRoutes | agents.ts | /api/agents, /api/agents/:id | GET (list with query filters), GET /:id, POST, PUT /:id, DELETE /:id |
| moduleRoutes | modules.ts | /api/modules, /api/modules/{model\|instruction\|toolkit\|constraints\|capabilities}, /api/modules/{type}/:id, /api/modules/model/:id/test | GET (aggregated), GET /{type}, GET /{type}/:id, POST /{type}, PUT /{type}/:id, DELETE /{type}/:id, POST /model/:id/test |
| providerRoutes | providers.ts | /api/providers, /api/providers/{generation\|embedding\|indexing}, /api/providers/{type}/:id, /api/providers/{type}/:id/test | GET (aggregated), GET /{type}, GET /{type}/:id, POST /{type}, PUT /{type}/:id, DELETE /{type}/:id, POST /{type}/:id/test |
| workspaceRoutes | workspace.ts | /api/workspace/settings, /api/workspace/budget, /api/workspace/budget/reset, /api/workspace/database | GET/PUT /settings, GET/PUT /budget, POST /budget/reset, POST /database |
| categoryRoutes | categories.ts | /api/categories, /api/categories/:id | GET, POST, PUT /:id, PATCH /:id, DELETE /:id |
| channelRoutes | channels.ts | /api/channels, /api/channels/:id | GET, POST, PUT /:id, PATCH /:id, DELETE /:id |
| messageRoutes | messages.ts | /api/channels/:channelId/messages | GET (with ?includeMonologue query) |
| filesystemRoutes | filesystem.ts | /api/workspace/files, /api/workspace/files/content | GET /files (list), GET /files/content (read), POST /files/content (write), DELETE /files |
| healthRoutes | health.ts | /health | GET |

### 2.5 Socket Server (server/src/sockets/)

| Identifier | File | Description |
|---|---|---|
| registerSocketServer | registerSocketServer.ts | Registers Socket.io on HTTP server, bridges EventBroker → socket broadcast |
| globalBroker | registerSocketServer.ts | Exported singleton EventBroker reference |

Socket event flow: `user:message` → parse mentions → route to L1Runtime/L2Runtime/LibrarianRuntime/triggerAgentReply

Background jobs: IndexBuilder.incrementMessageCount (on message:new), IndexBuilder.reindexStaleChannels (every 10 min), emitRuntimeSnapshot (every 15 sec)

### 2.6 Tool System (server/src/tools/)

| Identifier | File | Description |
|---|---|---|
| ToolResult | registry.ts | { success, output, error? } |
| ToolDefinition | registry.ts | { id, name, displayName, description, parameters, handler, dangerLevel, authLevelRequired? } |
| toolRegistry | registry.ts | Map<string, ToolDefinition> (11 tools) |
| activeSchedules | registry.ts | Map<string, schedule> for scheduler tool |
| ToolExecutor | ToolExecutor.ts | execute(agentId, toolId, args) — authorization + safety guards |
| Guard | safety/Guard.ts | validatePath, validateCommand, isCommandWhitelisted |

Tools registered: read_file, write_file, list_directory, delete_file, execute_bash, execute_safe, web_search, query_database, system_scheduler, dispatch_agent, search_all_channels

### 2.7 Workspace & Filesystem

#### Workspace Manager & Permissions

| Class/Function | File | Key Methods / Signatures |
|---|---|---|
| WorkspaceManager | workspace/workspace-manager.ts | constructor(sandboxRoot, eventBroker?), createWorkspace(input), getWorkspace(id), listWorkspaces(), deleteWorkspace(id), updateWorkspaceStatus(id, status), mountAgent(workspaceId, input), unmountAgent(workspaceId, agentId), getAgentSessions(workspaceId), getFilesystem(workspaceId, workspace, actorId), getEvents(workspaceId, limit?) |
| PermissionError | workspace/permission-guard.ts | constructor(message) — statusCode = 403 |
| WorkspaceNotActiveError | workspace/permission-guard.ts | constructor(workspaceId, status) — statusCode = 409 |
| assertWorkspaceActive | workspace/permission-guard.ts | (workspace: Workspace): void |
| assertPermission | workspace/permission-guard.ts | (session: WorkspaceAgentSession, required: keyof FilesystemPermissions): void |
| assertCanRead / assertCanWrite / assertCanExecute | workspace/permission-guard.ts | (session: WorkspaceAgentSession): void |
| validateAgentAccess | workspace/permission-guard.ts | (sessions, agentId, workspaceId): WorkspaceAgentSession |

#### Virtual File System

| Interface/Class | File | Members / Description |
|---|---|---|
| FileNode | Filesystem/filesystem-types.ts | name, path, type (file\|directory), size, mimeType, updatedAt |
| FileStat | Filesystem/filesystem-types.ts | name, path, type, size, mimeType, checksum, createdAt, updatedAt, createdBy, updatedBy |

| LocalFilesystemOptions | Filesystem/local-filesystem.ts | workspaceId, workspaceRoot, actorId, onEvent? |
| LocalFilesystem | Filesystem/local-filesystem.ts | read/readBinary/write/mkdir/delete/rename/list/stat/exists/initialize + auto-creates workspace dirs on initialize (src/, artifacts/, agents/, .crowdos/, .crowdos/runtime\|cache\|snapshots) |
| Filesystem barrel | Filesystem/index.ts | Re-exports FileNode, FileStat, LocalFilesystem, LocalFilesystemOptions, normalizePath, isPathSafe, isInsideRoot, resolveWorkspacePath, extractName, guessMimeType |

#### PathGuard Functions (Filesystem/path-guard.ts)

| Function | Signature | Description |
|---|---|---|
| normalizePath | (inputPath: string) => string | Converts backslashes, resolves . / .., strips leading/trailing / |
| isPathSafe | (inputPath: string) => boolean | Rejects traversal, null bytes, Windows drive letters |
| resolveWorkspacePath | (workspaceRoot: string, relativePath: string) => string | Joins root + path with traversal check |
| extractName | (filePath: string) => string | posix.basename after normalization |
| guessMimeType | (filePath: string) => string \| null | 20+ extension → MIME mappings |

### 2.8 Config & Entry

| Identifier | File | Description |
|---|---|---|
| env | config/env.ts | PORT, CLIENT_ORIGIN, DATABASE_URL |
| database | config/database.ts | getSqlClient, getDb, ensurePgVectorExtension, closeDatabaseConnection |
| app | index.ts | Fastify HTTP server instance |
| eventBroker | index.ts | EventBroker singleton |
| startServer | index.ts | Bootstrap: initialize workspace filesystems → listen |

### 2.9 Empty Scaffold Directories

| Directory | Contents |
|---|---|
| adapters/ | (empty — future LLM adapter implementations) |
| agents/ | AgentErrors.ts (0 B), AgentManager.ts (0 B), AgentRegistry.ts (0 B) — scaffold stubs |

---

## 3. Package: packages/client - Frontend

### 3.1 Types (client/types/crowd-os.ts)

| Identifier | Kind | Description |
|---|---|---|
| AgentStatus | type | Re-export from shared |
| AgentLevel | type | 0 \| 1 \| 2 \| 3 |
| Agent | interface | id, name, species, level, status, avatar?, 5 module refs, parentId?, roleId?, isOmniscient?, createdAt, lastActive, description? |
| MessageType | type | human, agent, system, governance, delegation, tool_execution |
| DelegationInfo | interface | id, fromAgentId, fromAgentName, toAgentId, toAgentName, task, status (pending\|executing\|completed\|failed), tokens, cost |
| ToolExecution | interface | name, input, output?, durationMs, status (success\|error) |
| Attachment | interface | id, name, type, url, size? |
| Message | interface | id, type, content, authorId, authorName, authorAvatar?, channelId, timestamp, mentions[]?, delegationInfo?, toolExecution?, metadata?, attachments[]? |
| ProviderType | type | google, openai, anthropic, ollama, custom |
| ModelProfile | interface | id, label, provider, modelName, apiKey?, baseUrl?, apiKeyConfigured, createdAt, updatedAt? |
| Channel | interface | id, name, description?, unreadCount, hasMention, categoryId \| null?, type (standard\|pair_private\|archived)?, position?, archivedAt \| null? |
| Category | interface | id, name, collapsed, channels[], position? |
| Workspace | interface | id, name, icon, dbUrl?, categories[], channels?, createdAt |
| InstructionModule | interface | id, name, description?, systemPrompt, persona?, rules?, sandboxPath?, modelProfileId?, createdAt |
| ModelModule | interface | id, name, description?, modelProfileId, provider?, apiKey?, baseUrl?, temperature?, maxTokens?, topP?, maxRecentMessages?, enableCompression?, compressionThreshold?, createdAt |
| ToolkitModule | interface | id, name, description?, enabledToolIds[], sandboxConfig?, createdAt |
| ConstraintsModule | interface | id, name, rules[], disallowedActions[], createdAt |
| CapabilitiesModule | interface | id, name, skills[], functionSchemas[], createdAt |
| RuntimeOverride | interface | id, agentId, type (instruction\|model\|toolkit), patch, reason?, expiresAt?, active, createdAt |
| Tool | interface | id, name, category, description, enabled, usageCount |
| Role | interface | id, name, color, permissions[] |

### 3.2 State Store (client/stores/crowd-os-store.ts) — Zustand

State slices: workspaces[], agents[], messages[], modelProfiles[], instructionModules[], modelModules[], toolkitModules[], constraintsModules[], capabilitiesModules[], runtimeOverrides[], tools[], roles[], archivedChannels[], globalSoftCap, perProviderBudget, totalTokensConsumed, activeWorkspaceId, activeChannelId, selectedAgentId, selectedSandboxFile, filesystemRevision, rightSidebarOpen, leftSidebarCollapsed, settingsModalOpen, agentProfileModalOpen, workspaceSettingsTab, activeMobileTab, mobileDrawerLeft/Right, chatSearchQuery, isFetchingWorkspaces, isCreatingWorkspace, workspaceError

Core actions: fetchWorkspaces, createWorkspace, deleteWorkspace, enterWorkspace, leaveWorkspace, setActiveChannel, addMessage, clearChannelMessages, addAgent, updateAgentStatus, updateAgent, deleteAgent, openAgentProfileModal, closeAgentProfileModal, addModelProfile, updateModelProfile, deleteModelProfile, add/update/delete InstructionModule, add/update/delete ModelModule, add/update/delete ToolkitModule, add/update/delete ConstraintsModule, add/update/delete CapabilitiesModule, addRuntimeOverride, toggleRuntimeOverride, deleteRuntimeOverride, toggleRightSidebar, setRightSidebarOpen, toggleLeftSidebar, setSettingsModalOpen, setWorkspaceSettingsTab, toggleCategoryCollapse, deleteCategory, createCategory, createChannel, deleteChannel, archiveChannel, reorderCategory, reorderChannel, setSelectedSandboxFile, incrementFilesystemRevision, setActiveMobileTab, setMobileDrawerLeft/Right, selectChannelMobile, toggleToolEnabled, incrementToolUsage, addRole, updateRole, reorderRoles, deleteRole, fetchBudget, updateBudget, resetBudget

Socket listeners: message:new, message:stream, agent:status, agent:thinking, workspace:sync, budget:exceeded, budget:warning, agent:spawned, agent:paused, agent:resumed, runtime:snapshot, escalation:created, strike:initiated, parliament:convened, parliament:updated, sandbox:updated

### 3.3 App Shell (client/src/)

| Identifier | File | Description |
|---|---|---|
| App | src/App.tsx | Root layout component |
| main | src/main.tsx | ReactDOM.createRoot entry |
| socket | src/config/socket.ts | Socket.io client singleton |
| connectSocket | src/config/socket.ts | Initialize socket connection |

### 3.4 Components (client/components/)

**Workspace Layout:** WorkspaceSidebar, WorkspaceDropdown, MainChatArea, RightSidebar, FileExplorer

**Messages:** Message, HumanMessage, AgentMessage, SystemMessage, DelegationMessage, ToolExecutionMessage, MentionParser, AttachmentsView

**Modals/Settings:** WorkspaceSettingsModal, AgentProfileModal, ModelCardsTab

**Mobile:** BottomNav, MobileDrawer

**UI Primitives:** PresenceIndicator, StatusBadge, CrowIcon

**Portal:** WorkspacePortal

---

## 4. Configuration & Build Files

| File | Scope |
|---|---|
| package.json | Root - npm workspaces (server + client + shared) |
| tsconfig.base.json | Shared TS options |
| playwright.config.ts | E2E tests |
| packages/server/package.json | Server deps (Fastify, Drizzle, Socket.io, Zod, postgres) |
| packages/server/tsconfig.json | Server TS |
| packages/server/drizzle.config.ts | Drizzle config |
| packages/server/vitest.config.ts | Server test config |
| packages/client/package.json | Client deps (React, Zustand, Socket.io-client, Tailwind v4, Lucide) |
| packages/client/tsconfig.json | Client TS |
| packages/client/vite.config.ts | Vite bundler |
| packages/client/vitest.config.ts | Client test config |
| packages/client/index.html | HTML entry |
| packages/shared/package.json | Shared deps (Zod) |
| packages/shared/tsconfig.json | Shared TS |

---

## 5. Documentation (docs/)

| Path | Description |
|---|---|
| 01_Project_Guideline_LV0_Vision.md | Product vision, authority levels (L0-L3), UX metaphor |
| 02_Project_Guideline_LV1_Architecture.md | Event-driven architecture, state management, tech stack |
| 03_Technical_Project_Structure.md | Monorepo layout, interfaces, DB schema, API, socket events |
| LV2_Agent_Creation_UI.md | Agent creation form, module selectors |
| LV2_Agent_Lifecycle_Engine.md | Agent lifecycle FSM, registry, event hooks |
| LV2_Channel_Workspace_Routing.md | Channel-based message routing |
| LV2_Error_Handling_Recovery.md | Error categorization, retry, circuit breakers |
| LV2_L3_Spawn_Protocol.md | L3 agent spawn/delegate protocol |
| LV2_Memory_and_Context.md | Memory construction, RAG, vector store |
| LV2_Mention_System.md | @mention parsing and resolution |
| LV2_Prompt_Assembly.md | Prompt template assembly from modules |
| LV2_Router_Dispatch_Logic.md | L1 router dispatch, tier routing |
| LV2_Testing_Strategy.md | Unit, integration, E2E test strategy |
| LV2_Tool_and_Scheduling.md | Tool registry, execution, scheduling |
| LV2_Workspace_Sandbox_Runtime.md | Sandbox runtime for code execution |
| LV2_Workspace_Settings_Providers.md | Provider settings UI and config |
| Convergence_FE-BE.md | Frontend-backend convergence checklist |
| FRONTEND_BACKEND_SYNC.md | API/Socket sync spec |
| CRUD_API_REFERENCE.md | Full CRUD API reference |
| crowdfull e2e validation spec | End-to-end validation flows |
| runtime-convergence-matrix.md | Runtime state convergence matrix |
| implemented-backend/ (5 files) | Overview, DB schema, API/sockets, core engine, types/config |
| implemented-frontend/ (5 files) | Overview, state management, components, types/API/socket, UI design |
| unwired/tracked-changes.md | Tracked/unwired feature changes |
| unwired/unwired_features.md | List of unwired features |
| UI Spec/ui_frontend_spec.md | Frontend UI specification |
| AGENTS.md | Agent configuration for AI coding assistants |
| DEVELOPMENT_BOARD.md | Single source of truth for progress |
| README.md | Project readme |

---

## 6. Execution Plan (execution-plan/)

### Feature Plans (18 files)

| ID | Plan File | Progress File |
|---|---|---|
| EP-00 | 00-project-overview.md | progress/00-master-checklist.md |
| EP-01 | 01-monorepo-bootstrap.md | progress/01-monorepo-bootstrap-progress.md |
| EP-02 | 02-database-and-schema.md | progress/02-database-and-schema-progress.md |
| EP-03 | 03-server-foundation.md | progress/03-server-foundation-progress.md |
| EP-04 | 04-client-shell.md | progress/04-client-shell-progress.md |
| EP-05 | 05-event-broker-and-socket.md | progress/05-event-broker-and-socket-progress.md |
| EP-06 | 06-agent-registry.md | progress/06-agent-registry-progress.md |
| EP-07 | 07-agent-creation-ui.md | progress/07-agent-creation-ui-progress.md |
| EP-08 | 08-provider-settings.md | progress/08-provider-settings-progress.md |
| EP-09 | 09-memory-and-prompt.md | progress/09-memory-and-prompt-progress.md |
| EP-10 | 10-l1-router-and-dispatch.md | progress/10-l1-router-and-dispatch-progress.md |
| EP-11 | 11-channel-and-workspace.md | progress/11-channel-and-workspace-progress.md |
| EP-12 | 12-l3-spawn-and-task-files.md | progress/12-l3-spawn-and-task-files-progress.md |
| EP-13 | 13-mention-system.md | progress/13-mention-system-progress.md |
| EP-14 | 14-tools-and-sandbox.md | progress/14-tools-and-sandbox-progress.md |
| EP-15 | 15-error-and-budget.md | progress/15-error-and-budget-progress.md |
| EP-16 | 16-index-and-omniscient.md | progress/16-index-and-omniscient-progress.md |
| EP-17 | 17-testing-and-release.md | progress/17-testing-and-release-progress.md |
| EP-18 | 18-workspace-sandbox-runtime.md | (workspace runtime extension) |

---

## 7. Quick Reference

### Agent Tiers
| Tier | Name | Role |
|---|---|---|
| L0 | Omniscient | God-view, indexing, oversight |
| L1 | Manager | Router, dispatcher, orchestrator |
| L2 | Specialist | Domain expert, LLM-driven |
| L3 | Worker | Ephemeral spawn, disposable (worker/supervisor subtypes) |

### Channel Types
| Type | Usage |
|---|---|
| standard | Normal chat |
| pair_private | L3 worker-supervisor private channel |
| archived | Archived/deleted channel |

### Module System (5 types)
| Module | Purpose |
|---|---|
| ModelModule | LLM provider + parameters |
| InstructionModule | System prompt instructions |
| ToolkitModule | Tool permission sets |
| ConstraintsModule | Safety rules + disallowed actions |
| CapabilitiesModule | Skill declarations + function schemas |

### Runtime Events (24 Socket Events)
Agent: AGENT_SPAWNED, AGENT_DESPAWNED, AGENT_PAUSED, AGENT_RESUMED, AGENT_LIFECYCLE
Runtime: RUNTIME_STATE, RUNTIME_SNAPSHOT, RUNTIME_OVERRIDE
Workspace: WORKSPACE_PATCHED, WORKSPACE_SNAPSHOT
Sandbox: SANDBOX_UPDATED, SANDBOX_STREAM, SANDBOX_PROCESS
Swarm: SWARM_CREATED, SWARM_UPDATED, SWARM_TERMINATED
Governance: ESCALATION_CREATED, ESCALATION_UPDATED, ESCALATION_RESOLVED

### Tools (11 registered)
read_file, write_file, list_directory, delete_file, execute_bash, execute_safe, web_search, query_database, system_scheduler, dispatch_agent, search_all_channels

---

## 8. Test Infrastructure

| File | Description |
|---|---|
| packages/server/src/core/AgentRegistry.test.ts | Agent registry tests |
| packages/server/src/core/MemoryBuilder.test.ts | Memory builder tests |
| packages/server/src/routes/modules.test.ts | Module CRUD tests |
| packages/server/src/routes/channel-category-crud.test.ts | Channel/category CRUD tests |
| packages/client/stores/store.test.ts | Zustand store tests |
| playwright.config.ts | E2E config |
| e2e/ | E2E test directory |

---

## 9. Performance & Reliability Layer (Aug 2026 passes 1-4)

### Shared/Core Utilities
| Identifier | Kind | Description |
|---|---|---|
| perfMetrics | module | timeAsync/timeSync recorders, p50/p90/p95/p99 snapshots, [perf] log flush every 60s |
| TtlCache | class | TTL + LRU-eviction cache; get/set/delete/clear/invalidatePrefix |
| agentHeartbeat | module | markAgentWorking/markAgentIdle, startHeartbeatSystem (toucher + orphan sweeper, ORPHAN_AFTER_MS default 60s) |

### DB Tables (new)
| Table | Purpose |
|---|---|
| durable_events | Ordered replayable broker event log: bigserial seq, channel+seq index, 24h retention |

### Socket Events (new)
| Event | Direction | Purpose |
|---|---|---|
| user:cancel | client→server | Abort in-flight runs for channelId (optional agentId) |

### REST Routes (new)
| Route | Purpose |
|---|---|
| GET /api/events/recent?channelId&afterSeq&limit | Cursor-based durable event replay |

### Runtime Flags (env)
| Flag | Default | Effect |
|---|---|---|
| PIPELINE_PARALLEL | true | false = serial context middleware loop (rollback) |
| STREAM_BATCH_MS | 50 | 0 = per-token socket emission (rollback) |
| DURABLE_EVENTS | true | false = skip durable_events dual-write |
| ORPHAN_AFTER_MS | 60000 | Heartbeat staleness threshold before zombie agent paused |

---

*Generated: Aug 2026 — Remediation post-Phase 7, 38 tables, 32 events, 18 gated domains (see `REMEDIATION_SPEC.md`).*

### 9. Observability & Scale (Phase 7)

| Identifier | File | Description |
|---|---|---|
| observabilityGate | Observability/observabilityGate.ts | Gated facade: `startSpan`/`endSpan`/`withSpan`, `getTrace`/`getAllTraces`, `getPerRunCostLedger`/`getCostDashboard`/`verifyLedgerAccuracy` |
| tracing.ts | Observability/tracing.ts | In-memory OTel-compatible spans keyed `runId`, dynamic `@opentelemetry/api` when `OTEL_ENABLED` |
| costLedger.ts | Observability/costLedger.ts | `token_usage_log × model_modules.cost_per_1k` → per-run rollup + `cost_ledger_per_run` view |
| embeddings.ts | Memories/embeddings.ts | `mockEmbed` deterministic hash, `cosineSimilarity`, `hybridScore` (weight `EMBEDDING_HYBRID_WEIGHT`), `searchByEmbedding` via pgvector `<=>` or JS fallback |
| failureModes.test.ts | Shared/core/failureModes.test.ts | Goal §25 (20 scenarios: model timeout/refusal, tool crash, network, DB, queue, worker crash, duplicate, cancel, swarm partial, stale, corrupted, drain) |
| load/k6 & load/harness.mjs | load/ | 100 concurrent sends / 10 swarms / soak 8h + harness (`load:harness`); nightly via `.github/workflows/nightly.yml` |

### 10. Config Flags (Shared/config/env.ts — 45 flags, §13 registry)

`AUTH_STRICT`, `QUEUE_MODE`, `SWARM_V1`, `SWARM_LEGACY`, `APPROVALS_ENABLED`, `DELTA_INDEX`, `PER_ITERATION_BUDGET`, `DEMO_FALLBACK`, `LEGACY_BOOTSTRAP/GUARD`, `PIPELINE_PARALLEL`, `STREAM_BATCH_MS`, `ORPHAN_AFTER_MS`, `OTEL_ENABLED`, `EMBEDDING_ENABLED` etc. — see `docs/environment.md` generated via `npm run gen:env-doc`.
