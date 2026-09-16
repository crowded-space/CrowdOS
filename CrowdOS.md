# CrowdOS

> **Intelligence emerges through coordination.**

CrowdOS is a provider-agnostic sandbox orchestration layer designed for
multi-agent systems. Rather than functioning as a single AI assistant,
CrowdOS acts as an operational runtime capable of coordinating,
delegating, and managing collective intelligence across multiple models,
providers, and execution layers.

CrowdOS is fundamentally:

-   agent-native
-   orchestration-first
-   emergent by design
-   sandbox-first
-   provider-agnostic
-   modular
-   workspace-oriented

The system treats agents not as isolated entities, but as a structured
ecosystem of specialized intelligence units capable of reasoning,
delegation, execution, and collaboration.

------------------------------------------------------------------------

# 1. Core Mental Model

CrowdOS is organized around an isolated **Workspace**.

The Workspace is conceptually similar to a Discord Server: it is the
general operational boundary in which categories, channels, agents,
configuration, and history exist.

``` text
CrowdOS
└── Workspace
    ├── Categories
    │   └── Channels / Sessions
    │       ├── History
    │       ├── Runtime Selector
    │       ├── Active Agent
    │       └── Filesystem Mount
    │
    ├── Agent Roster
    │   └── Agent Instances
    │       └── Private Agent Memory
    │
    └── Workspace Configuration
```

Each Workspace is isolated. Its agents, channels, configuration, and
history belong to that Workspace.

An identically configured agent in another Workspace is a separate
instance.

------------------------------------------------------------------------

# 2. Workspace Flow

The primary user flow is Workspace-first rather than chat-first.

``` text
Launch
  ↓
Workspace Portal
  ↓
Create / Enter / Switch Workspace
  ↓
Enter Workspace
  ↓
Workspace Operational
```

## Workspace Portal

The Portal is the initialization screen and Workspace Hub.

Its responsibilities include:

-   creating a Workspace
-   entering an existing Workspace
-   switching between Workspaces

Once a Workspace is entered, the user operates inside its categories and
channels.

------------------------------------------------------------------------

# 3. Category

A **Category** is a classifier and grouping mechanism.

It is intentionally similar to a Discord Category.

A Category is **not**:

-   a filesystem directory
-   a strict folder boundary
-   a repository boundary

Instead, Categories provide grouping and can provide inherited
rules/configuration to their Channels.

``` text
Workspace
├── Category: Development
│   ├── #general
│   ├── #backend
│   └── #unity
│
└── Category: Research
    ├── #papers
    └── #analysis
```

------------------------------------------------------------------------

# 4. Channel / Session

A Channel represents a conversational **session boundary**.

A Channel contains:

-   Channel History
-   Runtime Selector
-   Active Agent / Pinned Mention
-   Filesystem Mount
-   inherited configuration

Variables and artifact-specific systems are currently pending and are
not part of the current operational model.

Media functionality is also pending.

## Channel History

Channel History is shared session history.

It can contain:

-   user messages
-   outputs from agents participating in the Channel
-   other persisted conversation events

History is associated with the Channel, not with an Agent.

> **History belongs to the Session. Memory belongs to the Agent.**

This distinction allows one Agent instance to participate in multiple
Channels without automatically carrying the entire history of another
session.

------------------------------------------------------------------------

# 5. User Message Flow

The normal interaction flow is:

``` text
On Channel
  ↓
Select Runtime
  ↓
Mention Agent
  ↓
Send Message
  ↓
Corresponding Agent Response
```

Example:

``` text
@Example Raven Please check your memory
```

Expected routing behavior:

> Only the mentioned Agent receives the message for response.

If no Agent is explicitly mentioned, the Channel's Active Agent or
resolved Default Agent is used according to the routing hierarchy.

------------------------------------------------------------------------

# 6. Runtime Selection

Runtime selection can be controlled manually by the user or
automatically by the Router.

