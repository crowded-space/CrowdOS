# AI Runtime, Agent Pipeline, Backend, Lifecycle & UX Comprehensive Audit Prompt

## Role

Act as a **principal AI systems architect, agent-runtime engineer, backend performance engineer, developer-tools product architect, and UX systems reviewer**.

You are auditing an existing AI application / agent platform and its complete execution workflow.

Your job is not merely to review code quality. You must determine whether the platform has a **coherent, reliable, observable, efficient, extensible, and developer-grade agent runtime** capable of supporting Chat, Agentic, Coding, Research, and Swarm workflows.

Treat this as a **production architecture audit plus optimization program**.

Do not assume that a capability exists because it is named in documentation, UI, configuration, or comments. Verify the implementation and runtime behavior.

Do not invent findings.

Separate every conclusion into:

* **Observed** — directly verified from code, configuration, runtime behavior, logs, tests, or UI.
* **Inferred** — strongly implied but not directly verified.
* **Missing** — expected capability has no implementation or usable path.
* **Broken** — implementation exists but is incorrect, unreliable, incomplete, or inconsistent.
* **Risk** — implementation may work but creates meaningful reliability, security, cost, performance, or UX risk.
* **Opportunity** — an optimization or architectural improvement that is not strictly required for correctness.

---

# 1. Primary Objective

Perform a complete audit of the current system and answer:

> **Can this platform provide a seamless, reliable, observable, resumable, low-latency, cost-efficient, multi-agent experience comparable in workflow quality to modern coding/agent platforms such as Codex, Claude Code, Cursor, OpenCode, Antigravity-style agent workflows, and Discord-style persistent conversational/task workflows?**

Evaluate the system end-to-end:

```text
User
  ↓
UI / Client
  ↓
Conversation / Session
  ↓
Intent / Runtime Selection
  ↓
Runtime
  ↓
Agent Orchestrator
  ↓
Planner / Router / Model
  ↓
Tool Execution
  ↓
Subagents / Parallel Workers
  ↓
State / Context / Memory
  ↓
Events / Streaming / Telemetry
  ↓
Output / Artifacts / Diffs
  ↓
Persistence
  ↓
Resume / Retry / Fork / Continue
```

Audit both the **happy path** and failure/recovery paths.

---

# 2. First: Discover the Real System

Before recommending changes, inventory the current implementation.

Identify:

* application entry points
* frontend/client architecture
* backend architecture
* API layer
* websocket/SSE/streaming infrastructure
* task/job queues
* workers
* model providers
* model routing
* runtime implementations
* agent implementations
* tool registry
* MCP integrations
* browser integrations
* shell/terminal execution
* filesystem access
* code execution
* database/state stores
* cache layers
* vector/search systems
* memory systems
* conversation/session storage
* task storage
* event storage
* telemetry/logging
* authentication/authorization
* rate limiting
* quotas
* cancellation mechanisms
* retry mechanisms
* timeout mechanisms
* background processing
* scheduled jobs
* notification systems
* artifact generation
* Git/diff integration
* approval/permission mechanisms
* feature flags
* configuration layers
* environment-specific behavior
* test infrastructure
* deployment architecture

Build an explicit **system inventory table**.

For every major component report:

| Component | Location | Purpose | Owner/Boundary | Dependencies | Runtime | State | Failure Handling | Observability | Risk |
| --------- | -------- | ------- | -------------- | ------------ | ------- | ----- | ---------------- | ------------- | ---- |

Do not stop at filenames. Trace actual execution flow.

---

# 3. Runtime Audit

Explicitly audit every runtime that actually exists.

At minimum investigate these conceptual runtimes:

```text
Chat
Agentic
Coding
Research
Swarm
```

Also discover and include any additional runtimes or execution modes present in the system.

For each runtime determine:

### Initialization

* How is the runtime selected?
* Is selection explicit, automatic, or hybrid?
* What starts the runtime?
* What context is loaded?
* What configuration is inherited?
* What model is selected?
* What tools are enabled?
* What permissions are enabled?
* What memory is available?
* What state is created?

### Execution loop

Map the exact loop:

```text
input
→ classify
→ plan
→ route
→ model call
→ tool call
→ tool result
→ reasoning/decision
→ next action
→ completion
```

Identify:

* synchronous vs asynchronous execution
* streaming behavior
* model invocation boundaries
* tool invocation boundaries
* subagent invocation boundaries
* state persistence points
* cancellation points
* retry points
* checkpoint points
* approval points
* compaction points

### Runtime isolation

Determine whether runtimes share:

* context
* state
* tools
* permissions
* sessions
* memory
* model configuration
* system prompts
* telemetry
* caches

Identify accidental coupling.

### Runtime switching

Audit whether users can safely move between:

```text
Chat → Agentic
Chat → Coding
Chat → Research
Agentic → Coding
Agentic → Research
Agentic → Swarm
Coding → Agentic
Research → Agentic
```

without losing important context or creating inconsistent state.

Evaluate whether runtime changes are:

* explicit
* predictable
* reversible
* observable
* resumable

---

# 4. Chat Runtime Audit

Determine whether Chat is truly optimized for conversational interaction rather than behaving like a generic agent runtime with tools disabled.

Evaluate:

* low first-token latency
* streaming
* conversation continuity
* context management
* message persistence
* edit/regenerate
* branching
* retries
* stop/cancel
* attachments
* multimodal inputs
* citations/references
* tool escalation
* transition to agentic execution
* message metadata
* thread semantics
* notification behavior

Determine whether Chat can seamlessly escalate to a deeper runtime without forcing the user to restart the task.

---

# 5. Agentic Runtime Audit

Evaluate whether the Agentic runtime behaves like a proper autonomous task execution environment.

Audit:

* planning
* task decomposition
* goal tracking
* state machine
* tool selection
* delegation
* progress tracking
* retries
* timeouts
* cancellation
* approval handling
* stuck detection
* loop detection
* context compaction
* checkpointing
* resumability
* failure recovery
* final verification

Determine whether the runtime understands the distinction between:

```text
conversation
task
run
agent
tool call
subagent
worker
artifact
result
```

If these concepts are conflated, explain the architectural consequences.

---

# 6. Coding Runtime Audit

Evaluate the coding workflow as a serious developer environment.

Audit:

* repository discovery
* project detection
* workspace boundaries
* file indexing
* code search
* symbol search
* LSP integration
* terminal execution
* test execution
* linting
* formatting
* Git integration
* diff generation
* patch application
* branch/worktree handling
* dependency installation
* environment detection
* build verification
* error diagnosis
* automatic repair
* regression testing
* final verification

Evaluate whether coding work can operate as:

```text
Understand
→ Plan
→ Modify
→ Run
→ Observe
→ Diagnose
→ Repair
→ Test
→ Review
→ Present diff
```

Do not evaluate only code generation quality.

Evaluate the **entire coding loop**.

---

# 7. Research Runtime Audit

Evaluate Research as a distinct workflow.

Audit:

* planning
* source discovery
* parallel search
* source ranking
* source verification
* retrieval
* citation tracking
* deduplication
* evidence preservation
* source freshness
* context isolation
* synthesis
* contradiction detection
* uncertainty handling
* result compression
* final report generation

Determine whether Research contaminates the main context with unnecessary raw search output.

Identify where subagents or background tasks should isolate high-volume research activity.

---

# 8. Swarm Runtime Audit

Treat Swarm as a distributed orchestration system, not simply “multiple agents.”

Audit:

* agent creation
* agent specialization
* task partitioning
* task dependency graph
* parent/child relationships
* parallelism
* concurrency limits
* resource isolation
* context isolation
* shared state
* message passing
* synchronization
* aggregation
* consensus
* conflict handling
* duplicate work
* deadlock detection
* orphan workers
* cancellation propagation
* timeout propagation
* partial completion
* worker failure
* worker restart
* final synthesis

Model the system as:

```text
Supervisor
 ├── Worker A
 ├── Worker B
 ├── Worker C
 └── Worker D
       ↓
    Aggregator
       ↓
    Verifier
       ↓
    Final Result
```

Determine whether Swarm requires stronger workflow primitives such as:

* DAG execution
* queue-based execution
* leases
* heartbeats
* durable checkpoints
* idempotency keys
* distributed locks
* worker ownership
* event sourcing
* retry policies
* compensation
* dead-letter handling

---

# 9. Agent Architecture Audit

Audit the full agent hierarchy.

Identify:

```text
User
  ↓
Primary Agent
  ↓
Planner
  ↓
Subagent
  ↓
Tool
  ↓
External System
```

Determine:

* how agents are defined
* how agents are discovered
* how agents are selected
* how delegation happens
* whether agents can recursively delegate
* whether delegation has limits
* how agent permissions are inherited
* whether each agent has isolated context
* whether agents can run concurrently
* how agent results return to the parent
* whether outputs are summarized or copied wholesale
* whether agents have independent state
* whether agents can be resumed
* whether agents can be observed independently
* whether agent failure affects siblings
* whether parent cancellation propagates

Evaluate whether context is being wasted by unnecessarily returning massive intermediate outputs to the parent.

Modern agent systems increasingly use specialized subagents, isolated context, focused tool access, and parallel execution; evaluate whether this architecture is present or should be introduced.

---

# 10. Agent Lifecycle Audit

Create an explicit lifecycle/state diagram.

At minimum investigate states such as:

```text
CREATED
QUEUED
STARTING
RUNNING
WAITING_FOR_TOOL
WAITING_FOR_APPROVAL
WAITING_FOR_DEPENDENCY
PAUSED
RETRYING
COMPACTING
CANCELLING
CANCELLED
COMPLETING
VERIFYING
COMPLETED
FAILED
TIMED_OUT
EXPIRED
ORPHANED
RESUMABLE
```

Determine which states actually exist.

For each state specify:

* entry condition
* exit condition
* stored state
* owner
* timeout
* retry behavior
* user-visible status
* emitted events
* telemetry
* recovery behavior

Look specifically for:

* zombie jobs
* abandoned sessions
* lost tasks
* duplicate execution
* double completion
* race conditions
* cancellation races
* retry storms
* orphaned subagents
* stale locks
* inconsistent persistence

---

# 11. Pipeline Audit

Trace the complete backend pipeline.

For every request measure and/or identify:

```text
request received
→ authentication
→ session lookup
→ runtime selection
→ context loading
→ prompt assembly
→ model routing
→ model request
→ tool selection
→ tool execution
→ state update
→ event emission
→ persistence
→ final response
```

Identify latency introduced at every stage.

Build a latency budget.

Example:

| Stage            | Current p50 | Current p95 | Target | Cost | Bottleneck |
| ---------------- | ----------: | ----------: | -----: | ---: | ---------- |
| Request handling |             |             |        |      |            |
| Context load     |             |             |        |      |            |
| Model TTFT       |             |             |        |      |            |
| Tool dispatch    |             |             |        |      |            |
| Tool execution   |             |             |        |      |            |
| Persistence      |             |             |        |      |            |
| Finalization     |             |             |        |      |            |

Use actual measurements whenever possible.

---

# 12. Backend Performance Optimization

Audit aggressively for unnecessary latency and cost.

Investigate:

### Model efficiency

* model routing
* model selection by task complexity
* cheap model for exploration
* expensive model only where necessary
* prompt duplication
* oversized system prompts
* unnecessary context
* repeated model calls
* redundant reasoning
* unnecessary re-planning

### Context efficiency

* token growth
* context duplication
* message duplication
* tool-output duplication
* raw logs inserted into context
* unnecessary search results
* unnecessary file contents
* compaction strategy
* summarization strategy
* context windows per subagent

### Tool efficiency

* serial vs parallel tools
* duplicate tool calls
* redundant filesystem scans
* repeated searches
* caching opportunities
* request batching
* connection reuse
* timeout policy

### Backend efficiency

* database queries
* N+1 queries
* unnecessary serialization
* excessive polling
* websocket churn
* queue overhead
* worker startup cost
* cold starts
* connection pooling
* cache hit rates
* object allocation
* event volume
* log volume

### Distributed execution

* queue partitioning
* worker utilization
* concurrency limits
* backpressure
* scheduling fairness
* priority queues
* load balancing
* retry storms
* duplicate work
* resource starvation

Recommend concrete changes with expected impact.

---

# 13. Caching Audit

Inventory every cache.

For each cache determine:

* key
* scope
* TTL
* invalidation
* owner
* consistency requirements
* memory cost
* hit rate
* failure behavior

Look for opportunities to cache:

* repository metadata
* embeddings
* search indexes
* file trees
* tool schemas
* model metadata
* prompts
* context summaries
* research sources
* external API responses
* dependency metadata
* build metadata

