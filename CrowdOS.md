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

## Design Lineage

CrowdOS borrows its organizational model from two established ideas:

1.  **Hierarchical authority** — the multi-role authority model of a
    community platform such as Discord. A role is a capability tier, not
    merely a label: it determines what an entity may do and which other
    entities it may direct.
2.  **Intuitive, visual-first workspace** — the spatial model of a
    community platform (Discord, Slack, and similar). Structure is meant
    to be seen and navigated, not configured through abstraction.

The first idea produces the **authority hierarchy** (§31). The second
produces the **Workspace → Category → Channel** structure and the
Workspace-first flow (§2).

Together they define the product's posture: CrowdOS should feel like
organizing a community of specialists, not like wiring up a pipeline.

## Naming and Thematic Design

The name **CrowdOS** is a deliberate semantic play on **Crow** and
**Crowd**:

``` text
Crow  +  d  +  OS
  │       │
  │       └── the collective: many agents acting as one intelligence
  └────────── the individual: the Corvid agent that does the work
```

This is not decoration applied after the fact. The theme is the
organizing metaphor for the whole system, and it is expressed in the two
**core labels** (§31):

### Raven — The Flagship Intelligence

-   **Expensive and deliberate.** Ravens are the heavy-reasoning model
    tier: fewer calls, longer thought, higher cost per call.
-   **Solitary.** Ravens live in small, uncrowded colonies. A Raven is a
    flagship individual, not a unit of volume.
-   **Used for what deserves the cost:** strategy, architecture,
    judgment, deep analysis.

### Crow — The Generalist Intelligence Army

-   **Cheaper and plentiful.** Crows are the general-task tier: lower
    cost per call, chosen for volume rather than depth.
-   **Overwhelming quantity.** Crows live in huge, crowded colonies. The
    Crow is the unit; the Crowd is what the unit becomes at scale.
-   **Used for what needs breadth:** scraping, summarization,
    classification, distribution, parallel processing.

### The Thematic Features

Each label has a collective noun, and each collective noun names a
thematic feature:

-   **Conspiracy** — a council of Ravens. Heavy-reasoning debate.
-   **Murder** — a swarm of Crows. Distributed execution at volume.

Both are **prestige features**: part of the intended identity, but
**non-priority** — implemented only after a bare minimum of working
CrowdOS exists (§34).

Both are **L0-activated**. They cannot be triggered by an ordinary agent
or by routing alone — only by the highest Workspace authority, through an
explicit thematic activation (§31).

``` text
Start a Murder

Start a Conspiracy
```

The theme should be reflected consistently in naming, grouping, and
presentation — while never being allowed to obscure what a component
actually does.

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
@Raven Please check your memory
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
-   Swarm

## Auto

`Auto` is the default selection, and it is **not** a runtime of its own.

It is the **Router / Interpreter selection path** (§24, §25): the
Interpreter stabilizes the input, and the **Router** determines which of
the five runtimes handles the message.

Auto routing is already implemented.

The Router is the orchestration switchboard responsible for runtime
routing rather than a heavy reasoning layer.

The five runtimes `Auto` may select between are defined in §22.

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
@Raven @Crow @Owl
Review this architecture.
```

Conceptually:

``` text
                 ┌──→ Raven
Same Message ────┼──→ Crow
                 └──→ Owl
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

L0 is the **highest-authority entity inside a Workspace**, and it is the
user's **personal assistant**.

It can operate across the whole Workspace rather than being confined to
a single channel or task domain.

It has a distinct tool and capability set compared with normal Agents,
and it is responsible for privileged Workspace-level coordination and
operations.

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

L0 also serves as the final fallback in default agent resolution (§8).

L0 is the **only** tier that can activate the thematic prestige features
(§31):

``` text
Start a Murder

Start a Conspiracy
```

Because L0 is the user's personal assistant, it is also the agent
expected to carry a light personality — including in how it announces
these activations.

The complete authority model — L0 personal assistant, L1 specialist, L2
sub-specialist/orchestrator, L3 stateless worker — is defined in §31.

The L0 system is not yet fully completed and is currently a non-priority
area.

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

CrowdOS defines **five runtimes**. Together with `Auto` (§6), they form
the complete runtime surface:

1.  Conversational Runtime
2.  Agentic Runtime
3.  Coding Runtime
4.  Research Runtime
5.  Swarm Runtime

`Auto` is not a sixth runtime. It is the Router / Interpreter selection
path (§6, §24, §25) that chooses among these five.

