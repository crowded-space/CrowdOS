# Core Engine Architecture

---

## 1. EventBroker (src/core/EventBroker.ts)

Typed EventEmitter wrapper for inter-module communication. Acts as the central nervous system.

Features:
- Typed events via BrokerEventMap (all events defined in event.types.ts)
- Per-channel event filtering (channel-scoped listeners)
- Recent event history (up to 50 events per channel, stored in memory)
- Wildcard listener (\*\) for all events — used by Socket.io bridge
- Methods: onChannelEvent(), emitChannelEvent(), getChannelHistory(), onAny()

Flow: Services -> EventBroker.emitChannelEvent() -> Socket.io server (via onAny) -> Frontend clients

---

## 2. Agent Registry (src/core/AgentRegistry.ts)

Service layer for agent CRUD operations against the database. Used by routes/agents.ts.

Key functions:
- listAgents(filters): query with authorityLevel, status, isTemplate
- getAgent(id): single agent with all module references
- createAgent(input): validates + inserts agent + agent_tools M2M
- updateAgent(id, patch): partial update
- deleteAgent(id): removes agent + cascade agent_tools

---

## 3. Agent Spawn Manager (src/core/AgentSpawnManager.ts)

L3 pair spawning orchestration. Creates Worker-Supervisor pairs on demand.

Flow:
1. Receive SpawnRequest (subtasks, templates, failurePolicy)
2. Clone worker + supervisor agent instances from templates (with new run IDs)
3. Create SpawnRequest record + TaskFiles per subtask
4. Emit agent:spawned event with pair IDs
5. Each cloned agent gets a fresh RuntimeState
6. Supervisor monitors worker output, triggers retry or escalation on failure

---

## 4. MemoryBuilder (src/core/MemoryBuilder.ts)

Prompt assembly engine with 3-tier compression architecture.

Tiers:
1. **Tier 1 — Recent** (default: last 10 messages): Full message content
2. **Tier 2 — Compressed** (messages beyond recent, up to threshold): Auto-summarized via LLM call, stored in compressed_summaries
3. **Tier 3 — Archived** (beyond compression threshold): Discarded (summaries already captured)

Compression triggers when message count > compressionThreshold (default: 15).

Memory visibility matrix (memory_sharing_policy):
- none: Only own messages
- horizontal: Same-level agents share
- vertical: Parent-child hierarchy shares
- full: All agents in channel share

Assembly pipeline returns: { systemInstructions, sharedMemory, independentMemory, currentMessage }

---

## 5. Agent Runtimes (L1Runtime, L2Runtime, LibrarianRuntime)

### L1Runtime (CEO - src/core/L1Runtime.ts)
Bipolar consciousness model:
- **Decomposer Phase**: Analyzes user request, breaks into subtasks
- **Orchestrator Phase**: Maps subtasks to specialist agents, dispatches

Connects to Google Gemini API via modelRouter.ts. Falls back to mock responses when API key is \mock-key\.

### L2Runtime (Manager - src/core/L2Runtime.ts)
Receives architectural breakdowns, maps instructions to specific tasks, spawns L3 worker drones via AgentSpawnManager.

### LibrarianRuntime (src/core/LibrarianRuntime.ts)
Specialist agent for knowledge management, channel indexing, and cross-channel context retrieval.

All runtimes follow the same pattern:
1. Receive message + mentions
2. Build prompt via MemoryBuilder
3. Call LLM via modelRouter
4. Emit agent:thinking, message:stream, agent:status events
5. Handle tool calls (via ToolExecutor)

---

## 6. Loop Arbiter (src/core/LoopArbiter.ts)

Lexical loop detection using Levenshtein distance.

- Compares consecutive messages from same agent
- If similarity >= 0.9 for 3+ consecutive messages: triggers EscalationChain
- Escalation: L3 -> L2 -> L1 -> User (system message in channel)
- Prevents infinite self-correction loops

---

## 7. Token Tracker (src/core/TokenTracker.ts)

Budget safety system.

- Logs every token usage to token_usage_log table
- Aggregates usage per provider
- Checks against globalSoftCap and perProviderBudget caps
- Emits budget:warning at 80% of cap
- Emits budget:exceeded at 100% (pauses agents)
- Budget reset sets all provider used counters to 0

---