The UI currently exposes runtime choices such as:

-   Auto
-   Chat
-   Agentic
-   Coding
-   Research

## Auto

When `Auto` is selected, the **Router** determines the appropriate
runtime.

Auto routing is already implemented.

The Router is the orchestration switchboard responsible for runtime
routing rather than a heavy reasoning layer.

## Manual Runtime

The user may explicitly select a runtime.

## Runtime Pin / Sticky Selection

Runtime selection can be temporary or pinned.

### Unpinned

An unpinned runtime selection is temporary.

When the user switches away from the Channel, the Channel returns to
`Auto`.

``` text
Channel A
  → Coding
  → switch to Channel B
  → return to Channel A
  → Auto
```

### Pinned

A pinned runtime remains selected for the Channel.

``` text
Channel A
  → 📌 Coding
  → switch away
  → return
  → 📌 Coding
```

------------------------------------------------------------------------

# 7. Active Agent / Pinned Mention

Agent mentions can also be temporary or pinned.

## Temporary Mention

``` text
@Owl
Check this.
```

The mention applies to that message.

After sending, the temporary mention disappears.

## Pinned Mention

A pinned Agent remains attached to the composer as a quick-access
target.

``` text
📌 Owl
```

Subsequent messages can be sent to that Agent without typing another
mention.

This follows the same general interaction pattern as pinned runtime
selection.

------------------------------------------------------------------------

# 8. Default Agent Resolution

CrowdOS supports a configurable default conversational Agent.

Resolution follows the Workspace hierarchy:

``` text
Channel
  ↓
Category
  ↓
Workspace
```

If a Channel has no configured default Agent, it inherits from its
Category.

If the Category has no configured default Agent, it inherits from the
Workspace.

The Workspace fallback is:

``` text
L0 + Default
```

where `Default` represents the default conversational Agent.

### Important

The **Librarian / Owl** is not the default conversational Agent.

Librarian is a specialized workspace indexing Agent/service and does not
normally respond to user messages.

------------------------------------------------------------------------

# 9. Agent Routing

Explicit Agent mention takes the message to the mentioned Agent.

Example:

``` text
@Raven Analyze this architecture.
```

The intended routing result is:

``` text
User Message
    ↓
Mention Resolution
    ↓
Raven
```

Agent identity is Workspace-scoped.

Two Workspaces can contain Agents with the same name or configuration,
but they represent different Agent instances with isolated state and
memory.

------------------------------------------------------------------------

# 10. Multiple Mention

Multiple Agent mentions route the **same message** to each mentioned
Agent.

Example:

``` text
@Owl @Raven @Crow
Review this architecture.
```

Conceptually:

``` text
                 ┌──→ Owl
Same Message ────┼──→ Raven
                 └──→ Crow
```

The Agents respond independently.

The primary purpose is comparison between different Agent perspectives,
models, configurations, or private memories.

Multiple Mention is **not inherently a Swarm**.

## Sequential Execution

Multiple Mention execution is currently serial.

Therefore, when Agents operate using shared Channel context:

``` text
User
 ↓
Agent A
 ↓
Agent A Output
 ↓
Agent B
 ↓
Agent B sees A Output
 ↓
Agent C
 ↓
Agent C sees A + B Output
```

This creates an important distinction:

> Multiple Mention provides independent Agent routing, but execution
> occurs sequentially within the shared Channel context.

Failure handling for multiple-agent execution is already implemented.

------------------------------------------------------------------------

# 11. Shared Context and Private Context

By default, an Agent can operate using the shared Channel context.

Shared context may contain the entire Channel History, including outputs
produced by other Agents.

This enables Agents to be aware of previous Agent activity and prevents
agents from operating as if they were the only participant in the
Channel.

However, shared context can create context noise.

CrowdOS therefore provides `lock_in` and `lock_out`.

------------------------------------------------------------------------