Also detect dangerous caching such as:

* user-specific state leaking between users
* stale permissions
* stale repository state
* stale model responses where correctness matters
* stale tool results

---

# 14. Queue and Worker Audit

If asynchronous execution exists, inspect:

* queue technology
* priority
* fairness
* visibility timeout
* retries
* dead-letter queue
* idempotency
* deduplication
* job ownership
* heartbeats
* leases
* cancellation
* scheduling
* concurrency
* backpressure
* worker health
* graceful shutdown
* crash recovery

Determine whether tasks survive:

```text
process restart
server restart
worker crash
network failure
browser disconnect
user reconnect
database failover
model timeout
tool timeout
```

A browser disconnect must not accidentally terminate durable work unless that is an explicit product rule.

---

# 15. Persistence and Resumability

Audit whether a task can be resumed after interruption.

Test the lifecycle:

```text
start task
→ disconnect client
→ reconnect
→ observe task
→ resume conversation
→ inspect progress
→ continue task
```

Also evaluate:

* session resume
* run resume
* agent resume
* subagent resume
* task fork
* branch
* retry from checkpoint
* retry from failed step
* replay
* audit reconstruction

Distinguish:

```text
conversation history
≠
execution history
≠
event log
≠
agent state
≠
tool state
≠
artifact state
```

If these are currently mixed together, identify the consequences.

---

# 16. Event Model and Streaming Audit

Determine whether the backend has a coherent event model.

Prefer explicit events such as:

```text
run.created
run.started
run.status_changed
agent.started
agent.thinking_started
agent.tool_requested
tool.started
tool.output
tool.completed
approval.requested
approval.granted
approval.denied
agent.progress
agent.completed
agent.failed
artifact.created
artifact.updated
diff.created
run.completed
run.failed
run.cancelled
```

Determine whether events are:

* ordered
* durable
* replayable
* idempotent
* correlated
* traceable
* user-visible when appropriate

Audit whether the frontend receives sufficient events to render live execution without polling.

---

# 17. Observability and Telemetry

Audit:

* structured logs
* metrics
* traces
* correlation IDs
* run IDs
* agent IDs
* tool IDs
* request IDs
* model call IDs
* task IDs

Each execution should be reconstructable.

At minimum capture:

```text
user intent
runtime selected
model selected
agent selected
tools used
permissions requested
approvals
tool latency
model latency
tokens
cost
retries
failures
state transitions
final outcome
```

Evaluate OpenTelemetry compatibility and whether agent-native events can support production debugging, security review, and cost analysis.

Modern coding-agent architectures increasingly treat approvals, sandbox boundaries, network policy, and agent-native telemetry as first-class runtime concerns rather than UI-only features.

---

# 18. Security, Permissions and Trust Boundaries

Audit all agent permissions.

Inspect:

* filesystem access
* workspace boundaries
* shell access
* network access
* external APIs
* secrets
* environment variables
* credentials
* MCP servers
* browser control
* database access
* deployment access

Determine whether permissions support:

```text
ALLOW
ASK
DENY
```

at an appropriate granularity.

Evaluate:

* global policy
* project policy
* runtime policy
* agent policy
* subagent policy
* tool policy
* command-level policy
* path-level policy
* domain-level policy

Do not treat security as merely frontend approval buttons.

Determine whether controls are actually enforced by the runtime.

Compare architecture against modern patterns where sandboxing, permissions, network boundaries, explicit approvals, and audit telemetry are integrated into execution rather than added after the fact.

---

# 19. Prompt and Context Architecture

Audit:

* system prompts
* developer instructions
* runtime prompts
* agent prompts
* tool descriptions
* MCP descriptions
* memory injection
* project instructions
* user preferences
* conversation history
* task context
* compaction summaries

Find:

* duplicate instructions
* contradictory instructions
* excessive prompt size
* stale state
* context pollution
* tool description bloat
* prompt injection exposure
* incorrect priority ordering

Map the prompt construction hierarchy.

Example:

```text
Global Policy
    ↓
Organization Policy
    ↓
Project Policy
    ↓
Runtime Policy
    ↓
Agent Policy
    ↓
Task Context
    ↓
User Request
    ↓
Tool Context
```

Identify ambiguity or precedence bugs.

