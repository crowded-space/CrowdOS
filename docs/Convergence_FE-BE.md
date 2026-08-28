# CrowdOS — FE/BE Convergence Architecture Spec

## Unified Runtime Convergence Layer

### For Codex Implementation

Reference context:

* CrowdOS philosophy & architecture 
* Modern agent-runtime convergence patterns ([docs.ag-ui.com][1])

---

# OBJECTIVE

CrowdOS currently has:

* independently evolved Frontend architecture
* independently evolved Backend runtime
* partially divergent orchestration models
* duplicated concepts
* partially wired features

This spec defines:

# Runtime Convergence Architecture

Goal:

```txt
Merge FE concepts + BE runtime
WITHOUT rewriting either side
WITHOUT duplicate features
WITHOUT destroying CrowdOS vision
```

---

# CORE PHILOSOPHY

CrowdOS is NOT:

```txt
traditional frontend + api backend
```

CrowdOS IS:

```txt
distributed orchestration runtime
```

Therefore:

* FE is NOT dumb client
* BE is NOT CRUD API
* BOTH are orchestration participants

But:

# contracts MUST become authoritative

---

# TARGET ARCHITECTURE

```txt
Frontend
= Cognitive Projection Layer

Backend
= Runtime Execution Layer

Shared Contracts
= Orchestration Truth Layer
```

---

# PRIMARY GOAL

Create:

# Runtime Convergence Layer

that allows:

```txt
FE-driven concepts
+
BE runtime execution
=
Unified CrowdOS Runtime
```

---

# CRITICAL RULES

## RULE 1 — NO FULL REWRITE

DO NOT:

* rewrite FE
* rewrite BE
* rebuild architecture

ONLY:

* converge
* reconcile
* canonicalize
* wire

---

## RULE 2 — NO DUPLICATED FEATURES

If:

* FE feature exists
* BE equivalent exists

Then:

```txt
MERGE
DO NOT REBUILD
```

---

## RULE 3 — NO FEATURE LOSS

Preserve:

* FE UX concepts
* BE runtime concepts
* orchestration abstractions
* governance systems
* workspace models
* swarm concepts
* escalation systems

---

## RULE 4 — CONTRACTS ARE CANONICAL

ALL shared structures MUST originate from:

```txt
packages/shared
```

NEVER:

* redefine DTOs in FE
* redefine events in FE
* redefine schemas in FE
* redefine contracts in BE

---

# REQUIRED IMPLEMENTATION

---

# PHASE 1 — FEATURE CONVERGENCE AUDIT

## Objective

Build full feature inventory.

---

# Required File

```txt
/docs/runtime-convergence-matrix.md
```

---

# Required Matrix Format

| Feature            | FE      | BE             | Status         | Action   |
| ------------------ | ------- | -------------- | -------------- | -------- |
| Agent Lifecycle    | Partial | Full           | Diverged       | Merge    |
| Swarm Runtime      | UX Only | Missing        | FE Ahead       | Add BE   |
| Runtime Overrides  | Partial | Full           | Partial Wiring | Wire     |
| Capability Modules | Missing | Exists         | BE Ahead       | Add FE   |
| Sandbox Streams    | Partial | Partial        | Incomplete     | Shared   |
| Parliament Flow    | UX      | Runtime        | Diverged       | Merge    |
| Workspace Sync     | Partial | Partial        | Desync         | Refactor |
| Provider Routing   | Hidden  | Full           | Missing FE     | Add FE   |
| Escalation Graph   | UX Only | Runtime Exists | Partial        | Merge    |

---

# Required Status Types

```txt
FULLY_SYNCED
FE_ONLY
BE_ONLY
PARTIAL
DIVERGED
LEGACY
MOCK_ONLY
INCOMPLETE
```

---

# Required Action Types

```txt
MERGE
WIRE
REMOVE_DUPLICATION
ADD_FE
ADD_BE
REFACTOR
CANONICALIZE
DEPRECATE
```

---

# PHASE 2 — SHARED CONTRACTS PACKAGE

## REQUIRED

Create:

```txt
packages/shared
```

---

# REQUIRED STRUCTURE

```txt
packages/shared/
├── contracts/
├── runtime/
├── events/
├── schemas/
├── orchestration/
├── modules/
├── lifecycle/
├── escalation/
├── sandbox/
└── workspace/
```

---

# REQUIRED TECHNOLOGY

Use:

* TypeScript
* Zod
* discriminated unions

---

# REQUIRED EXPORTS

## Events

```ts
AgentSpawnedEvent
AgentLifecycleEvent
RuntimeSnapshotEvent
EscalationEvent
SandboxUpdatedEvent
WorkspacePatchedEvent
```

---

## Runtime Contracts

```ts
AgentRuntimeState
SwarmState
ConspiracyState
WorkspaceRuntimeState
SandboxState
```

---

## Module Contracts

```ts
ModelModule
InstructionModule
ToolkitModule
ConstraintsModule
CapabilitiesModule
```

---

# PHASE 3 — SOCKET EVENT CANONICALIZATION

## PROBLEM

FE and BE currently use partially divergent runtime assumptions.

---

## REQUIRED

ALL socket events MUST use shared contracts.

---

# REQUIRED EVENT SYSTEM

## Shared Event Registry

Create:

```txt
packages/shared/events/runtime-events.ts
```

---

# REQUIRED EVENT TYPES