These five are the **decided** runtime set. The names map to the user's
runtime selector one-to-one: Chat → Conversational, Agentic → Agentic,
Coding → Coding, Research → Research, Swarm → Swarm.

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

## Agentic Runtime

Purpose:

-   active execution
-   tool usage
-   iterative workflows
-   general task completion

Characteristics:

-   ReAct-style execution
-   sandbox-aware operation
-   dynamic capability discovery
-   artifact generation
-   structured planning happens inside the loop rather than as a
    separate runtime

## Coding Runtime

Purpose:

-   coding
-   repository work
-   refactoring
-   file-level editing and diffs

Characteristics:

-   **deliberately forks a mature, battle-tested coding engine rather
    than building one from scratch**
-   full filesystem read/write/edit tool surface
-   diff-oriented output
-   sandbox-heavy operation

The Coding Runtime is an intentional exception to "build it as a
composition" (§23): maturity and reliability of the coding loop are
worth more than implementation uniformity.

## Research Runtime

Purpose:

-   investigation
-   evidence gathering
-   source comparison
-   synthesis

## Swarm Runtime

Purpose:

-   **large / big data workloads**
-   distributed task processing
-   multi-agent execution

Characteristics:

-   **decomposition of a large workload into narrow, surgical subtasks**
-   **delegation to multiple L3 Worker Agents** (§31)
-   task sharding
-   bounded concurrency
-   aggregation of partial results
-   lightweight, stateless workers

The Swarm Runtime is the dedicated engine for workloads that are too
large for a single agent pass. Its purpose is not merely to run several
agents, but to **shard the work so each worker holds a smaller and more
precise scope than the requesting agent would have.**

The orchestrating agent for a swarm is an **L2 sub-specialist** (§31),
which delegates to L3 workers and returns a consolidated report upward.

The Swarm Runtime is also the engine behind the **Murder** prestige
feature (§31). A Murder is not a different engine — it is this runtime
entered through its own L0-activated gateway rather than through ordinary
routing.

> **Multiple Mention is not a Swarm.** See §10.

------------------------------------------------------------------------

# 23. Runtime Composition

CrowdOS favors a **small number of fundamentally distinct runtimes**
(§22) and, where practical, runtime composition over new runtimes.

Specialized behavior should **prefer** composition. It is a preference,
not an absolute rule.

Where composition is a poor fit, a dedicated runtime is acceptable — but
the reason must be explicit. The Coding Runtime is the standing example:
it deliberately forks a mature, battle-tested coding engine because
reliability of the coding loop outweighs implementation uniformity.

``` text
Coding Runtime   = dedicated engine (deliberate fork, mature engine)
Swarm Runtime    = decomposition + sharding + L3 worker delegation
```

Core principle:

> **Few runtimes. Compose when it is honest to do so.**

### Conformance Requirement

Composition and forking are both allowed. **Contract drift is not.**

Every runtime — composed, forked, or dedicated — must honor the same
runtime contract (§26) and the same cross-cutting behaviors:

-   the same `RuntimeResult` shape
-   the same tool authorization and capability-deferral rules (§21)
-   the same cancellation/abort semantics
-   the same usage accounting, so budget enforcement (§27) sees real
    numbers

A runtime that behaves differently is a defect, not a design choice.

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

The Interpreter's output is **not decorative**: it is the input the
Router uses to choose a runtime in `Auto` mode (§6, §25). An
interpretation that no decision consumes is a defect.

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

## Auto Selection

`Auto` is the default mode and the Router's primary job (§6).

When the user selects `Auto`, the Router must be able to select **any
of the five runtimes** (§22). An `Auto` that can only ever reach a
subset is not a working selection path.

The Router may use, among others:

-   the Interpreter's stabilized mode and execution hints
-   explicit channel or category signals
-   the authority level of the target agent (§31)
-   runtime policies and availability

The Router decides; the Interpreter only stabilizes (§24).

## Authority-Aware Routing

Authority level is a routing input, and its mapping should reflect the
tier model (§31):

``` text
L0–L1   reasoning / specialist work   → Research, Agentic, or Conversational
L2      orchestration                  → Swarm
L3      narrow execution               → Agentic (or Conversational)
```

The Router must not invert this relationship: the highest-authority
agents should not receive the most limited runtime while workers receive
execution-heavy ones.

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

### Contract Status

The contract is enforced, not aspirational. Every runtime is required to
return the same shape, and the requirement is checked by a conformance
suite (§34) rather than left to review.

