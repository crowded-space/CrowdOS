# 00 Project Overview — CrowdOS

## What this project is
- A **CrowdOS** (Community Agent) — single-user multi-agent orchestration platform.
- Agents are **identity-driven**: each agent is just a name, species (`agent`/`worker`/`supervisor`), and tier (1–3).
- All cognitive configuration (system prompts, model parameters, tool permissions) lives in **reusable modules**: `InstructionModule`, `ModelModule`, `ToolkitModule`.
- Runtime behavior can be temporarily patched via `RuntimeOverride`.
- UI looks like Discord: categories, channels, chat, member list.
- Agents have authority levels: L0 (omniscient), L1 (CEO), L2 (Manager), L3 (Worker/Supervisor).
- Backend is event-driven, not blocking request chains.

## Core CrowdOS Modules
| Module | Purpose | Reusable? |
|--------|---------|-----------|
| `InstructionModule` | System prompt, description, text-to-speech flag | ✅ Yes |
| `ModelModule` | Provider + model name + parameters (temp, max_tokens) | ✅ Yes |
| `ToolkitModule` | Bundled tool permission sets (tool IDs) | ✅ Yes |
| `RuntimeOverride` | Temporary instruction patch with expiry | Per-agent |
| `RuntimeState` | Live execution state (status, pause, error, task) | Per-instance |

## Main components
- Frontend app (React + Vite)
- Backend API + Socket server (Fastify)
- Database + schema (PostgreSQL + Drizzle)
- Agent registry (identity + module references)
- Module CRUD (Instruction, Model, Toolkit)
- Runtime override system
- Runtime state tracking
- Workspace/channel system
- Prompt and memory system
- Router and dispatch (Bipolar L1)
- Spawn manager for L3 pairs
- Tool system (ToolkitModule-based)
- Error handling and budget tracking
- Testing

## Build strategy
- Start with a real chat app shell.
- Add **module CRUD** before agent CRUD (modules are dependencies).
- Add CRUD and persistence before LLM logic.
- Add one agent flow first: user -> L1 -> response.
- Add multi-agent routing only after the single-agent path is stable.
- Add safety and observability before heavy automation.

## Definition of done for each feature
- Data model exists.
- Module/Backend API exists.
- UI path exists.
- Realtime updates work if needed.
- Tests cover the critical path.
- Manual test can be performed from the browser.