```ts
agent:spawned
agent:despawned
agent:paused
agent:resumed
agent:lifecycle

runtime:state
runtime:snapshot
runtime:override

workspace:patched
workspace:snapshot

sandbox:updated
sandbox:stream
sandbox:process

swarm:created
swarm:updated
swarm:terminated

escalation:created
escalation:updated
escalation:resolved
```

---

# REQUIRED SOCKET RULE

Frontend MUST NOT invent state.

Frontend ONLY:

* projects runtime
* caches ephemeral UI state
* dispatches intent

---

# PHASE 4 — RUNTIME SNAPSHOT RECONCILIATION

## REQUIRED

Backend emits periodic authoritative snapshots.

---

# REQUIRED EVENT

```ts
runtime:snapshot
```

---

# REQUIRED PAYLOAD

```ts
{
  workspaces
  agents
  swarms
  escalations
  sandboxes
  overrides
  runtimeHealth
}
```

---

# REQUIRED FE BEHAVIOR

Frontend reconciles:

* missing entities
* stale entities
* zombie agents
* stale swarm members
* outdated overrides

---

# REQUIRED OUTCOME

Prevent:

* state drift
* stale runtime
* phantom agents
* hidden escalations
* socket desync

---

# PHASE 5 — MODULE SYSTEM PARITY

## CURRENT PROBLEM

Backend module system is ahead of FE.

---

# REQUIRED FE SUPPORT

Add FE support for:

```ts
ConstraintsModule
CapabilitiesModule
```

---

# REQUIRED UI LOCATIONS

Update:

* AgentProfileModal
* WorkspaceSettingsModal
* runtime override editor
* orchestration planner
* module selectors
* agent creation flow

---

# REQUIRED CAPABILITY FEATURES

Frontend MUST support:

* capability visualization
* delegation permissions
* tool availability
* execution scopes
* orchestration compatibility

---

# PHASE 6 — AGENT LIFECYCLE CENTRALIZATION

## REQUIRED

Create:

# Agent Runtime Supervisor

---

# REQUIRED RESPONSIBILITIES

Single runtime authority for:

```txt
spawn
pause
resume
terminate
delegate
recover
escalate
handoff
```

---

# REQUIRED STORAGE

Runtime registry MUST track:

```ts
agentId
workspaceId
runtimeState
provider
sandboxId
swarmId
health
lastHeartbeat
```

---

# REQUIRED RULE

Lifecycle changes ONLY through supervisor.

---

# PHASE 7 — PROVIDER CONVERGENCE

## REQUIRED FE ADDITIONS

Expose:

* provider health
* routing chains
* failover visualization
* latency metrics
* orchestration routing
* fallback state

---

# REQUIRED BE FEATURES

Normalize:

* streaming
* tool calls
* retries
* cancellation
* usage metrics

---

# PHASE 8 — SANDBOX + VFS CONVERGENCE

## CURRENT STATUS

Most mature subsystem.

---

# REQUIRED ADDITIONS

Add:

* sandbox process streaming
* execution logs
* collaborative VFS updates
* file locking
* terminal synchronization
* runtime artifact streams

---

# PHASE 9 — GOVERNANCE / ESCALATION CONVERGENCE

## REQUIRED

Visualize:

* escalation chains
* Parliament sessions
* runtime overrides
* governance interventions
* Strike lifecycle
* escalation reasoning

---

# REQUIRED EVENTS

```ts
escalation:created
escalation:updated
parliament:convened
strike:initiated
override:applied
```

---

# PHASE 10 — DUPLICATION ELIMINATION

## REQUIRED AUDIT

Find:

* duplicated DTOs
* duplicated enums
* duplicated runtime models
* duplicated event payloads
* duplicated orchestration schemas

---

# REQUIRED RULE

If duplicated:

```txt
MOVE TO SHARED
```

---

# REQUIRED IMPLEMENTATION ORDER

# P0

Shared contracts package.

---

# P1

Feature convergence matrix.

---

# P2

Socket event canonicalization.

---

# P3

Runtime snapshot reconciliation.

---

# P4

Module system parity.

---

# P5

Lifecycle supervisor.

---

# P6

Escalation/governance convergence.

---

# P7

Provider visualization convergence.

---

# REQUIRED NON-GOALS

DO NOT:

* convert FE into thin client
* remove orchestration intelligence from FE
* remove runtime concepts from UI
* simplify CrowdOS into CRUD app

---

# EXPECTED FINAL STATE

After convergence:

## Frontend

Becomes:

```txt
Cognitive Runtime Projection Layer
```

---

## Backend

Becomes:

```txt
Authoritative Execution Runtime
```

---

## Shared Contracts

Become:

```txt
Canonical Orchestration Truth
```

---

# SUCCESS CRITERIA

System succeeds when:

* FE and BE share canonical contracts
* no duplicated runtime models exist
* runtime desync disappears
* swarm state remains consistent
* lifecycle transitions are deterministic
* FE concepts become executable runtime features
* BE runtime becomes fully observable in FE
* orchestration behaves coherently across system

---

# FINAL ARCHITECTURAL DIRECTION

CrowdOS should evolve into:

```txt
Distributed Autonomous Orchestration Runtime
```

NOT:

```txt
chat app with agents
```

Because the real product is:

* coordination
* orchestration
* runtime intelligence
* emergent multi-agent systems

NOT merely frontend screens or backend APIs.

---