``` text
events[]            runtimeEvents[]     all five runtimes
artifacts[]         artifacts[]         reported by Coding, Research, Swarm
tool_calls[]        toolCalls[]         reported by Agentic and Coding
final_output        finalResponse       all five runtimes
```

Two entries are named honestly rather than assumed to hold:

-   **`memory_candidates[]`** is typed on the result but produced by no
    runtime. Memory writes currently happen through the memory tools and the
    reflection path, not by a runtime proposing candidates for a caller to
    accept. It is a contract slot awaiting a producer.
-   **`tool_calls[]`** is absent from Conversational, Research, and Swarm.
    That is correct for Conversational, which has no tool surface. For
    Research and Swarm the tool work happens in sub-runs — research
    sub-queries and worker agents — whose calls are not flattened into the
    parent result. That is a real gap, not a design choice.

`state_updates[]` is deliberately **not** part of the current shape. State
transitions belong to the sole mutator (§28), which runtimes reach through
`stateGate` rather than by returning mutations for the caller to apply. A
runtime that could return arbitrary state updates would be a second writer.

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

CrowdOS organizes agents along **two axes** that must not be confused:

1.  **Authority level (L0–L3)** — what an agent *may do*. This is the
    functional axis: capability, permissions, delegation rights.
2.  **Label (Raven / Crow)** — what an agent *is*, thematically. This is
    the identity axis: the Corvid class that carries the theme (§1).

Authority decides behavior. Labels carry identity. The two are
correlated by design but remain separate concepts.

## The Two Labels

``` text
Raven   The Flagship Intelligence      expensive, deliberate, solitary
Crow    The Generalist Intelligence Army  cheaper, plentiful, crowded
```

**Raven** is the flagship intelligence. Ravens carry the heavy-reasoning
models: they are expensive, deliberate, and few. A Raven is a flagship
individual, not a unit of volume. They live in small, uncrowded colonies,
which is why a group of Ravens is a **Conspiracy** — a rare, intentional
gathering rather than a standing crowd.

**Crow** is the generalist intelligence army. Crows run the cheaper,
general-purpose models: plentiful, fast, and optimized for volume. They
live in huge, crowded colonies, which is why a group of Crows is a
**Murder** — the natural state of a colony that is already dense.

The CrowdOS name plays on exactly this pair: the **Crow** (individual
worker) and the **Crowd** (the collective it forms). One label is the
unit; the other is what the unit becomes at scale.

The cost asymmetry is the point. A Workspace should spend Ravens on
problems that deserve deliberation and spend Crows on problems that need
breadth — and should not confuse the two.

## Authority Levels

Authority is a capability tier: it determines what an agent may do, which
agents it may direct, and how much responsibility it carries.

The model is intentionally hierarchical, in the same spirit as roles in a
community platform: a higher tier delegates downward and owns the
outcome, while a lower tier owns only a narrow scope.

``` text
L0  Highest authority   Personal Assistant      whole Workspace      Raven
        ↓
L1  Specialist          user-defined role       a specific domain    Raven
        ↓
L2  Sub-Specialist      helper / orchestrator   a bounded task       Crow
        ↓
L3  Worker              stateless executor      one narrow subtask   Crow
```

The label boundary falls between L1 and L2: **the top half reasons, the
bottom half executes.** This is the same boundary that separates a
Conspiracy from a Murder.

## L0 — Personal Assistant (Raven)

L0 is the highest authority in the Workspace and acts as the user's
**personal assistant**.

It is a Raven: the highest reasoning authority in the Workspace.

Responsibilities:

-   handle the whole Workspace rather than a single domain
-   privileged Workspace-level coordination and operations
-   access a distinct tool and capability set (§15)
-   serve as the final fallback in default agent resolution (§8)

There is normally **one L0 per Workspace**, representing the user's own
assistant.

## L1 — Specialist (Raven)

L1 agents are **specialists**: agents the user configures for a specific
role or domain. They are Ravens: reasoning agents with a defined
specialization.

Each L1 is a distinct combination of:

-   instructions (what the agent is and how it should behave)
-   model / provider choice (user preference per role)
-   tools and skills
-   private memory

The user may configure **as many L1 agents as needed**, each with its own
defined role. This is the primary tier where the user expresses intent
about *what kind of work* exists in their Workspace.

Examples: a frontend specialist, a security reviewer, a research lead.

