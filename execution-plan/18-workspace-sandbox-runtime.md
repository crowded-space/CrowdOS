# 18 Workspace Sandbox Runtime

## Goal
Build the foundational workspace sandbox runtime: isolated virtual workspaces with VFS abstraction, event-driven mutations, multi-agent access, artifact tracking, and realtime synchronization.

## Phase 1 - Database Schema and Types

- [ ] Define Drizzle schema for `workspaces` table (id, name, owner_id, status enum, root_path, permissions JSONB, metadata JSONB, timestamps).
- [ ] Define Drizzle schema for `workspace_nodes` table (id, workspace_id FK, path, name, type enum, mime_type, size, checksum, created_by, updated_by, metadata JSONB, timestamps).
- [ ] Define Drizzle schema for `workspace_events` table (id, workspace_id FK, type, agent_id, path, payload JSONB, timestamp).
- [ ] Define Drizzle schema for `workspace_agents` table (id, workspace_id FK, agent_id FK, scope enum, permissions JSONB, timestamps).
- [ ] Define Drizzle schema for `artifacts` table (id, workspace_id FK, producer_agent, artifact_type enum, path, semantic_tags TEXT[], metadata JSONB, timestamp).
- [ ] Add workspace status enum (CREATED, INITIALIZING, ACTIVE, PAUSED, TERMINATED, ARCHIVED).
- [ ] Add workspace scope enum (private, shared, readonly, ephemeral).
- [ ] Add artifact type enum (reasoning_trace, execution_log, analysis_report, generated_component, task_result, runtime_snapshot).
- [ ] Define TypeScript interfaces for all workspace entities (Workspace, WorkspaceNode, WorkspaceEvent, WorkspaceAgent, Artifact).
- [ ] Add Drizzle relations between new tables and existing agents table.
- [ ] Run schema push and verify tables.

## Phase 2 - Virtual Filesystem Layer

- [ ] Create VFS interface (`VirtualFS`: read, write, mkdir, delete, rename, list, stat, watch).
- [ ] Create `FileNode` and `FileStat` types.
- [ ] Implement `LocalVFS` adapter backed by local disk (blob storage).
- [ ] Add path normalization and validation (prevent traversal attacks).
- [ ] Add workspace root scoping (all paths relative to workspace root_path).
- [ ] Add checksum computation on write (SHA-256).
- [ ] Sync VFS writes to `workspace_nodes` table (metadata tracking).
- [ ] Add `chokidar` file watcher integration for external change detection.

## Phase 3 - Workspace Runtime Service

- [ ] Create `WorkspaceManager` service class.
- [ ] Implement workspace creation (CREATED -> INITIALIZING -> ACTIVE lifecycle).
- [ ] Implement workspace initialization (create sandbox directory structure, write .crowdos/workspace.json).
- [ ] Implement workspace pause/resume (ACTIVE <-> PAUSED).
- [ ] Implement workspace termination (ACTIVE -> TERMINATED, cleanup runtime).
- [ ] Implement workspace archival (TERMINATED -> ARCHIVED, freeze state).
- [ ] Add agent mounting (`workspace_agents` record + permission validation).
- [ ] Add agent unmounting (cleanup session).
- [ ] Add permission validation middleware (check agent scope + read/write/execute flags per operation).

## Phase 4 - Event System Integration

- [ ] Define workspace event type union and typed payloads.
- [ ] Emit events on every VFS mutation (file.created, file.updated, file.deleted, file.renamed).
- [ ] Emit events on workspace lifecycle transitions (workspace.created, workspace.deleted).
- [ ] Emit events on agent mount/unmount (agent.joined, agent.left).
- [ ] Persist all events to `workspace_events` table.
- [ ] Bridge workspace events to existing `EventBroker`.
- [ ] Forward workspace events via Socket.io to subscribed clients.
- [ ] Add event filtering by workspace_id and event type.

## Phase 5 - Artifact System

- [ ] Create `ArtifactManager` service class.
- [ ] Implement artifact registration (create record + link to workspace node if file-based).
- [ ] Add semantic tagging support (TEXT[] tags).
- [ ] Add artifact lineage tracking (producer_agent, workspace_id, timestamps).
- [ ] Add artifact query API (filter by workspace, type, agent, tags).
- [ ] Emit `artifact.created` events.

## Phase 6 - REST API Routes

- [ ] POST `/api/workspaces` - create workspace.
- [ ] GET `/api/workspaces/:id` - get workspace details.
- [ ] PATCH `/api/workspaces/:id` - update workspace (status transitions).
- [ ] DELETE `/api/workspaces/:id` - terminate and delete workspace.
- [ ] GET `/api/workspaces/:id/files` - list workspace files (VFS list).
- [ ] GET `/api/workspaces/:id/files/*path` - read file content.
- [ ] POST `/api/workspaces/:id/files` - write file (VFS write).
- [ ] POST `/api/workspaces/:id/mkdir` - create directory (VFS mkdir).
- [ ] DELETE `/api/workspaces/:id/files/*path` - delete file/dir.
- [ ] POST `/api/workspaces/:id/agents` - mount agent to workspace.
- [ ] DELETE `/api/workspaces/:id/agents/:agentId` - unmount agent.
- [ ] GET `/api/workspaces/:id/events` - query workspace events.
- [ ] GET `/api/workspaces/:id/artifacts` - query artifacts.
- [ ] POST `/api/workspaces/:id/artifacts` - register artifact.
- [ ] Add Zod validation schemas for all request bodies.

## Phase 7 - Socket.io Realtime

- [ ] Add `workspace:subscribe` socket event (join workspace room).
- [ ] Add `workspace:unsubscribe` socket event (leave workspace room).
- [ ] Broadcast workspace events to room subscribers.
- [ ] Add `workspace:file:change` realtime push on VFS mutations.
- [ ] Add `workspace:agent:status` realtime push on agent mount/unmount.

## Phase 8 - Security and Sandbox

- [ ] Enforce workspace root isolation (no path escapes).
- [ ] Enforce agent permission checks on every VFS operation.
- [ ] Add runtime constraints schema (network_access, shell_execution, memory_limit_mb, cpu_limit).
- [ ] Add audit logging for all workspace mutations (who, what, when).
- [ ] Add workspace-level max_agents enforcement.

## Done when
- A workspace can be created, initialized, and deleted via API.
- Agents can be mounted/unmounted with scoped permissions.
- Files can be read/written/listed through the VFS abstraction.
- Every mutation emits a persisted event.
- Events are broadcast in realtime via Socket.io.
- Artifacts can be registered and queried.
- Path traversal attacks are blocked.
- Agent permission violations return 403.
- All API routes have Zod validation.
- TypeScript builds cleanly.