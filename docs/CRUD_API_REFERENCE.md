# CRUD API Reference — CrowdOS

## Overview

CrowdOS provides a complete **RESTful CRUD API** for all major entities, with **Zod validation**, **PostgreSQL persistence**, and **Socket.io real-time sync**. All endpoints emit `workspace:sync` events to trigger client-side refreshes.

---

## API Base URL

```
Backend: http://localhost:3001
Frontend Store: BACKEND_URL = 'http://localhost:3001'
```

---

## 1. Agent Profile CRUD

### Endpoint: `/api/agents`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents (with filters) |
| GET | `/api/agents/:id` | Get agent by ID |
| POST | `/api/agents` | Create new agent |
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |

### Query Parameters (GET /api/agents)

```typescript
{
  authorityLevel?: 0 | 1 | 2 | 3,
  status?: 'idle' | 'working' | 'paused' | 'offline',
  isTemplate?: boolean
}
```

### Request Body (POST /api/agents)

```typescript
{
  name: string,                    // Required, min(1)
  title: string,                   // Required, min(1)
  species: string,                 // Optional, min(1)
  avatar: string,                  // Optional
  authorityLevel: 0 | 1 | 2 | 3,  // Required
  l3Subtype?: 'worker' | 'supervisor',
  modelModuleId: string,           // Required - FK to ModelModule
  instructionModuleId: string,     // Required - FK to InstructionModule
  toolkitModuleId?: string,        // Optional - FK to ToolkitModule
  memorySharingPolicy?: 'none' | 'horizontal' | 'vertical' | 'full',
  isOmniscient?: boolean,
  categoryPermissions?: string[],
  permissions?: {
    spawnAgents?: boolean,
    patchRuntime?: boolean,
    accessAllChannels?: boolean
  },
  status?: 'idle' | 'working' | 'paused' | 'offline',
  isTemplate?: boolean
}
```

### Frontend Implementation (`crowd-os-store.ts`)

```typescript
// CREATE
addAgent: async (agent) => {
  await fetch(`${BACKEND_URL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: agent.name,
      title: agent.description,
      species: agent.species,
      authorityLevel: agent.level,
      modelModuleId: agent.modelModuleId,
      instructionModuleId: agent.instructionModuleId,
      toolkitModuleId: agent.toolkitModuleId
    })
  });
  await get().fetchWorkspaces(); // Sync after creation
}

// UPDATE STATUS
updateAgentStatus: (id, status) => {
  // Local state update only (real-time via socket)
  set({ agents: agents.map(ag => ag.id === id ? { ...ag, status } : ag) });
}

// UPDATE FULL
updateAgent: async (id, patch) => {
  await fetch(`${BACKEND_URL}/api/agents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  await get().fetchWorkspaces();
}

// DELETE
deleteAgent: async (id) => {
  await fetch(`${BACKEND_URL}/api/agents/${id}`, { method: 'DELETE' });
  const updated = agents.filter(ag => ag.id !== id);
  set({ agents: updated });
  await get().fetchWorkspaces();
}
```

### UI Components

- **AgentProfileModal**: View agent details, modules, runtime overrides
- **RightSidebar**: Display agent roster in tiered groups (L0-L3)

---

## 2. ModelModule CRUD

### Endpoint: `/api/modules/model`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/modules/model` | List all ModelModules |
| GET | `/api/modules/model/:id` | Get ModelModule by ID |
| POST | `/api/modules/model` | Create ModelModule |
| PUT | `/api/modules/model/:id` | Update ModelModule |
| DELETE | `/api/modules/model/:id` | Delete ModelModule |
| POST | `/api/modules/model/:id/test` | Test connection |

### Request Body (POST /api/modules/model)

```typescript
{
  label: string,                    // Required, min(1)
  provider: 'google' | 'openai' | 'anthropic' | 'ollama' | 'custom',
  modelName: string,                // Required, min(1)
  apiKey?: string | null,
  endpointUrl?: string | null,
  temperature: number,              // Required, 0.0 - 2.0
  topP: number,                     // Required, 0.0 - 1.0
  maxOutputTokens: number,          // Required
  stopSequences?: string[],
  maxRecentMessages: number,        // Required
  enableCompression?: boolean,
  compressionThreshold?: number
}
```

### Refereference Integrity

- DELETE returns **409 Conflict** if module is referenced by an agent
- Error message: `"ModelModule is still used by agent \"{name}\". Reassign or delete that agent first."`

### Frontend Implementation

```typescript
// CREATE
addModelModule: async (mod) => {
  await fetch(`${BACKEND_URL}/api/modules/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: mod.name,
      provider: mod.provider,
      modelName: mod.modelProfileId,
      apiKey: mod.apiKey,
      temperature: mod.temperature,
      maxOutputTokens: mod.maxTokens
    })
  });
  await get().fetchWorkspaces();
}