## L2 — Sub-Specialist / Orchestrator (Crow)

L2 agents are **sub-specialists** that act as helpers to an L1.

They are Crows: the first tier on the execution side of the boundary, and
the tier where coordination begins.

An L2 is the tier responsible for **orchestration**:

-   receiving a bounded task from its L1
-   calling sub-agents — this is the **swarm orchestrator** role
-   delegating work to L3 workers
-   aggregating and verifying their results
-   **returning a consolidated report to the L1**

L2 does not hold the user's intent directly; it exists to turn an L1's
intent into executed work. It is the natural owner of the Swarm Runtime
(§22).

## L3 — Stateless Worker (Crow)

L3 agents are **stateless general workers**. They are Crows in the
plainest sense: the unit of work itself.

Characteristics:

-   no persistent identity beyond the task they were given
-   no private memory carried between tasks
-   narrow, surgical scope: one subtask at a time
-   optimized for volume, parallelism, and low cost

An L3 is the unit of work the Swarm Runtime fans out to (§22). A worker's
scope should always be **smaller and more precise** than the task its L2
received — that narrowing is the point of the tier.

## Tier Summary

  Tier   Label   Role                Scope              Memory      Orchestrates
  ------ ------- ------------------- ------------------ ----------- --------------
  L0     Raven   Personal Assistant  Whole Workspace    Private     Yes
  L1     Raven   Specialist          A defined domain   Private     Via L2
  L2     Crow    Sub-Specialist      A bounded task     Private     Yes (swarm)
  L3     Crow    Worker              One narrow subtask Stateless   No

## Naming Groups

Each label has its own collective noun. These are the thematic
coordination groups.

### Conspiracy — a council of Ravens

A **Conspiracy** is a focused reasoning council: a deliberate debate
between multiple Ravens, convened to attack a problem from several
independent angles.

Purpose:

-   heavy reasoning on a problem worth the cost
-   challenging each other's conclusions and finding flaws
-   deep analysis and architectural judgment
-   strategic planning and high-context deliberation

A Conspiracy convenes **2–5 Raven agents**. They are not a fan-out: they
are a debate. The value comes from disagreement, not throughput.

A Conspiracy belongs to the reasoning tiers (L0–L1) and is intentionally
intelligence-dense and slow.

Unlike a Murder, a Conspiracy has **no existing runtime equivalent**
(§22). The five runtimes cover chat, execution, coding, research, and
distributed work — none of them is a debate between flagship agents.
Conspiracy therefore needs its own orchestration pattern when it is
built, rather than being a gateway onto an existing runtime.

### Murder — a swarm of Crows

A **Murder** is a distributed operational swarm. Mechanically, it is the
**Swarm Runtime** (§22) — the same sharding, delegation, and aggregation
engine — but it is entered through its own activation gateway rather than
through ordinary routing.

Purpose:

-   large execution workloads
-   distributed processing
-   parallel task sharding
-   high-volume, low-scope work

A Murder is the coordinated execution group of the Swarm Runtime (§22)
and belongs to the execution tiers (L2–L3).

## Prestige Features

Conspiracy and Murder are **prestige features**.

They are part of the intended identity of CrowdOS, but they are
**non-priority**: they will only start to be implemented after a bare
minimum of working CrowdOS exists. They are not prerequisites for the
core product, and their absence does not indicate a defect.

### Activation

Both are triggered **only by L0** — the highest Workspace authority
(§15) — through an explicit thematic activation. They are not reachable
by ordinary agent mention, by `Auto` routing, or by any lower tier.

``` text
Start a Murder

Start a Conspiracy
```

This restriction is deliberate. A Conspiracy spends flagship intelligence
and a Murder spends an army of workers; both are expensive enough that
they should require the user's own assistant to authorize them, not an
incidental routing decision.

### Personality

Because L0 is the user's **personal assistant** (§15), the activation is
also a moment of character. L0 is expected to carry a light personality
in how it announces and frames these activations — a deliberate,
thematic flourish when convening a Conspiracy or loosing a Murder.

This is presentation, not mechanism: the personality must never change
what the feature does, and must never obscure what is actually running.

### Implementation Bar

When implemented, both must be genuine coordination structures — a
Conspiracy that actually debates and finds flaws, a Murder that actually
shards and distributes work — not decorative labels on ordinary
multi-agent execution.

## On Agent Names

**Raven** and **Crow** are the two **labels**. They are part of the
product's identity and are expected to appear in the interface.