# 12. `lock_in` / `lock_out`

`lock_in` and `lock_out` are tools provided to Agents for controlling
their context focus.

They can also be invoked through an explicit user request to the Agent.

## Shared Context

The normal state exposes shared Channel context:

``` text
User
Agent A
Agent B
Agent C
User
Agent A
...
```

## `lock_in`

When an Agent invokes `lock_in`, shared context from other Agents is
stripped from the context presented to that Agent.

The Agent enters a focused/private conversational context containing its
own relevant interaction history.

Conceptually:

``` text
User
Agent A
User
Agent A
User
Agent A
```

The Channel itself remains shared. `lock_in` changes the Agent's
contextual view rather than creating a new Channel.

## `lock_out`

`lock_out` disables the private context filter and returns the Agent to
the shared Channel context.

``` text
lock_in
  ↓
Private Agent Context
  ↓
lock_out
  ↓
Shared Channel Context
```

This system allows Agents to switch between:

-   collaborative/shared awareness
-   focused/private context

without splitting the Channel.

------------------------------------------------------------------------

# 13. Agent Memory

Agent Memory is independent from Channel History.

Each Agent has its own isolated private memory.

``` text
Agent A
└── Private Memory A

Agent B
└── Private Memory B

Agent C
└── Private Memory C
```

Agents can perform memory operations through provided tools.

The current memory behavior supports Agents being able to:

-   remember
-   discard
-   delete their own memories

Memory writes are provided as Agent tools and are already implemented.

Agent memory does not automatically become shared Workspace memory.

------------------------------------------------------------------------

# 14. Librarian / Owl

**Librarian**, currently represented by Owl, is a specialized
workspace-level indexing Agent/service.

It is **not a conversational Agent**.

Its operation is heartbeat-oriented rather than message-oriented.

Primary responsibilities include indexing information across the
Workspace, including:

-   memory
-   topics
-   history
-   other indexable Workspace information

Conceptually:

``` text
Workspace
    ↓
Librarian / Owl
    ↓
Workspace Index
    ↓
L0
```

The resulting index can be accessed by L0.

Librarian therefore acts as an indexing layer rather than a normal
participant in Channel conversations.

------------------------------------------------------------------------

# 15. L0

L0 is the **highest-authority entity inside a Workspace**.

It has a distinct tool and capability set compared with normal Agents.

L0 is responsible for privileged Workspace-level coordination and
operations.

The L0 system is not yet fully completed and is currently a non-priority
area.

The important architectural distinction is:

``` text
Normal Agent
    ↓
Agent-level capabilities

L0
    ↓
Highest Workspace authority
    ↓
Privileged tools / capabilities
```

------------------------------------------------------------------------

# 16. Filesystem / Local Repository Mount

CrowdOS has explicitly pivoted away from a Virtual Filesystem.

> **NO VFS.**

The system uses local filesystem/repository mounts directly.

Filesystem mounts have three configuration levels:

``` text
Workspace
    ↓
Category
    ↓
Channel Override
```

## Workspace Mount

Provides the Workspace-level repository/mount configuration.

## Category Mount

A Category may define a default active repository.

All Channels inside that Category inherit the Category mount unless they
override it.

Example:

``` text
Category:
C:\Users\User\Documents\GitHub
```

Channels under that Category use that repository by default.

## Channel Override

A Channel may specify its own mount.

A Channel override **replaces** the active inherited repository.

Example:

``` text
Category Mount:
C:\Users\User\Documents\GitHub

Channel Override:
C:\Users\User\Downloads\dl
```

The Channel uses:

``` text
C:\Users\User\Downloads\dl
```

and does not use the Category mount.

Other Channels remain unaffected.

Thus, mount inheritance is:

``` text
Workspace Mount
      ↓
Category Mount
      ↓
Channel Override
```

where an override means **replace**, not merge.

------------------------------------------------------------------------