---

# 20. Output and Result Quality Audit

Audit everything the system produces.

Evaluate:

* response streaming
* progress display
* tool output
* code diffs
* artifacts
* citations
* research sources
* logs
* final summaries
* task status
* failure messages
* partial results

The user should understand:

```text
What is happening?
Why is it happening?
What has completed?
What is blocked?
What needs approval?
What changed?
What failed?
What remains?
```

A successful run should provide a clear final state and not force the user to reconstruct the outcome from raw logs.

---

# 21. UX Audit

Evaluate the application as a **developer-grade operating environment**, not just a chat interface.

Audit:

### Conversation UX

* sessions
* threads
* branches
* search
* history
* pinning
* naming
* archiving
* resume
* fork

### Agent UX

* running agents
* subagents
* background tasks
* progress
* status
* cancellation
* approvals
* errors
* retries

### Coding UX

* file explorer
* repository context
* diff
* terminal
* test results
* changed files
* commit/branch/worktree flow

### Research UX

* sources
* citations
* search progress
* evidence
* synthesis

### Swarm UX

* active workers
* worker roles
* progress
* dependencies
* failures
* aggregation
* final synthesis

---

# 22. Expected UX Benchmark

Benchmark the experience conceptually against leading agentic development patterns.

Do not blindly clone another product.

Instead compare underlying interaction primitives:

### Codex-style strengths to evaluate

* safe-by-default execution
* explicit permission boundaries
* sandboxing
* agent task progress
* strong terminal/diff presentation
* background/long-running work
* durable execution
* agent-native telemetry
* configurable autonomy

Codex's current architecture emphasizes sandboxing, approval policy, configurable network access, task progress, tool use, and detailed execution telemetry.

### Claude Code-style strengths to evaluate

* specialized subagents
* isolated context
* automatic delegation
* parallel work
* background sessions
* agent teams
* permission inheritance
* scoped agent configuration
* hooks
* context management
* resumability

Current Claude Code documentation explicitly supports specialized subagents, isolated context windows, foreground/background execution, agent teams, scoped permissions, hooks, and context-management mechanisms.

### Cursor-style strengths to evaluate

Assess the quality of:

* IDE-native context
* inline code interaction
* repository awareness
* agent execution
* terminal/tool integration
* fast feedback loops
* background work
* visual developer workflow

Do not copy UI conventions unless they solve the same underlying problems.

### OpenCode-style strengths to evaluate

Assess:

* explicit agent modes
* primary vs subagent separation
* granular tool permissions
* session continuation
* session forking
* remote/backend attachment
* web/research tools
* TODO/task tracking
* MCP extensibility

OpenCode currently exposes primary and subagent modes, per-tool permissions, task tracking, session continuation/forking, and remote backend attachment.

### Antigravity-style workflow

Evaluate the usefulness of an agent-manager/mission-control model:

```text
Workspace
  ↓
Mission
  ↓
Agent
  ↓
Plan
  ↓
Execution
  ↓
Artifacts
  ↓
Verification
```

### Discord-style workflow

Evaluate whether the platform can naturally support:

```text
Workspace
 ├── Channel
 │    ├── Thread
 │    │    ├── Task
 │    │    ├── Agent
 │    │    └── Result
 │    └── Conversation
 ├── Background Task
 └── Notification
```

Investigate whether persistent threads, async tasks, mentions, notifications, status changes, and durable conversation/task history would make the system more natural for collaborative agent workflows.

---

# 23. UX Principle to Enforce

The interface should evolve from:

```text
chat box
+
AI response
```

toward:

```text
conversation
+
task execution
+
agent supervision
+
developer workspace
+
persistent project context
+
observable runtime
```

The user should be able to remain at the level of intent:

> "Investigate the authentication issue and fix it."

while the system handles:

```text
Understand
→ inspect
→ plan
→ delegate
→ execute
→ test
→ verify
→ summarize
```

The user should only be interrupted for meaningful decisions.

Avoid requiring the user to manually orchestrate every low-level tool call.

---

# 24. Human-in-the-Loop Audit

Determine where human intervention is necessary.

Classify actions:

```text
LOW RISK
→ execute automatically

MEDIUM RISK
→ execute with lightweight approval

HIGH RISK
→ explicit approval

CRITICAL
→ block unless specifically authorized
```