Individual agent names — Owl, and any name a user chooses — are
**user-facing identity**, not tiers.

``` text
Label   (Raven / Crow)   fixed, thematic, tied to the reasoning/execution split
Name    (Owl, …)         free, user-chosen, carries no authority
Level   (L0–L3)          functional authority, determines capability
```

Authority always comes from the **level**, never from the name. An
identically named agent in another Workspace is a separate instance
(§30).

------------------------------------------------------------------------

# 32. Nitehunter

Nitehunter is CrowdOS's precision review subsystem.

Its philosophy is:

> **Observe first. Invoke intelligence only when necessary.**

Nitehunter is a **separate complementary system**, not one of the five
CrowdOS runtimes (§22). It is documented here because it shares the
authority hierarchy (§31) and may be invoked as a specialized service
over a Workspace.

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
-   Five-runtime set: Conversational, Agentic, Coding, Research, Swarm
-   Coding Runtime on a mature, forked coding engine

### Runtime selection and routing

-   `Auto` consumes the Interpreter's stabilized intent: the Router reads
    the interpretation rather than recomputing it, so an interpretation is
    never produced and discarded (§24, §25)
-   `Auto` can reach all five runtimes; the reachable set is asserted in
    the runtime contract conformance suite. That suite enables
    `RESEARCH_V1` and `SWARM_V1` to observe them, because **both flags
    default to `false`**: with the shipped configuration, Research and
    Swarm roll back to Agentic and the reachable set is three. The
    default is a deliberate narrower set, not a broken selection path —
    and the rollback is reported as `rolledBackFrom` rather than hidden
-   Authority-aware routing is enforced: reasoning tiers receive reasoning
    runtimes, L2 owns the swarm engine, and L3 receives narrow execution.
    The mapping cannot invert (§25, §31)
-   Routing decisions are logged as structured records carrying the chosen
    runtime, the reason, and any rollback — "why did this go to Swarm?" is
    answerable from the log alone
-   The channel runtime pin is persisted server-side in
    `channel_settings.pinned_runtime`, resolved as a **runtime** (not a
    composer mode), and treated by the Router as a preference that tier
    rules and rollback flags still apply to (§6)
-   The pin is scoped to its **own Channel** in the UI as well as the
    server row: pinning Coding in one channel leaves every other channel
    unpinned, and returning to a pinned channel restores it. The client
    translates its composer vocabulary into runtime names before writing
    (`chat` → `conversational`), so a pin can never be rejected by the
    server while the UI still shows it as set
-   A pin is **read back** from the server when a channel is entered, and
    the server row is authoritative in both directions: a pin it holds is
    applied, and a pin it does not hold clears the composer to `Auto`
    rather than leaving a stale local mirror showing a mode the server
    already dropped
-   `Swarm` is user-selectable in the Runtime Selector, matching §22's
    five-runtime set rather than being reachable only through the Router

### Swarm worker delegation

-   Plan `assigneeTemplate` is resolved to a **real agent**; the resolved
    worker is named in the report, and every substitution states its reason
-   Work is assigned to the worker tier (L3). A plan that names the
    orchestrator, or any non-worker, does not get its own work handed back
-   Workers run the full agentic loop through their **own** assembled
    context — their instructions, their model module, their capabilities —
    in quiet mode, so an N-task swarm does not flood the channel transcript
-   Workers are stateless: they write no private memory (§31). The rule is
    enforced at the tool executor, not only on the reflection path, so a
    worker cannot call `remember` and leave a durable note behind
-   Worker token usage accumulates into the run's usage instead of being
    hard-zeroed, so swarm cost is visible to budget enforcement (§27). The
    supervisor's planning call and the verifier's verdict call are counted
    too — a swarm that hides three of its four paid calls under-reports what
    it spent
-   Fan-out is bounded by `SWARM_MAX_CONCURRENCY` and each task has a
    wall-clock ceiling (`SWARM_TASK_TIMEOUT_MS`); a hung worker fails its
    own task instead of holding the run open
-   A worker that fails fails its task — failure text is never counted as
    successful output
-   A worker is never invented: with no eligible L3 the task fails with a
    stated reason rather than silently re-running the orchestrator

## Implemented but still evolving

-   L0 privileged authority model
-   Global Skills triggering/access model
-   Agent configuration details
-   Memory/RAG infrastructure
-   Authority-level tiers L1/L2/L3 as distinct, enforced roles (§31)
    — tiers are enforced by the Router today; their broader behavioural
    rights are still being filled in