# 17. Local-First Persistence

CrowdOS follows a **Local-First Persistence** architecture.

The local filesystem is the source of truth.

``` text
LOCAL FILESYSTEM
       ↓
SOURCE OF TRUTH
```

Persisted local information includes:

-   Workspace configuration
-   Model configuration / Model Modules
-   Agent and Roster IDs
-   Tool configuration
-   Skills
-   Instructions
-   Workspace state
-   Channel History
-   other local Workspace state

Local persisted data primarily uses:

-   JSON for structured configuration/state
-   Markdown for Skills and Instructions

------------------------------------------------------------------------

# 18. PostgreSQL / pgvector

PostgreSQL and pgvector are **supporting infrastructure**, not the
primary source of truth.

They are primarily intended for:

-   embedded Agent Memory
-   semantic retrieval
-   RAG

Conceptually:

``` text
LOCAL
  ↓
SOURCE OF TRUTH
```

while:

``` text
PostgreSQL
pgvector
  ↓
OPTIONAL MEMORY / RAG INFRASTRUCTURE
```

If the database is unavailable, CrowdOS should remain operational using
local persistence.

Expected behavior:

``` text
CrowdOS
   │
   ├── Local Configuration     ✓
   ├── Local History           ✓
   ├── Local Skills            ✓
   ├── Local Instructions      ✓
   ├── Workspace State         ✓
   │
   └── Semantic Memory / RAG
                              degraded / unavailable
```

Therefore:

> **The database is not the source of truth.**

------------------------------------------------------------------------

# 19. Configuration Model

Current Workspace configuration includes the following areas:

  Configuration            Scope / Model                                   Status
  ------------------------ ----------------------------------------------- -------------------
  Default Runtime          Workspace default: Auto                         Core
  Default Model            Workspace → Category → Channel                  Core
  Enabled Tools            Agent-based configuration                       Core
  Skills                   Global                                          Planned expansion
  Instructions             Agent-based configuration                       Core
  Memory Policy            Channel isolation + Agent-based configuration   Core
  Safety Policy            Global                                          Core
  Agent Roster             Workspace-global                                Core
  Environment Variables    Not currently part of the model                 ---
  Secrets                  Not currently part of the model                 ---
  MCP / Connector Mounts   Workspace-global                                Pending

Configuration inheritance is **not a universal inheritance system**.

Each configuration domain has its own defined scope/behavior.

In particular, Agent configuration and global Skills should not be
treated as the same inheritance mechanism.

------------------------------------------------------------------------

# 20. Skills

Skills represent:

> reusable cognitive / workflow specialization

Skills are not Tools.

Skills are not Runtimes.

They represent:

-   knowledge packages
-   workflow patterns
-   orchestration presets
-   reasoning behaviors

Skill categories include:

### Cognitive Skills

Reasoning specializations such as:

-   architecture review
-   debugging
-   strategic planning
-   root cause analysis
-   threat modeling

### Operational Skills

Execution-oriented workflow specializations such as:

-   frontend
-   backend
-   refactoring
-   data pipelines
-   research

### Swarm Skills

Multi-agent coordination patterns such as:

-   data swarm
-   research swarm
-   review swarm
-   coding swarm

Skills are composable.

``` text
frontend_skill
+
debugging_skill
+
review_swarm
```

can form a dynamically assembled workflow.

Skills are intended to be discoverable and expanded on demand rather
than fully injected into every context.

The global Skills system is intended to make Skills available to Agents
through explicit triggers. This part remains a future implementation
area.

------------------------------------------------------------------------

# 21. Capabilities

Capabilities represent what the system can operationally do.

Capabilities are organized by **operational domain**, not simply by
individual tools.

Core domains include:

1.  Workspace
2.  Memory
3.  Tooling
4.  Planning
5.  Execution
6.  Swarm
7.  Observation
8.  Knowledge

Examples:

``` text
Workspace:
filesystem.read
filesystem.write
workspace.snapshot
artifact.create

Memory:
memory.find
memory.expand
memory.commit
memory.link

Tooling:
tool.search
tool.invoke
open_detail

Planning:
task.plan
task.breakdown
objective.track

Execution:
sandbox.exec
runtime.spawn
job.await

Swarm:
agent.spawn
swarm.create
task.delegate
result.aggregate

Observation:
workspace.scan
dependency.inspect
anomaly.detect

Knowledge:
web.search
repo.map
docs.index
```

Capabilities are intended to be:

-   externalized
-   discoverable
-   lazily expanded

This reduces token usage, context pollution, and tool confusion.

------------------------------------------------------------------------

# 22. Runtime Architecture

CrowdOS is runtime-centric rather than agent-centric.

Core runtimes:

1.  Conversational Runtime
2.  Planning Runtime
3.  Agentic Runtime
4.  Swarm Runtime
5.  Observer Runtime
6.  Orchestrator Runtime

## Conversational Runtime

Purpose:

-   chat
-   brainstorming
-   lightweight interaction

Characteristics:

-   low cost
-   short memory
-   fast response
-   minimal tools

## Planning Runtime

Purpose:

-   architecture
-   strategy
-   decomposition
-   reasoning-heavy tasks

Characteristics:

-   long reasoning loops
-   structured scratchpad
-   semantic memory assistance
-   low execution

## Agentic Runtime

Purpose:

-   active execution
-   coding
-   tool usage
-   iterative workflows

Characteristics:

-   ReAct-style execution
-   sandbox-heavy operation
-   dynamic capability discovery
-   artifact generation

## Swarm Runtime

Purpose:

-   distributed tasks
-   parallel workloads
-   multi-agent execution

Characteristics:

-   task sharding
-   concurrency
-   aggregation
-   lightweight agents

## Observer Runtime

Nitehunter-style passive analysis.

Purpose:

-   monitoring
-   anomaly detection
-   passive analysis
-   selective escalation

Characteristics:

-   deterministic-first
-   low token usage
-   reasoning invoked only when necessary

## Orchestrator Runtime

Highest-level runtime infrastructure.

Purpose:

-   Workspace management
-   runtime routing
-   context assembly
-   policy enforcement

Characteristics:

-   state-aware
-   registry-aware
-   governance-oriented
-   not itself a heavy execution layer

------------------------------------------------------------------------

# 23. Runtime Composition

CrowdOS favors a small number of fundamentally distinct runtimes and a
large amount of runtime composition.

Specialized modes should generally be compositions rather than entirely
new runtimes.

Examples:

``` text
Coding Runtime
= Agentic + Sandbox

Research Runtime
= Planning + Swarm

Security Runtime
= Observer + Parliament
```

Core principle:

> **Few runtimes, many compositions.**

------------------------------------------------------------------------

# 24. Interpreter

The Interpreter acts as a **semantic stabilization layer**.

It is not:

-   a planner
-   a thinker
-   an executor
-   a router

Its responsibilities are to:

-   reduce ambiguity
-   reduce unsafe assumptions
-   identify interaction targets
-   identify communication mode
-   extract execution hints

The Interpreter should not:

-   decompose tasks
-   plan workflows
-   decide tools
-   retrieve memory
-   perform heavy reasoning

This keeps semantic interpretation separate from cognition and
orchestration.

------------------------------------------------------------------------

# 25. Router

The Router is the orchestration switchboard.

Its responsibilities include:

-   runtime routing
-   execution strategy selection
-   runtime selection for Auto mode
-   policy-aware orchestration

The Router is not intended to perform heavy reasoning.

The high-level model is:

``` text
User Input
    ↓
Interpreter
    ↓
Execution Intent
    ↓
Router
    ↓
Runtime
```

Runtime selection through Auto routing is already implemented.

------------------------------------------------------------------------