Examples include:

* read files
* edit workspace files
* run tests
* install dependencies
* network access
* access secrets
* modify infrastructure
* destructive commands
* git push
* deployment
* database mutations

Evaluate whether the approval UX is:

* contextual
* understandable
* granular
* reusable
* auditable
* non-repetitive
* safe

---

# 25. Failure Mode Analysis

Force the system through failures.

Test:

* model timeout
* model refusal
* invalid tool call
* tool timeout
* tool crash
* malformed output
* network failure
* database failure
* queue failure
* worker crash
* browser disconnect
* duplicate request
* cancellation during tool execution
* cancellation during model generation
* subagent failure
* partial swarm failure
* stale session
* expired task
* corrupted state
* deployment restart

For every failure answer:

1. Is failure detected?
2. Is the correct state persisted?
3. Is the user informed?
4. Can the task recover?
5. Can it resume?
6. Can it retry safely?
7. Can it avoid duplicate side effects?
8. Is the incident observable?
9. Is the user experience understandable?

---

# 26. Concurrency and Parallelism Audit

Identify every place where work is incorrectly serialized.

Examples:

```text
independent model calls
independent file reads
independent searches
independent tool calls
independent subagents
independent research tasks
```

Determine where execution can become:

```text
parallel
batch
streaming
speculative
incremental
```

without violating ordering or correctness.

Quantify expected improvement.

---

# 27. Cost Optimization

Produce a cost model.

Measure:

* input tokens
* output tokens
* tool calls
* model calls
* subagent calls
* retries
* context compactions
* background tasks
* web/research calls
* storage operations

Identify:

* redundant calls
* excessive context
* overly expensive model usage
* wasteful agent delegation
* repeated tool execution

Recommend an explicit model-routing strategy.

Example:

```text
Simple Chat
→ fast/cheap model

Classification
→ lightweight model

Repository Search
→ lightweight model / specialized agent

Planning
→ medium/high reasoning model

Complex Coding
→ high-capability coding model

Verification
→ independent reviewer model

Large Parallel Research
→ inexpensive parallel workers
```

Do not optimize cost at the expense of correctness without showing the tradeoff.

---

# 28. Architecture Refactoring Assessment

Determine whether the current architecture needs:

* runtime abstraction
* execution engine
* agent registry
* task manager
* workflow engine
* event bus
* durable state machine
* queue abstraction
* worker pool
* permission engine
* artifact service
* context service
* memory service
* model router
* tool gateway
* observability layer

For every proposed abstraction explain:

* why it is necessary
* what problem it solves
* what it replaces
* migration risk
* complexity cost
* expected benefit

Avoid architecture for architecture's sake.

---

# 29. Anti-Patterns to Detect

Explicitly look for:

* giant monolithic agent loop
* frontend-driven orchestration
* runtime-specific duplicated logic
* implicit state machines
* unbounded recursion
* unbounded agent spawning
* synchronous long-running requests
* polling where event streaming is appropriate
* duplicated context
* duplicated model calls
* excessive tool chatter
* raw tool output copied into model context
* fragile retries
* non-idempotent jobs
* missing cancellation
* missing timeouts
* hidden permissions
* global mutable agent state
* shared context leakage
* agent state stored only in memory
* browser disconnect killing backend work
* tasks that cannot resume
* no durable execution identity
* no correlation IDs
* no audit reconstruction
* unclear task ownership
* no backpressure
* queue starvation
* retry storms
* zombie jobs
* orphaned workers
* model/provider coupling
* UI tightly coupled to backend state internals

---

# 30. Testing Strategy Audit

Determine whether the project has tests covering:

### Unit

* state transitions
* permission decisions
* routing
* retries
* context management
* tool adapters

### Integration

* runtime execution
* agent delegation
* database persistence
* queues
* tools
* streaming

### End-to-end

* Chat
* Agentic
* Coding
* Research
* Swarm

### Failure/recovery

* disconnect
* restart
* timeout
* cancellation
* worker failure
* tool failure
* model failure

### Performance

* latency
* concurrency
* throughput
* memory
* token usage
* cost

### UX

* task visibility
* approval flow
* live progress
* resume
* error handling

Recommend missing tests and prioritize them.

---

# 31. Required Deliverables

Produce the audit in the following structure.