// UPDATE
updateModelModule: async (id, patch) => {
  await fetch(`${BACKEND_URL}/api/modules/model/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  await get().fetchWorkspaces();
}

// DELETE
deleteModelModule: async (id) => {
  await fetch(`${BACKEND_URL}/api/modules/model/${id}`, { method: 'DELETE' });
  // Error caught and displayed to user (409 Conflict)
}

// TEST CONNECTION
testConnection: async (id) => {
  const res = await fetch(`${BACKEND_URL}/api/modules/model/${id}/test`, {
    method: 'POST'
  });
  const data = await res.json();
  return data; // { success: boolean, message: string }
}
```

### UI Components

- **ModelCardsTab**: Full CRUD form with live connection testing

---

## 3. InstructionModule CRUD

### Endpoint: `/api/modules/instruction`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/modules/instruction` | List all InstructionModules |
| GET | `/api/modules/instruction/:id` | Get by ID |
| POST | `/api/modules/instruction` | Create |
| PUT | `/api/modules/instruction/:id` | Update |
| DELETE | `/api/modules/instruction/:id` | Delete |

### Request Body

```typescript
{
  label: string,
  base?: string[],
  runtimePatchable?: boolean
}
```

---

## 4. ToolkitModule CRUD

### Endpoint: `/api/modules/toolkit`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/modules/toolkit` | List all ToolkitModules |
| GET | `/api/modules/toolkit/:id` | Get by ID |
| POST | `/api/modules/toolkit` | Create |
| PUT | `/api/modules/toolkit/:id` | Update |
| DELETE | `/api/modules/toolkit/:id` | Delete |

### Request Body

```typescript
{
  label: string,
  tools?: string[]  // Array of tool IDs like ['web.search', 'sandbox.exec']
}
```

---

## 5. Category CRUD

### Endpoint: `/api/categories`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/categories` | List all categories (with nested channels) |
| POST | `/api/categories` | Create category |
| PUT | `/api/categories/:id` | Update category |
| PATCH | `/api/categories/:id` | Partial update |
| DELETE | `/api/categories/:id` | Delete (cascades to channels) |

### Request Body (POST /api/categories)

```typescript
{
  name: string,            // Required
  ownedByAgentId?: string | null,
  embeddingProfileId?: string | null,
  createdBy: string,       // Required
  position?: number        // Default: 0
}
```

### Response Structure

```typescript
{
  id: string,
  name: string,
  ownedByAgentId: string | null,
  embeddingProfileId: string | null,
  createdBy: string,
  position: number,
  channels: Channel[]  // Nested channel array
}
```

### Frontend Implementation

```typescript
// CREATE
createCategory: async (name) => {
  await fetch(`${BACKEND_URL}/api/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      createdBy: 'user',
      position: workspaces[activeWorkspaceId].categories.length
    })
  });
  await get().fetchWorkspaces();
}

// DELETE
deleteCategory: async (categoryId) => {
  await fetch(`${BACKEND_URL}/api/categories/${categoryId}`, {
    method: 'DELETE'
  });
  await get().fetchWorkspaces();
}

