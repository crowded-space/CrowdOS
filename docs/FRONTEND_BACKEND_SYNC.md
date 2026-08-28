# Frontend-to-Backend Synchronization — CrowdOS

## Overview

CrowdOS uses a **Socket-first, Zustand-backed** synchronization architecture. The frontend maintains local state via Zustand while staying connected to the backend through Socket.io for real-time event streaming.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Client)                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Zustand Store                             │   │
│  │  - workspaces, agents, messages, modules                    │   │
│  │  - localStorage persistence                                 │   │
│  │  - UI state (sidebar, modals, etc.)                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↕                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  Socket.io Client                           │   │
│  │  - Connected: http://localhost:3001                         │   │
│  │  - Transports: websocket, polling                           │   │
│  │  - Auto-reconnect: enabled                                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              ↕ Socket.io
┌─────────────────────────────────────────────────────────────────────┐
│                         BACKEND (Server)                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  Socket.io Server                           │   │
│  │  - Event registration                                       │   │
│  │  - Broadcast to all clients                                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↕                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   EventBroker                               │   │
│  │  - EventEmitter wrapper                                     │   │
│  │  - Channel-scoped events                                    │   │
│  │  - Recent event cache (50 per channel)                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↕                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                 Agent Runtimes                              │   │
│  │  - L1Runtime (Executive)                                    │   │
│  │  - L2Runtime (Coordinator)                                  │   │
│  │  - L3Runtime (Worker)                                       │   │
│  │  - LibrarianRuntime (Indexer)                               │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↕                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │               PostgreSQL Database                           │   │
│  │  - agents, messages, channels, categories                   │   │
│  │  - modules (instruction, model, toolkit)                    │   │
│  │  - workspaces, budgets, tasks                               │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Socket Events Reference

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `user:message` | `{ channelId, content, mentions? }` | User sends a message to a channel |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | `ChannelMessage` | New message persisted to DB |
| `message:stream` | `{ channelId, agentId, chunk }` | Streaming token chunks from agent |
| `agent:status` | `{ agentId, status }` | Agent status change (idle/working/paused/offline) |
| `agent:thinking` | `{ agentId, channelId }` | Agent is thinking/processing |
| `workspace:sync` | `void` | Trigger workspace refresh |
| `budget:exceeded` | `{ provider, used, limit }` | Budget threshold exceeded |
| `budget:warning` | `{ provider, used, limit }` | Budget approaching limit |

---

## Message Flow

### 1. User Sends Message