## 8. Index Builder (src/core/IndexBuilder.ts)

Channel content indexing for cross-channel context retrieval.

- Tracks message count per channel
- Re-indexes channels with >= 10 new messages (drift threshold)
- Updates topic_summary in channel_index table
- Periodic background job every 10 minutes
- Listens to message:new event to increment counts

---

## 9. Mention Parser (src/core/MentionParser.ts)

@mention detection with Levenshtein typo correction.

- Extracts @mentions from message text
- Fuzzy matches against agent names (Levenshtein distance threshold: 0.75)
- Returns MentionMetadata[] with: agentId, agentName, mentionType (direct|implied|broadcast), confidence, originalText
- Handles @all, @everyone

---

## 10. Model Router (src/core/modelRouter.ts)

LLM provider abstraction layer.

- Routes requests based on provider_engine enum
- Currently implemented: Google Gemini (via Vertex AI or direct API)
- Params: model name, temperature, max tokens, stop sequences
- Returns: { text: string, usage: { promptTokens, completionTokens } }
- Falls back to mock/simulated responses when API keys are placeholders

---

## 11. Prompt Formatter (src/core/PromptFormatter.ts)

Converts internal message objects to XML-formatted strings for LLM consumption.

Format:
<message author=\\"AgentName\\" type=\\"human|agent\\" timestamp=\\"...\\">
Content here
</message>

Channels as:
<channels>
<channel name=\\"general-chat\\">description</channel>
</channels>

Authority context localized to Indonesian.

---

## 12. Tool System (src/tools/)

### Tool Registry (registry.ts)
11 tool definitions registered at startup, each with: id, name, description, handlerId, jsonSchema, dangerLevel, authLevelRequired.

### Tool Executor (ToolExecutor.ts)
- Authorizes tool use: checks agent's toolkitModule.tools union
- Validates auth_level_required <= agent's authorityLevel
- Executes the tool handler
- Returns tool result
- Logs token_usage (estimated)

### Safety Guard (safety/Guard.ts)
- Path traversal prevention (blocks ../ patterns)
- Command blacklist (rm -rf, del /f, etc.)
- Safe command whitelist for shell execution

---

## 13. Virtual Filesystem (src/vfs/)

### Interface (vfs.interface.ts)
VirtualFS { read(path): Buffer, write(path, data), mkdir(path), delete(path), rename(old, new), list(path): Dirent[], stat(path): Stats, exists(path): boolean }

### Local VFS (local-vfs.ts)
- Backend: local disk storage under workspace root_path
- Metadata: synced to workspace_nodes table
- Operations logged to workspace_events table

### Path Guard (path-guard.ts)
- Normalizes paths (resolves .., double slashes)
- Checks for path traversal outside workspace root
- Guesses MIME types from file extensions

---

## 14. Workspace Manager (src/workspace/)

### Workspace Manager (workspace-manager.ts)
Full lifecycle: CREATED -> INITIALIZING -> ACTIVE -> PAUSED -> TERMINATED -> ARCHIVED

Supports:
- Mount/unmount agents (with VFS scope permissions)
- Max agent enforcement
- Event logging
- Permission propagation

### Permission Guard (permission-guard.ts)
Asserts workspace operations based on agent's role permissions.
Checks: canRead, canWrite, canExecute against workspace scope.

---

## 15. Middleware Chain (src/index.ts)

1. Fastify Logger (pino with request serializers)
2. Correlation ID (x-correlation-id, x-request-id, or randomUUID)
3. Zod Validator Compiler (setValidatorCompiler)
4. CORS (origin from CLIENT_ORIGIN env)
5. Error Handler:
   - ZodError -> 400 with field-level details
   - Fastify validation errors -> 400
   - Generic -> status from error.code or 500

---

## 16. Agent Hierarchy (L0-L3)

| Level | Name | Responsibilities |
|-------|------|-----------------|
| L0 | Omniscient/Surveillance | Cross-channel indexing, knowledge management, monitoring |
| L1 | CEO/Admin | Decomposer + Orchestrator: breaks tasks, dispatches L2 |
| L2 | Coordinator/Manager | Spawns L3 pairs, validates deliverables |
| L3 (Worker) | Worker | Produces output (code, text, etc.) |
| L3 (Supervisor) | Supervisor | Evaluates worker output, triggers retry/escalation |