// REORDER
reorderCategory: async (categoryId, direction) => {
  // Optimistic UI update
  // Then batch PUT updates for all positions
  await Promise.all(categories.map((cat, pos) =>
    fetch(`${BACKEND_URL}/api/categories/${cat.id}`, {
      method: 'PUT',
      body: JSON.stringify({ position: pos })
    })
  ));
}
```

---

## 6. Channel CRUD

### Endpoint: `/api/channels`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels` | List all channels |
| POST | `/api/channels` | Create channel |
| PUT | `/api/channels/:id` | Update channel |
| PATCH | `/api/channels/:id` | Partial update |
| DELETE | `/api/channels/:id` | Delete |

### Request Body (POST /api/channels)

```typescript
{
  categoryId?: string | null,  // null = top-level channel
  name: string,                // Required
  type?: 'standard' | 'pair_private' | 'archived',
  createdBy: string,           // Required
  position?: number            // Default: 0
}
```

### Special Rules

- **Top-level #general cannot be deleted** → Returns **409 Conflict**
- Moving to archived type sets `archivedAt` timestamp automatically

### Frontend Implementation

```typescript
// CREATE
createChannel: async (categoryId, name, description) => {
  await fetch(`${BACKEND_URL}/api/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      categoryId,
      name,
      createdBy: 'user',
      position: calculatePosition(categoryId)
    })
  });
  await get().fetchWorkspaces();
}