**Frontend (`crowd-os-store.ts`):**
```typescript
addMessage: (msg: Omit<Message, 'id' | 'timestamp'>) => {
  const activeCh = get().activeChannelId;
  if (!activeCh) return;

  // 1. If socket connected, emit to backend
  if (socket.connected) {
    socket.emit('user:message', {
      channelId: activeCh,
      content: msg.content,
      mentions: msg.mentions || []
    });
    return;
  }

  // 2. Offline fallback: local simulation
  const newMsg: Message = {
    ...msg,
    id: `msg-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString()
  };
  const updated = [...get().messages, newMsg];
  localStorage.setItem('crowdos_messages', JSON.stringify(updated));
  set({ messages: updated });
}
```

**Backend (`registerSocketServer.ts`):**
```typescript
io.on("connection", (socket) => {
  socket.on("user:message", async (payload) => {
    const { channelId, content } = payload;

    // 1. Parse mentions (@agent, @role)
    const resolvedMentions = await mentionParser.parseMentions(content);

    // 2. Persist user message to PostgreSQL
    const userMsg: ChannelMessage = {
      id: `msg-${Date.now()}`,
      channelId,
      authorId: "user-1",
      authorName: "Human Operator",
      authorType: "user",
      content,
      mentions: resolvedMentions,
      timestamp: new Date(),
    };
    await db.insert(messages).values(userMsg);

    // 3. Broadcast via EventBroker
    broker.emit("message:new", userMsg, { channelId });

    // 4. Trigger agent responses based on mentions
    if (resolvedMentions.length > 0) {
      for (const mention of resolvedMentions) {
        const agent = allAgents.find(a => a.id === mention.targetId);
        if (agent.authorityLevel === 1) {
          await l1Runtime.execute(broker, channelId, agent, content);
        }
        // ... L2, L3 handling
      }
    }
  });
});
```

### 2. Agent Response Streaming

**Backend (`registerSocketServer.ts` → `triggerAgentReply`):**
```typescript
async function triggerAgentReply(broker, channelId, agent) {
  // 1. Update agent status
  await db.update(agents).set({ status: "working" });
  broker.emit("agent:status", { agentId: agent.id, status: "working" });
  broker.emit("agent:thinking", { agentId: agent.id, channelId });

  // 2. Stream reply chunks
  const chunks = ["Hello!", "Processing...", "Done."];
  chunks.forEach((chunk, i) => {
    setTimeout(() => {
      broker.emit("message:stream", { channelId, agentId: agent.id, chunk });
    }, 150 * (i + 1));
  });

  // 3. Persist final message
  setTimeout(async () => {
    const agentMsg: ChannelMessage = {
      id: `msg-${Date.now()}-agent-${agent.id}`,
      channelId,
      authorId: agent.id,
      authorName: agent.name,
      authorType: "agent",
      content: chunks.join(""),
      timestamp: new Date(),
    };
    await db.insert(messages).values(agentMsg);
    broker.emit("message:new", agentMsg, { channelId });

    // 4. Reset status
    await db.update(agents).set({ status: "idle" });
    broker.emit("agent:status", { agentId: agent.id, status: "idle" });
  }, 150 * chunks.length + 200);
}
```

**Frontend (`crowd-os-store.ts` socket listeners):**
```typescript
// Stream chunk handler
socket.on('message:stream', (payload: any) => {
  const activeCh = get().activeChannelId;
  if (payload.channelId !== activeCh) return;

  set(state => {
    const existingIdx = state.messages.findIndex(m => m.id === `stream-${payload.agentId}`);
    let updated = [...state.messages];

    if (existingIdx !== -1) {
      // Append to existing stream
      updated[existingIdx] = {
        ...updated[existingIdx],
        content: updated[existingIdx].content + payload.chunk
      };
    } else {
      // Create new streaming message
      updated.push({
        id: `stream-${payload.agentId}`,
        type: 'agent',
        content: payload.chunk,
        authorId: payload.agentId,
        authorName: 'Agent Swarm',
        channelId: payload.channelId,
        timestamp: new Date().toISOString()
      });
    }
    return { messages: updated };
  });
});

// Final message handler
socket.on('message:new', (msg: any) => {
  const activeCh = get().activeChannelId;
  
  // Map backend ChannelMessage → frontend Message
  const mapped: Message = {
    id: msg.id,
    type: msg.authorType === 'user' ? 'human' : 'agent',
    content: msg.content,
    authorId: msg.authorId,
    authorName: msg.authorName,
    channelId: msg.channelId,
    timestamp: new Date(msg.timestamp).toISOString(),
    mentions: msg.mentions?.map((m: any) => m.targetName) || []
  };

  set(state => {
    if (state.messages.some(m => m.id === mapped.id)) return state;
    
    const updatedMessages = [...state.messages, mapped];
    localStorage.setItem('crowdos_messages', JSON.stringify(updatedMessages));

    // Increment unread count if not active channel
    let updatedWorkspaces = state.workspaces;
    if (mapped.channelId !== activeCh) {
      updatedWorkspaces = state.workspaces.map(ws => ({
        ...ws,
        categories: ws.categories.map(cat => ({
          ...cat,
          channels: cat.channels.map(ch => 
            ch.id === mapped.channelId 
              ? { ...ch, unreadCount: ch.unreadCount + 1 }
              : ch
          )
        }))
      }));
    }

    return { messages: updatedMessages, workspaces: updatedWorkspaces };
  });
});
```

---

## State Persistence Strategy

### LocalStorage Keys

| Key | Data | Migration |
|-----|------|-----------|
| `crowdos_active_workspace` | Active workspace ID | `ws-crowdos` → `crowdos` |
| `crowdos_workspaces` | Workspace tree (categories, channels) | Auto-migrated |
| `crowdos_agents` | Agent roster | Auto-migrated |
| `crowdos_model_profiles` | Model profiles | Auto-migrated |
| `crowdos_messages` | Message history | Auto-migrated |

### Sync on Workspace Enter

```typescript
fetchWorkspaces: async () => {
  set({ isFetchingWorkspaces: true });
  try {
    // 1. Fetch categories & channels from PostgreSQL
    const catRes = await fetch(`${BACKEND_URL}/api/categories`);
    const chanRes = await fetch(`${BACKEND_URL}/api/channels`);
    
    // 2. Fetch agents from PostgreSQL
    const agentRes = await fetch(`${BACKEND_URL}/api/agents`);
    
    // 3. Fetch modules from PostgreSQL
    const moduleRes = await fetch(`${BACKEND_URL}/api/modules`);
    
    // 4. Fetch model profiles from PostgreSQL
    const profRes = await fetch(`${BACKEND_URL}/api/providers/generation`);
    
    // 5. Fetch budget telemetry
    await get().fetchBudget();
    
    // Update Zustand state + localStorage
    set({ workspaces: dbWorkspaces, agents: dbAgents, ... });
  } catch (err) {
    // Fallback to local simulation mode
    console.warn("Backend offline, using local state");
  }
}
```

---

## EventBroker Architecture

The backend uses `EventBroker` as a central event hub:

```typescript
export class EventBroker {
  private readonly emitter = new EventEmitter();
  private readonly listeners = new Map<string, ListenerRegistration>();
  private readonly recentEventsByChannel = new Map<string, BrokerEvent[]>();