-   Auto routing quality — the selection path is wired and observable, but
    the intent vocabulary is deliberately lexical and will need to grow
    (§6, §24, §25)
-   Swarm large-data sharding — decomposition and delegation are real, but
    work is not yet partitioned by data range or file batch (§22)
-   Worker context slicing — workers receive the assembled channel context;
    narrower per-subtask context would sharpen their scope further (§31)

## Planned / Pending

-   Event-by-event Channel History persistence (**priority**)
-   MCP / Connector Mounts (**pending**)
-   Variables
-   Artifact system — artifact rows, the gate, and `artifacts[]` reporting
    on `RuntimeResult` exist; retention policy, browsing UI, and the full
    producer set are still pending
-   Media support
-   Nitehunter (§32, §33) — the precision review subsystem has **no
    implementation** in the current codebase. It is documented as a
    complementary system rather than one of the five runtimes, so its
    absence is not a gap in the runtime set, but it is a gap in §34 that
    this entry closes
-   Full L0 implementation (**non-priority**)
-   Global Skills trigger implementation (**future / non-priority**)
-   Workspace import/export portability (**later**)
-   Large-data sharding for the Swarm Runtime (**priority**)
-   L2 orchestration as a first-class, enforced role (**pending**)

## Runtime Contract Conformance

§23 requires every runtime to honor the same contract. The current state:

-   All five runtimes return the same `RuntimeResult` shape, including
    the `artifacts[]` slot (§26). Coding, Research, and Swarm populate it; a
    failed artifact write is reported as `persisted: false` rather than
    omitted, so a gap is never silent
-   The full result contract is pinned by a compile-time exhaustiveness
    check, so a field cannot be dropped from the contract silently
-   Tool authorization and capability deferral apply uniformly: the Coding
    Runtime is a deliberate fork, but it receives the same deferred tool
    surface as every other runtime rather than the whole registry (§21)
-   Cancellation/abort semantics are shared across runtimes

## Operational Safety

-   Process-level guards for unhandled rejections and uncaught exceptions
    are installed by every boot path (server, worker, embedded desktop).
    They log with redaction and a monotonic counter and keep serving — a
    detached background failure must not kill a single-user local app
    mid-conversation
-   Background maintenance timers are unref'd so they never hold the
    process open

## Prestige Features

Prestige features are part of the intended identity of CrowdOS, but they
are **non-priority**: they will only start to be implemented after a bare
minimum of working CrowdOS exists. Their absence is not a defect.

-   **Conspiracy** — a council of Ravens. Heavy-reasoning debate between
    2–5 Raven agents, challenging each other to find flaws (§31)
-   **Murder** — a swarm of Crows. The Swarm Runtime, entered through its
    own activation gateway (§22, §31)

Both are **L0-activated only**, through explicit thematic activation:

``` text
Start a Murder

Start a Conspiracy
```

Neither is reachable by ordinary mention, by `Auto` routing, or by any
tier below L0. Both must eventually be genuine coordination structures,
not decorative labels on ordinary multi-agent execution.

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

The Router determines the runtime when the user selects Auto. Auto is a
selection path, not a runtime.

### 8. Explicit Agent routing

Mentioning an Agent explicitly routes the message to that Agent.

### 9. Context is controllable

Agents can switch between shared and focused context using `lock_in` /
`lock_out`.

### 10. Independent Agent memory

Agent instances maintain isolated memory.

### 11. Few runtimes; compose when honest

Five runtimes, not many. Specialized behavior should prefer runtime
composition. A dedicated runtime is acceptable when the reason is
explicit (the Coding Runtime's deliberate fork). Contract conformance is
mandatory either way.

### 12. State-driven architecture

Events drive state transitions, and state remains authoritative.

### 13. Hierarchical authority

Agents are organized by authority tier — L0 personal assistant, L1
specialist, L2 sub-specialist/orchestrator, L3 stateless worker. Higher
tiers delegate downward and own the outcome; lower tiers own a narrow
scope.

### 14. Narrow scope per unit of work

Work is decomposed until each unit is small enough to be executed
precisely. This applies to swarm workers, sub-tasks, and capability
expansion alike.

### 15. Thematic coherence

The Corvid theme — Raven (reasoning) and Crow (execution), and their
collective nouns Conspiracy and Murder — is the system's identity layer
(§1, §31). Naming and presentation should reflect it consistently, while
never being allowed to obscure what a component actually does.

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