// ARCHIVE/RESTORE
archiveChannel: async (channelId, archive) => {
  await fetch(`${BACKEND_URL}/api/channels/${channelId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: archive ? 'archived' : 'standard'
    })
  });
  await get().fetchWorkspaces();
}

// DELETE
deleteChannel: async (channelId) => {
  await fetch(`${BACKEND_URL}/api/channels/${channelId}`, {
    method: 'DELETE'
  });
  await get().fetchWorkspaces();
}

// REORDER
reorderChannel: async (channelId, direction) => {
  // Same pattern as reorderCategory - optimistic UI + batch sync
}
```

---

## 7. Provider Profiles CRUD

### Generation Model Profiles

**Endpoint:** `/api/providers/generation`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/providers/generation` | List generation profiles |
| GET | `/api/providers/generation/:id` | Get profile |
| POST | `/api/providers/generation` | Create |
| PUT | `/api/providers/generation/:id` | Update |
| DELETE | `/api/providers/generation/:id` | Delete |
| POST | `/api/providers/generation/:id/test` | Test API connection |

### Embedding Model Profiles

**Endpoint:** `/api/providers/embedding`

Same CRUD structure as generation profiles.

### Indexing Model Profiles

**Endpoint:** `/api/providers/indexing`

Same CRUD structure as generation profiles.

---

## 8. Workspace Settings CRUD

### Endpoint: `/api/workspace/settings`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workspace/settings` | Get workspace settings |
| PUT | `/api/workspace/settings` | Update general settings |

### Request Body (PUT /api/workspace/settings)

```typescript
{
  globalSoftCap?: number  // Token budget soft cap
}
```

---

## 9. Budget Management

### Endpoint: `/api/workspace/budget`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workspace/budget` | Get budget info |
| PUT | `/api/workspace/budget` | Update budget limits |
| POST | `/api/workspace/budget/reset` | Reset usage counters |

### Request Body (PUT /api/workspace/budget)

```typescript
{
  globalSoftCap?: number,
  perProviderBudget?: Record<string, {
    softCap: number,
    used?: number,
    resetPeriod: 'daily' | 'weekly' | 'monthly' | 'never',
    lastResetAt?: string
  }>
}
```

---

## 10. Messages CRUD

### Endpoint: `/api/channels/:channelId/messages`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels/:channelId/messages` | List messages in channel |

**Note:** Message creation happens via **Socket.io** (`user:message` event), not REST.

---

## Real-Time Sync Pattern

All CRUD operations follow this pattern:

```typescript
// Backend route handler
app.post('/api/agents', async (request, reply) => {
  const agent = await registry.create(request.body);
  
  // Emit WebSocket event to all clients
  globalBroker?.emit("workspace:sync", {});
  
  return reply.status(201).send(agent);
});

// Frontend store action
addAgent: async (agentData) => {
  await fetch('/api/agents', {
    method: 'POST',
    body: JSON.stringify(agentData)
  });
  
  // Fetch refreshed state from DB
  await get().fetchWorkspaces();
}

// Socket listener (automatic sync on workspace:sync)
socket.on('workspace:sync', () => {
  get().fetchWorkspaces();  // Refresh all data
});
```

---

## Error Handling

### Standard Error Format

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Agent not found"
}
```

### Common Status Codes

| Code | Meaning | Example |
|------|---------|---------|
| 200 | Success | PUT /api/agents/:id |
| 201 | Created | POST /api/agents |
| 204 | No Content | DELETE /api/agents/:id |
| 400 | Bad Request | Validation error |
| 404 | Not Found | Entity doesn't exist |
| 409 | Conflict | Referential integrity violation |

---

## Zod Validation

All endpoints use **Zod schemas** for request validation. Invalid requests return **400 Bad Request**.

Example: Creating an agent with missing fields

```typescript
// Request
POST /api/agents
Body: { name: "" }  // Fails: min(1)

// Response
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Invalid input: name must contain at least 1 character"
}
```

---

## Summary Table

| Entity | CREATE | READ (List) | READ (One) | UPDATE | DELETE | Special |
|--------|--------|-------------|------------|--------|--------|---------|
| Agent | ✅ | ✅ | ✅ | ✅ | ✅ | Module refs required |
| ModelModule | ✅ | ✅ | ✅ | ✅ | ✅ | Connection test endpoint |
| InstructionModule | ✅ | ✅ | ✅ | ✅ | ✅ | Runtime-patchable |
| ToolkitModule | ✅ | ✅ | ✅ | ✅ | ✅ | Tool array management |
| ConstraintsModule | ✅ | ✅ | ✅ | ✅ | ✅ | Rules & disallow lists |
| CapabilitiesModule | ✅ | ✅ | ✅ | ✅ | ✅ | Skills & functionSchemas |
| Category | ✅ | ✅ | ❌ | ✅ | ✅ | Cascades to channels |
| Channel | ✅ | ✅ | ❌ | ✅ | ✅ | Archive/restore support |
| GenerationProfile | ✅ | ✅ | ✅ | ✅ | ✅ | API key configuration |
| EmbeddingProfile | ✅ | ✅ | ✅ | ✅ | ✅ | Dimensions parameter |
| IndexingProfile | ✅ | ✅ | ✅ | ✅ | ✅ | Read-only endpoints |
| Workspace Settings | ❌ | ✅ | N/A | ✅ | ❌ | Singleton record |
| Budget | ❌ | ✅ | N/A | ✅ | ❌ | Reset endpoint available |
| Message | 🔌 | ✅ | ❌ | ❌ | ❌ | Socket-only creation |

**Legend:** ✅ = Full CRUD, ❌ = Not available, 🔌 = Socket.io only

---

## Files Reference

| Path | Purpose |
|------|---------|
| `packages/server/src/routes/agents.ts` | Agent CRUD routes |
| `packages/server/src/routes/modules.ts` | Module CRUD routes (all 5 types) |
| `packages/server/src/routes/categories.ts` | Category CRUD routes |
| `packages/server/src/routes/channels.ts` | Channel CRUD routes |
| `packages/server/src/routes/providers.ts` | Provider profile CRUD routes |
| `packages/server/src/routes/workspace.ts` | Settings & budget routes |
| `packages/client/stores/crowd-os-store.ts` | Frontend CRUD actions + socket listeners |