## A. Executive Verdict

Give a concise overall assessment:

```text
Architecture Maturity: X / 10
Runtime Maturity: X / 10
Agent Orchestration: X / 10
Backend Reliability: X / 10
Performance: X / 10
Observability: X / 10
Security: X / 10
Developer UX: X / 10
Multi-Agent Readiness: X / 10
Production Readiness: X / 10
```

Then state:

* strongest architectural decisions
* largest weaknesses
* biggest hidden risks
* highest-value improvements

---

## B. Runtime Matrix

Create:

| Runtime  | Exists | Quality | Main Strength | Main Defect | Priority |
| -------- | ------ | ------- | ------------- | ----------- | -------- |
| Chat     |        |         |               |             |          |
| Agentic  |        |         |               |             |          |
| Coding   |        |         |               |             |          |
| Research |        |         |               |             |          |
| Swarm    |        |         |               |             |          |
| Other    |        |         |               |             |          |

---

## C. Complete Architecture Diagram

Produce an implementation-grounded architecture diagram showing:

```text
Client
↓
API
↓
Session
↓
Runtime Router
↓
Execution Engine
↓
Agent Orchestrator
↓
Model Router
↓
Tools / MCP / Browser / Shell
↓
Workers
↓
State / Queue / DB / Cache
↓
Events / Telemetry
↓
UI
```

Mark existing vs recommended components.

---

## D. Lifecycle State Machine

Produce the actual current state machine.

Then produce the recommended state machine.

Clearly show missing transitions.

---

## E. Pipeline Bottleneck Report

Identify the top latency bottlenecks.

For each:

```text
Problem
Evidence
Root Cause
Impact
Recommended Fix
Estimated Improvement
Implementation Risk
```

---

## F. Agent Architecture Report

Describe:

* current hierarchy
* delegation behavior
* context boundaries
* concurrency
* permissions
* failure behavior
* recommended architecture

---

## G. UX Gap Analysis

Compare the current workflow against the strongest interaction patterns from modern coding agents and collaborative async workflows.

Use this structure:

| Capability | Current | Target | Gap | Priority |
| ---------- | ------- | ------ | --- | -------- |

Focus on primitives rather than superficial visual similarity.

---

## H. Backend Optimization Plan

Rank improvements by:

```text
Impact
Effort
Risk
Dependency
Expected ROI
```

Separate:

### Quick wins

Changes that can be implemented with minimal architectural disruption.

### Medium-term

Changes requiring moderate refactoring.

### Strategic

Changes requiring architectural evolution.

---

## I. P0/P1/P2/P3 Priorities

### P0 — Critical

Reliability, correctness, security, data loss, runaway execution.

### P1 — High

Major latency, lifecycle, orchestration, or UX problems.

### P2 — Medium

Important quality and scalability improvements.

### P3 — Optimization

Polish and advanced capabilities.

---

# 32. Recommended Target Architecture

After auditing the current implementation, design a target architecture for a modern agent platform.

At minimum evaluate this conceptual architecture:

```text
                    ┌──────────────────────┐
                    │      Client UX       │
                    │ Chat / IDE / Threads │
                    └──────────┬───────────┘
                               │
                         Session API
                               │
                    ┌──────────▼───────────┐
                    │   Runtime Router     │
                    │ Chat / Agent / Code  │
                    │ Research / Swarm     │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │ Execution Engine     │
                    │ Durable State Machine│
                    └──────────┬───────────┘
                               │
              ┌────────────────┼─────────────────┐
              │                │                 │
        ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼─────┐
        │ Model     │   │ Agent       │   │ Tool      │
        │ Router    │   │ Orchestrator│   │ Gateway   │
        └─────┬─────┘   └──────┬──────┘   └─────┬─────┘
              │                │                 │
              │          ┌─────▼─────┐     ┌────▼────┐
              │          │ Subagents │     │ MCP/Web │
              │          │ / Workers │     │ Shell   │
              │          └─────┬─────┘     └─────────┘
              │                │
        ┌─────▼────────────────▼─────┐
        │ Context / Memory / State   │
        └────────────┬───────────────┘
                     │
          ┌──────────▼──────────┐
          │ Queue / Event Bus   │
          └──────────┬──────────┘
                     │
     ┌───────────────▼─────────────────┐
     │ Durable DB / Cache / Artifacts │
     └───────────────┬─────────────────┘
                     │
              ┌──────▼──────┐
              │ Observability│
              │ Logs/Metrics │
              │ Traces/Audit │
              └─────────────┘
```

