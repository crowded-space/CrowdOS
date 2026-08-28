# Backend Architecture — CrowdOS

> **Package:** \packages/server\
> **Tech Stack:** Node.js, TypeScript, Fastify v5, Drizzle ORM (postgres-js), PostgreSQL + pgvector, Socket.io v4, Zod v4
> **Date:** 2026-05-24

---

## 1. Overview

CrowdOS backend is a **modular, event-driven API server** that powers an identity-driven multi-agent orchestration platform. It provides REST endpoints for CRUD operations across agents, modules, channels, categories, and providers; a WebSocket layer for real-time messaging and agent status streaming; and a runtime engine for agent orchestration (L0–L3 hierarchy).

The server is designed around a **module-first agent architecture**: agents store only identity (name, species, tier). All cognitive configuration comes from reusable **ModelModule**, **InstructionModule**, **ToolkitModule**, **ConstraintsModule**, and **CapabilitiesModule** references. Runtime behavior can be temporarily patched via **RuntimeOverride**.

---

## 2. File Structure

packages/server/
├── .env                          # Environment variables
├── drizzle.config.ts             # Drizzle Kit config
├── package.json                  # Dependencies & scripts
├── tsconfig.json                 # TypeScript config
├── test_budget.js                # Standalone budget test script
├── test_google_routing.js        # Standalone Google routing test
├── test_index.js                 # Standalone indexing test
├── test_spawn.js                 # Standalone spawn test
├── dist/                         # Compiled JS output
└── src/
    ├── index.ts                  # ★ Server entrypoint
    ├── config/
    │   ├── env.ts                # Zod-validated environment loader
    │   └── database.ts           # PostgreSQL connection (Drizzle ORM singleton)
    ├── db/
    │   ├── schema.ts             # ★ ALL 25+ Drizzle ORM table definitions
    │   ├── bootstrap.ts          # Schema push / raw SQL table creation
    │   ├── seed.ts               # Default seed data
    │   ├── check.ts              # Integration roundtrip verification
    │   └── migrations/.gitkeep
    ├── core/
    │   ├── EventBroker.ts        # Typed EventEmitter for inter-module comms
    │   ├── errors.ts             # Fastify error handler (Zod + generic)
    │   ├── validation.ts         # Zod validator compiler for Fastify
    │   ├── AgentRegistry.ts      # Agent CRUD service layer
    │   ├── AgentSpawnManager.ts  # L3 Worker-Supervisor pair spawner
    │   ├── AgentErrors.ts        # Error types + EscalationChain
    │   ├── LoopArbiter.ts        # Levenshtein-based loop detection
    │   ├── TokenTracker.ts       # Token billing & budget safety
    │   ├── IndexBuilder.ts       # Channel indexing & drift management
    │   ├── L1Runtime.ts          # L1 CEO agent runtime (mock + real Gemini)
    │   ├── L2Runtime.ts          # L2 Manager agent runtime
    │   ├── LibrarianRuntime.ts   # Librarian specialist agent runtime
    │   ├── MemoryBuilder.ts      # Prompt assembly (3-tier compression)
    │   ├── MentionParser.ts      # @mention parser + Levenshtein typo correction
    │   ├── modelRouter.ts        # Google/Vertex AI endpoint routing
    │   └── PromptFormatter.ts    # XML message formatter for LLMs
    ├── routes/
    │   ├── index.ts              # Route aggregator (10 route modules)
    │   ├── health.ts             # GET /health
    │   ├── agents.ts             # /api/agents CRUD
    │   ├── modules.ts            # /api/modules CRUD (5 types x 6 ops)
    │   ├── providers.ts          # /api/providers CRUD (legacy profiles)
    │   ├── workspace.ts          # /api/workspace settings + budget + database
    │   ├── messages.ts           # GET /api/channels/:channelId/messages
    │   ├── channels.ts           # /api/channels CRUD
    │   └── categories.ts         # /api/categories CRUD
    ├── sockets/
    │   └── registerSocketServer.ts  # Socket.io setup + user:message handler
    ├── types/
    │   ├── index.ts              # Re-exports + StandardMessage
    │   ├── event.types.ts        # BrokerEvent types & socket maps
    │   ├── agent.types.ts        # AgentProfile, CreateAgentProfileInput
    │   ├── message.types.ts      # ChannelMessage interface
    │   ├── channel.types.ts      # Category, Channel, ChannelIndex
    │   ├── module.types.ts       # ModelModule, InstructionModule, etc.
    │   ├── provider.types.ts     # Legacy GenerationModelProfile
    │   ├── runtime.types.ts      # RuntimeOverride, RuntimeState
    │   ├── task.types.ts         # SubtaskDefinition, SpawnRequest, TaskFile
    │   ├── tool.types.ts         # ToolDefinition, ToolCall
    │   ├── mention.types.ts      # MentionMetadata, MentionType
    │   └── workspace.types.ts    # Workspace, WorkspaceNode
    ├── tools/
    │   ├── registry.ts           # Central tool registry (11 definitions)
    │   ├── ToolExecutor.ts       # Authorization + execution engine
    │   └── safety/
    │       └── Guard.ts          # Path traversal + command blacklist
    ├── vfs/
    │   ├── index.ts              # VFS barrel export
    │   ├── vfs.interface.ts      # VirtualFS interface
    │   ├── local-vfs.ts          # Local disk VFS + PostgreSQL sync
    │   └── path-guard.ts         # Path normalization & safety
    └── workspace/
        ├── workspace-manager.ts  # Workspace lifecycle + agent mounting
        └── permission-guard.ts   # Permission assertions

**~50 source files total**

---

## 3. Tech Stack

| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js + TypeScript | ~5.8.2 TS |
| HTTP Framework | Fastify | ^5.8.5 |
| ORM | Drizzle ORM | ^0.45.2 |
| DB Driver | postgres (postgres.js) | ^3.4.9 |
| Database | PostgreSQL + pgvector | - |
| Validation | Zod | ^4.3.6 |
| WebSocket | Socket.io | ^4.8.1 |
| Logging | pino (built into Fastify) | - |
| Testing | Vitest | ^4.1.4 |

### Scripts

| Script | Command |
|---|---|
| dev | tsx watch src/index.ts |
| build | tsc -p tsconfig.json |
| test | vitest run |
| typecheck | tsc --noEmit |
| db:push | tsx src/db/bootstrap.ts |
| db:push:drizzle | drizzle-kit push --force |
| db:seed | tsx src/db/seed.ts |
| db:check | tsx src/db/check.ts |