# 26. Runtime Contract

All runtimes should communicate through a standardized runtime contract.

Conceptually:

``` ts
RuntimePacket {
  runtime_id
  session_id
  workspace_state
  interpreter_output
  visible_capabilities
  runtime_policies
  memory_hooks
  execution_metadata
  user_input
}
```

And:

``` ts
RuntimeResult {
  events[]
  artifacts[]
  state_updates[]
  memory_candidates[]
  tool_calls[]
  final_output
}
```

The standardized contract enables:

-   runtime composition
-   swarm aggregation
-   replayability
-   provider abstraction
-   runtime substitution

------------------------------------------------------------------------

# 27. Context Assembly

Context construction is a runtime concern.

It may involve:

-   Channel History
-   context filtering
-   Agent identity
-   memory retrieval
-   capability expansion
-   tool results
-   runtime policy
-   token budgeting

The important separation is:

``` text
Channel History
       ↓
Context Filtering
       ↓
Agent-specific Context
       ↓
Runtime
```

`lock_in` / `lock_out` operate within this contextualization layer.

------------------------------------------------------------------------

# 28. Event-Driven State Architecture

CrowdOS favors state-driven, event-oriented execution.

Preferred model:

``` text
event
  ↓
system / reducer
  ↓
state update
```

rather than hidden direct mutation.

State is intended to be authoritative rather than prompts, runtime
internals, or hardcoded workflows.

Benefits include:

-   replayability
-   observability
-   debuggability
-   recoverability

------------------------------------------------------------------------

# 29. Channel History Persistence

Channel History is intended to be persisted locally as events occur.

Target model:

``` text
User Message
    ↓
History Commit
    ↓
Agent Execution
    ↓
Agent Output
    ↓
History Commit
```

This event-by-event local persistence is a planned implementation
priority.

The current architecture treats local history as the canonical
conversational record.

------------------------------------------------------------------------

# 30. Agent and Workspace Isolation

Workspace isolation applies to the full operational configuration.

For example:

``` text
Workspace A
└── Raven
    └── Private Memory A

Workspace B
└── Raven
    └── Private Memory B
```

Even when two Agents share the same name or configuration, they are
separate instances when they belong to different Workspaces.

A Workspace therefore acts as the primary isolation boundary for:

-   Agents
-   Agent configuration
-   Channels
-   Channel History
-   Skills/configuration references
-   filesystem configuration
-   Workspace state

------------------------------------------------------------------------

# 31. CrowdOS Agent Hierarchy

CrowdOS currently defines distinct classes of intelligence.

## Raven --- Lv0--1

High-level reasoning Agents designed for:

-   strategic thinking
-   planning
-   complex cognitive tasks

Ravens may operate in coordinated reasoning groups known as a
**Conspiracy**.

### Conspiracy

A Conspiracy is a focused reasoning council for:

-   deep analysis
-   strategic planning
-   brainstorming
-   architecture decisions
-   high-context deliberation

Conspiracies are intentionally intelligence-dense and deliberate.

## Crow --- Lv2--3

Lightweight execution-oriented Agents optimized for:

-   scraping
-   summarization
-   processing
-   classification
-   distributed workloads
-   parallel execution

Crow orchestration groups are called a **Murder**.

### Murder

A Murder is a distributed operational swarm for large execution
workloads through coordinated lightweight Agents.

------------------------------------------------------------------------

# 32. Nitehunter

Nitehunter is CrowdOS's precision review subsystem.

Its philosophy is:

> **Observe first. Invoke intelligence only when necessary.**

Nitehunter focuses on:

-   architecture-aware analysis
-   selective escalation
-   security review
-   code quality inspection
-   anomaly detection
-   low-overhead system scanning

It combines deterministic analysis with targeted reasoning escalation.

## Nitehunter Terminology

### Hunt

Primary scanning and analysis phase.

### Perch

Passive monitoring or idle observation state.