  emit(type, payload, options?: { channelId?: string }) {
    const event = {
      eventId: randomUUID(),
      type,
      channelId: options?.channelId,
      payload,
      timestamp: new Date()
    };
    
    // Cache for recent events (50 per channel)
    if (event.channelId) {
      const recent = this.recentEventsByChannel.get(event.channelId) ?? [];
      recent.push(event);
      if (recent.length > 50) recent.shift();
      this.recentEventsByChannel.set(event.channelId, recent);
    }

    // Emit to Socket.io
    this.emitter.emit(type, event);
    this.emitter.emit("*", event);
    return event;
  }

  on(type, channelId, handler) {
    // Register listener with optional channel scoping
  }

  onAny(handler) {
    // Wildcard listener for all events
  }
}
```

**Socket.io Integration:**
```typescript
// In registerSocketServer.ts
broker.onAny((event) => {
  io.emit(event.type, event.payload);
});

// All broker events automatically broadcast to connected clients
broker.emit("message:new", userMsg, { channelId });  // → Socket.io → All clients
```

---

## Connection States

### Connected (Live Mode)
1. User message → `socket.emit('user:message')` → Backend
2. Backend persists to PostgreSQL
3. Backend triggers agent runtimes
4. Agent responses stream via `broker.emit('message:stream')`
5. Final messages broadcast via `broker.emit('message:new')`
6. Frontend updates Zustand state + localStorage

### Disconnected (Offline Mode)
1. User message → Local simulation
2. Simulated agent responses (thinking → delegating → executing)
3. Messages stored in localStorage only
4. No database persistence
5. Reconnect triggers `fetchWorkspaces()` to sync

---

## Testing

### Unit Tests (`store.test.ts`)
- Zustand state initialization
- LocalStorage migration (`ws-crowdos` → `crowdos`)
- Mobile drawer toggles
- ModelModule delete rejection handling

### E2E Tests (`e2e/smoke.spec.ts`)
- Portal workspace entry
- Channel switching
- VFS sandbox connectivity
- Agent roster display

---

## Key Files

| Path | Purpose |
|------|---------|
| `packages/client/stores/crowd-os-store.ts` | Zustand state + socket listeners |
| `packages/client/src/config/socket.ts` | Socket.io client configuration |
| `packages/server/src/sockets/registerSocketServer.ts` | Socket.io server + event handlers |
| `packages/server/src/core/EventBroker.ts` | Central event hub |
| `packages/server/types/event.types.ts` | Typed event payloads |

---

## Design Principles

1. **Socket-first**: Prefer real-time sync when connected
2. **Offline-resilient**: Graceful fallback to local simulation
3. **Channel-scoped**: Events filtered by `channelId` for relevance
4. **Persistent**: LocalStorage backup for offline continuity
5. **Typed**: Full TypeScript types for events, messages, agents
6. **Modular**: EventBroker decouples agent runtimes from transport