Modify this architecture based on what the repository actually requires.

---

# 33. UX Target State

Describe the desired user experience as an interaction flow.

Example:

```text
User:
"Investigate the auth issue and fix it."

System:

1. Understand request.
2. Select Agentic/Coding runtime.
3. Explain plan.
4. Start execution.
5. Show live progress.
6. Delegate repository exploration.
7. Inspect relevant files.
8. Run diagnostics.
9. Make changes.
10. Run tests.
11. Review diff.
12. Verify result.
13. Present concise outcome.
14. Persist task state.
15. Allow user to resume, inspect, fork, or continue.
```

For long-running work:

```text
User starts task
        ↓
Task continues in background
        ↓
User closes browser
        ↓
Agent keeps running
        ↓
Task completes
        ↓
Notification
        ↓
User opens task
        ↓
Full execution timeline
        ↓
Final diff / artifacts / summary
```

For Swarm:

```text
User request
   ↓
Supervisor
   ├── Research agent
   ├── Coding agent
   ├── Test agent
   └── Review agent
          ↓
      Aggregator
          ↓
      Verification
          ↓
       Result
```

---

# 34. Important Review Rules

Follow these rules throughout the audit:

1. Inspect before recommending.
2. Trace execution paths instead of relying on filenames.
3. Prefer measured evidence over assumptions.
4. Distinguish architecture problems from implementation bugs.
5. Identify root causes, not only symptoms.
6. Do not recommend rewriting the system without proving why.
7. Prefer incremental migration where possible.
8. Quantify performance improvements when measurable.
9. Treat cancellation, retry, recovery, and resumability as first-class requirements.
10. Treat observability as part of the runtime architecture.
11. Treat permissions as runtime enforcement, not merely UI.
12. Treat agent context isolation as an optimization and correctness boundary.
13. Treat background tasks as durable workloads, not browser sessions.
14. Preserve user control while minimizing unnecessary approval interruptions.
15. Make all recommendations implementation-specific.

---

# 35. Final Output Requirements

End the audit with these sections:

## Top 10 Problems

Ranked by severity and impact.

## Top 10 Opportunities

Ranked by ROI.

## Top 10 UX Improvements

Prioritized according to user impact.

## Top 10 Backend Improvements

Prioritized according to latency, scale, cost, and reliability.

## Target Runtime Model

Show how Chat, Agentic, Coding, Research, and Swarm should relate.

## Target Agent Model

Show:

```text
Primary Agent
→ Planner
→ Specialized Subagents
→ Tools
→ Verification
```

## Target Lifecycle Model

Show the complete durable lifecycle.

## Target Event Model

Show the recommended execution events.

## Target Permission Model

Show the recommended:

```text
ALLOW
ASK
DENY
```

hierarchy.

## Migration Roadmap

Provide:

```text
Phase 0 — Instrument
Phase 1 — Stabilize
Phase 2 — Optimize
Phase 3 — Unify Runtime
Phase 4 — Improve Agent Orchestration
Phase 5 — Upgrade UX
Phase 6 — Scale Swarm / Background Execution
```

For every phase provide:

* objectives
* exact changes
* dependencies
* risks
* validation criteria
* rollback strategy

---

# 36. Definition of Success

The system should ultimately provide this experience:

> **One persistent workspace where the user can converse, delegate work, run agents, inspect progress, approve sensitive actions, see code changes, perform research, run parallel agents, receive background results, recover interrupted tasks, and resume work without losing context.**

The underlying platform should be:

* durable
* observable
* cancellable
* resumable
* parallel
* permission-aware
* cost-aware
* model-agnostic
* runtime-agnostic
* extensible
* secure
* fast
* developer-friendly

The most important goal is not to imitate another product's UI.

The goal is to achieve the same **quality of interaction primitives**:

```text
Intent
→ Context
→ Plan
→ Execute
→ Observe
→ Approve
→ Parallelize
→ Verify
→ Persist
→ Resume
```

Perform the audit against the actual implementation and finish with a concrete, prioritized path from the current architecture to this target state.