### Strike

Targeted escalation into Agent-assisted review.

### Pellet

Noise-filtered findings and cleaned reports.

### Roost

Scheduled or recurring scan cycles.

### Silent Flight

Low-resource background analysis mode.

### Parliament

A high-intelligence reasoning council used for:

-   deep review
-   architectural judgment
-   vulnerability analysis
-   consensus validation
-   strategic findings assessment

Nitehunter is system-first, lightweight, observant, selective, and
precision-oriented.

------------------------------------------------------------------------

# 33. CrowdOS and Nitehunter

The two systems are complementary.

  CrowdOS                   Nitehunter
  ------------------------- ----------------------------
  Agent-first               System-first
  Swarm orchestration       Precision analysis
  Emergent coordination     Selective escalation
  Distributed execution     Surgical inspection
  Heavy orchestration       Efficient reasoning
  Collective intelligence   Observational intelligence

Together they balance:

-   large-scale orchestration
-   strategic reasoning
-   efficient execution
-   precision review
-   adaptive intelligence systems

------------------------------------------------------------------------

# 34. Current Development Status

The following reflects the current calibration state.

## Implemented / Existing

-   Workspace-oriented application model
-   Workspace Portal concept
-   Runtime Selector
-   Auto Runtime Routing
-   Manual Runtime Selection
-   Runtime pin/sticky behavior
-   Agent mention routing
-   Active Agent / pinned mention behavior
-   Multiple Mention routing
-   Sequential multiple-agent execution
-   Multiple Mention failure handling
-   `lock_in` / `lock_out` context tools
-   Agent self-managed memory tools
-   Workspace-level Librarian/Owl concept
-   Local-first persistence direction
-   Workspace / Category / Channel filesystem mount model

## Implemented but still evolving

-   L0 privileged authority model
-   Global Skills triggering/access model
-   Agent configuration details
-   Memory/RAG infrastructure

## Planned / Pending

-   Event-by-event Channel History persistence (**priority**)
-   MCP / Connector Mounts (**pending**)
-   Variables
-   Artifact system
-   Media support
-   Full L0 implementation (**non-priority**)
-   Global Skills trigger implementation (**future / non-priority**)
-   Workspace import/export portability (**later**)

------------------------------------------------------------------------

# 35. Current Architectural Principles

The current CrowdOS architecture can be summarized by these principles:

### 1. Workspace-first

The Workspace is the primary operational boundary.

### 2. Channel-scoped history

Conversation history belongs to the Channel / Session.

### 3. Agent-scoped memory

Private memory belongs to the Agent instance.

### 4. Local-first persistence

The local filesystem is the source of truth.

### 5. No VFS

CrowdOS mounts actual local repositories/filesystems rather than
introducing a virtual filesystem abstraction.

### 6. Runtime-centric

Runtimes represent fundamentally different execution behaviors.

### 7. Router-driven Auto execution

The Router determines the runtime when the user selects Auto.

### 8. Explicit Agent routing

Mentioning an Agent explicitly routes the message to that Agent.

### 9. Context is controllable

Agents can switch between shared and focused context using `lock_in` /
`lock_out`.

### 10. Independent Agent memory

Agent instances maintain isolated memory.

### 11. Few runtimes, many compositions

Specialized behavior should generally emerge from runtime composition.

### 12. State-driven architecture

Events drive state transitions, and state remains authoritative.

------------------------------------------------------------------------

# 36. Long-Term Vision

CrowdOS aims to become:

-   a cognitive workspace operating layer
-   a distributed orchestration kernel
-   an adaptive runtime platform
-   a multi-agent execution environment
-   a provider-agnostic cognitive infrastructure

CrowdOS is not intended to become merely:

-   a chatbot framework
-   an assistant wrapper
-   a static agent workflow system

The core idea remains:

> **Intelligence is not centralized. Intelligence is coordinated.**
