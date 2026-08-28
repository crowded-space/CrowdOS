# CrowdOS / ThisCrowd — Performance, Optimization & Latency Engineering Master Prompt

## Mission

Act as the **principal performance engineer, distributed-systems optimizer, AI inference architect, database performance engineer, runtime engineer, and developer-experience performance specialist** for the CrowdOS codebase.

Your sole focus is to make the platform **materially faster, cheaper, more responsive, and more scalable** without degrading correctness, security, durability, observability, or UX.

Use the existing `AUDIT_REPORT.md` as the baseline.

The audit identifies major performance problems including:

* serial context assembly;
* 6–9 database round trips during context construction;
* serial Agentic tool execution;
* unbounded context/tool-output growth;
* blocking memory writes on the hot path;
* missing connection reuse;
* excessive Socket.IO event fan-out;
* fake token accounting;
* absent caching;
* no cost-aware model routing;
* synchronous execution architecture;
* no durable background worker separation.

These findings are the starting hypotheses. Validate them with current repository evidence before changing anything.

The primary objective is:

> **Reduce user-perceived latency and infrastructure cost while increasing throughput and preserving correctness.**

Do not optimize by intuition alone.

Measure.

Profile.

Change.

Measure again.

---

# 1. Performance Goals

Optimize the entire path:

```text
User Intent
→ Client
→ Network
→ API
→ Auth
→ Session lookup
→ Runtime selection
→ Context assembly
→ Model request
→ Tool execution
→ Agent orchestration
→ Persistence
→ Event streaming
→ UI rendering
```

Treat all of these as potential latency contributors.

Optimize for:

```text
TTFT
Time to first useful progress
Time to first tool action
Time to first visible artifact
Time to useful answer
Time to task completion
p50
p90
p95
p99
CPU
Memory
DB load
Network overhead
Token usage
Model cost
Worker utilization
Concurrency
```

Do not optimize only average latency.

---

# 2. Performance North Star

The platform should feel:

```text
instant for simple Chat
fast for Agentic interactions
responsive during Coding
efficient for Research
parallel for Swarm
```

The user should see meaningful progress quickly even when total task duration is long.

Prioritize:

```text
perceived responsiveness
+
real completion latency
+
resource efficiency
```

---

# 3. Mandatory Performance Method

Before making substantial changes:

## Establish a baseline

Measure current:

```text
API request latency
context assembly
DB latency
LLM TTFT
LLM total latency
tool latency
agent iteration latency
persistence latency
Socket emission latency
frontend render latency
```

At:

```text
p50
p90
p95
p99
```

Do not invent measurements.

If the project currently lacks measurements, instrument first.

---

# 4. Build a Latency Waterfall

For one request produce:

```text
Request received                0 ms
Auth                             X ms
Session lookup                   X ms
Runtime selection                X ms
Context assembly                X ms
Prompt serialization             X ms
Model TTFT                       X ms
First tool                       X ms
Tool execution                   X ms
Model continuation               X ms
Persistence                      X ms
Final event                      X ms
UI render                        X ms
```

Identify:

```text
critical path
parallelizable path
avoidable path
duplicate work
backgroundable work
cacheable work
```

---

# 5. Define Performance Budgets

Create explicit target budgets.

Example starting targets:

```text
Chat context assembly:
< 100–150 ms target

Chat server-side pre-LLM overhead:
< 150 ms target

First visible progress:
< 200 ms where possible

Agent tool dispatch overhead:
< 20 ms excluding actual tool work

Persistence overhead:
< 20–50 ms on hot path

Socket event batching:
~50 ms configurable flush

Queue scheduling overhead:
< 50 ms target
```

These are starting targets, not assumptions.

Tune them after measurement.

---

# 6. Performance Rule: Never Hide Latency

Do not claim:

> "performance improved"

unless measurements show it.

For every optimization report:

```text
Before
After
Absolute improvement
Percentage improvement
Measurement conditions
Regression risk
```

---

# 7. Context Pipeline Optimization

The audit identifies the ContextPipelineManager as a significant bottleneck.

Inspect every middleware:

```text
Identity
Channel
Instruction
Skill
Tool
Constraint
Memory
Visibility
Limit
Compression
```

Determine:

```text
dependencies
database calls
CPU work
network work
cacheability
output size
```

Build a dependency graph.

---

# 8. Parallelize Independent Context Work

Do not preserve unnecessary sequential execution.

Transform:

```text
A
→ B
→ C
→ D
```

into:

```text
      ┌─ A ─┐
      ├─ B ─┤
      ├─ C ─┤
      └─ D ─┘
          ↓
       Merge
```

Use:

```text
Promise.all(...)
```

where operations are independent.

Use explicit dependencies where they are not.

Never introduce races into:

```text
permissions
visibility
context precedence
memory mutation
```

---

# 9. Database Round-Trip Elimination

For every request:

Count DB queries.

Identify:

```text
duplicate reads
N+1 queries
sequential queries
queries whose results overlap
queries that could be batched
queries that could be cached
queries that should leave the hot path
```

Create a request-level query inventory.

Target:

```text
fewer queries
fewer sequential waits
smaller payloads
fewer ORM transformations
```

---

# 10. Database Parallelism

Where safe:

```text
Promise.all([
  instructionQuery,
  skillQuery,
  constraintQuery,
  memoryQuery
])
```

Do not parallelize writes that have ordering constraints.

Use transactions where consistency is required.

---

# 11. Database Query Optimization

Inspect:

* indexes;
* query plans;
* sequential scans;
* joins;
* filtering;
* ordering;
* pagination;
* `COUNT(*)`;
* JSON extraction;
* text search;
* ORM-generated queries.

Run:

```text
EXPLAIN
EXPLAIN ANALYZE
```

for critical queries.

Do not add indexes blindly.

For every new index explain:

```text
query accelerated
index size
write cost
expected benefit
```

---

# 12. Connection Pool Optimization

Audit PostgreSQL configuration.

Measure:

```text
active connections
idle connections
wait time
connection acquisition
query duration
pool saturation
```

Optimize:

```text
pool size
idle timeout
connection reuse
transaction duration
```

Do not simply increase pool size without measuring DB capacity.

---

# 13. HTTP / Provider Connection Reuse

Audit all model adapters.

Eliminate unnecessary per-request connection establishment.

Use connection reuse / keep-alive where supported.

Measure:

```text
DNS
TCP
TLS
connection reuse
TTFT
```

Separate:

```text
network setup time
provider queue time
provider inference time
client parsing time
```

Do not attribute everything to the model.

---

# 14. LLM Latency Optimization

Treat model inference as a measurable pipeline.

For each model call track:

```text
request serialization
network time
TTFT
generation duration
output tokens
total tokens
retries
provider
model
temperature/config
```

Identify:

```text
unnecessary model calls
duplicate prompts
oversized system prompts
unnecessary history
unnecessary tool schemas
repeated reasoning
```

---

# 15. Prompt Size Optimization

Measure prompt size before each call.

Track:

```text
system tokens
instruction tokens
history tokens
tool schema tokens
memory tokens
tool result tokens
user tokens
```

Find the largest contributors.

Reduce:

```text
duplicate instructions
unused tools
irrelevant history
old tool outputs
repeated memory
verbose schemas
```

Do not optimize by deleting context blindly.

Preserve task-critical information.

---

# 16. Tool Schema Optimization

Inspect tool definitions sent to models.

Measure:

```text
number of tools
schema token cost
average schema size
unused tools per runtime
```

Only expose tools relevant to the current runtime/task.

For example:

```text
Chat
→ minimal/no tools

Coding
→ filesystem + terminal + Git tools

Research
→ search/retrieval/citation tools

Swarm worker
→ only tools assigned to worker
```

Reduce tool-selection latency and prompt size.

---

# 17. Context Growth Control

Prevent:

```text
tool output
→ history
→ next prompt
→ duplicated tool output
→ larger history
→ larger prompt
```

Use:

```text
truncation
summarization
artifact storage
context compression
windowing
```

Measure cumulative token growth.

Target:

```text
linear or bounded context growth
```

rather than runaway accumulation.

---

# 18. Tool Output Strategy

For large results:

```text
tool
→ full result
→ artifact storage
→ compact summary
→ model
```

Do not send enormous raw output back into every future model call.

Use:

```text
maxToolOutputTokens
```

and configurable size thresholds.

Preserve the full result as an artifact when needed.

---

# 19. Context Compaction

Trigger compaction based on actual context utilization.

Example:

```text
< 60%
→ no action

60–70%
→ prepare compaction

~70%
→ compact

> 85%
→ emergency compression / truncation
```

After compaction:

```text
recalculate token budget
verify critical information retained
```

Do not let compression itself re-overflow the context limit.

---

# 20. Agentic Loop Optimization

Inspect every Agentic iteration.

Measure:

```text
model call
tool selection
tool dispatch
tool runtime
tool result serialization
history update
next model call
```

Determine which phases can overlap.

---

# 21. Parallel Tool Execution

For independent calls:

```text
read A
read B
search C
```

execute concurrently.

For dependent actions:

```text
write X
→ read X
```

serialize.

Build a simple dependency classifier.

At minimum classify:

```text
read-only
write
destructive
network
stateful
```

---

# 22. Parallel Agent Execution

For independent agents:

```text
Research A
Research B
Research C
```

execute concurrently through durable workers.

Do not create:

```text
Promise.all([...])
```

with no concurrency limit.

Use:

```text
worker limit
queue
backpressure
priority
```

---

# 23. Concurrency Controls

Introduce explicit limits:

```text
maxConcurrentRuns
maxConcurrentTools
maxConcurrentWorkers
maxConcurrentProviderCalls
maxConcurrentDBQueries
```

Tune from measurements.

Avoid:

```text
unbounded Promise.all
```

because maximizing concurrency can increase overall latency through contention.

---

# 24. Queue Scheduling

Measure:

```text
queue wait
worker acquisition
execution
```

Implement priority where appropriate.

Example:

```text
interactive Chat
→ highest

interactive Agentic
→ high

foreground Coding
→ high

background Research
→ medium

background Swarm
→ configurable

maintenance
→ low
```

Do not starve background work.

---

# 25. Backpressure

Add backpressure to:

```text
model requests
tools
workers
database
event streams
Socket.IO
```

When a downstream component is saturated:

```text
slow intake
queue
batch
drop only non-critical ephemeral events
```

Never drop durable state transitions.

---

# 26. Socket Performance

The audit identifies event fan-out as a problem.

Measure:

```text
events/sec
bytes/sec
connections
per-room traffic
per-client backlog
CPU/event
```

Use room scoping.

---

# 27. Stream Batching

Do not emit every token individually.

Use:

```text
collect chunks
→ flush ~every 50 ms
```

Make it adaptive if useful.

Example:

```text
high throughput
→ more aggressive batching

low throughput
→ immediate flush
```

Maintain acceptable perceived responsiveness.

---

# 28. Event Priority

Classify events:

```text
CRITICAL
state transitions
approval
completion
failure
artifact

IMPORTANT
tool lifecycle
agent lifecycle
progress

EPHEMERAL
token chunks
typing indicators
```

Only ephemeral events may be aggressively batched/coalesced.

Durable events must remain lossless and ordered.

---

# 29. Frontend Performance

Audit frontend latency.

Measure:

```text
socket message handling
state updates
React render count
component render duration
DOM growth
memory usage
large message rendering
terminal rendering
diff rendering
```

Find unnecessary rerenders.

---

# 30. State Management Optimization

Audit Zustand/state usage.

Look for:

```text
global updates triggering all components
large objects copied on every event
high-frequency stream updates
derived state recalculated unnecessarily
```

Use:

```text
selectors
structural sharing
event batching
throttled UI updates
virtualization
```

---

# 31. Chat Rendering

A streaming response must not cause excessive React renders.

Do not update the entire conversation tree for every token.

Use:

```text
buffered token updates
50 ms render batch
local streaming state
incremental message mutation
```

Measure render frequency.

---

# 32. Large History Rendering

Virtualize long conversations.

Avoid rendering thousands of messages simultaneously.

Use:

```text
windowing
pagination
incremental history loading
```

Do not preload all historical data simply to display the current thread.

---

# 33. Coding UX Performance

Optimize:

```text
file tree loading
search
code indexing
diff rendering
terminal output
Git status
test results
```

Use incremental updates instead of full refreshes.

---

# 34. File Tree Optimization

Audit `LocalVFS`.

Look for:

```text
fs.stat per node
recursive scans
duplicate traversal
repeated file metadata
```

Implement:

```text
LRU cache
workspace metadata cache
incremental invalidation
batched stat operations
```

Avoid rescanning the entire repository after every edit.

---

# 35. Code Search / Indexing

Avoid rebuilding indexes unnecessarily.

Use:

```text
incremental indexing
file-change events
hash-based invalidation
cached symbol metadata
```

Prioritize visible/active files.

---

# 36. Terminal Performance

For streamed terminals:

```text
stdout/stderr
→ buffer
→ batch to client
→ incremental render
```

Do not create a frontend render for every byte.

Virtualize large terminal buffers.

Cap retained terminal history.

---

# 37. Caching Strategy

Create a cache inventory.

For each cache:

```text
key
scope
TTL
invalidation
size
hit rate
miss cost
memory cost
```

Prioritize:

```text
modelModules
agent skills
resolved tools
recent messages
file tree
repository metadata
search indexes
prompt fragments
```

---

# 38. Cache Correctness

Never allow cache results to bypass:

```text
authorization
workspace boundaries
agent permissions
runtime isolation
```

Include relevant security dimensions in cache keys.

Invalidate immediately after mutations that change behavior.

---

# 39. Memory Performance

Audit memory retrieval.

Measure:

```text
query count
embedding lookup latency
candidate count
ranking cost
serialization cost
context contribution
```

Avoid retrieving large numbers of candidates only to discard most of them.

---

# 40. Memory Write Optimization

Memory writes should not block interactive response unless correctness requires it.

Move low-priority memory persistence to background execution.

Do not create memory notes for every trivial interaction.

Use heuristics such as:

```text
importance
novelty
size
task significance
```

---

# 41. Serialization Optimization

Audit:

```text
JSON.stringify
JSON.parse
ORM mapping
event payloads
tool results
message history
```

Find repeated serialization.

Do not serialize large data repeatedly between:

```text
runtime
broker
database
socket
frontend
```

Use compact event payloads.

---

# 42. Garbage Collection and Memory

Profile Node.js memory.

Inspect:

```text
heap growth
retained histories
event listeners
socket references
cached tool outputs
large buffers
terminal output
```

Watch for:

```text
memory leak
unbounded cache
unbounded event history
listener accumulation
```

Use heap snapshots for suspicious paths.

---

# 43. CPU Optimization

Profile CPU hotspots.

Pay particular attention to:

```text
context assembly
token accounting
JSON processing
file tree construction
search indexing
diff generation
event fan-out
React rendering
```

Do not optimize code that is not on the critical path.

---

# 44. Token Cost Optimization

Track per-run:

```text
promptTokens
completionTokens
cachedTokens
toolTokens
modelCalls
estimatedCost
```

Identify waste.

Optimize through:

```text
smaller prompts
fewer model calls
cheaper models
better context compression
tool parallelism
subagent specialization
```

---

# 45. Model Routing Optimization

Build a complexity-aware router.

Use characteristics such as:

```text
task type
context size
expected reasoning depth
coding complexity
verification requirement
latency target
budget
```

Do not route every request to the most expensive model.

---

# 46. Speculative / Prefetch Opportunities

Look for safe prefetching.

Examples:

```text
user opens repository
→ prefetch file tree

user opens channel
→ prefetch recent messages

coding task starts
→ prefetch repo metadata

runtime selected
→ prefetch tool definitions
```

Never prefetch expensive LLM work merely because it might be needed unless the expected value is justified.

---

# 47. Critical Path Reduction

For every stage ask:

> Can this execute before the user request?

Examples:

```text
static configuration
→ startup

tool schemas
→ cache

model metadata
→ cache

workspace metadata
→ background/index time

repository index
→ incremental background task
```

Move deterministic work out of the request path.

---

# 48. Hot-Path Rule

The synchronous interactive path should contain only work required to generate the next user-visible result.

Move these off the hot path where safe:

```text
memory writes
analytics
noncritical indexing
secondary persistence
notifications
cost aggregation
telemetry enrichment
artifact post-processing
```

Never move security or correctness checks off the hot path merely for speed.

---

# 49. Runtime-Specific Optimization

## Chat

Optimize for:

```text
TTFT
minimal context
minimal tools
streaming
low DB overhead
low render overhead
```

Chat should be the fastest runtime.

---

## Agentic

Optimize for:

```text
tool parallelism
context bounds
loop detection
checkpoint efficiency
model call reduction
```

---

## Coding

Optimize for:

```text
repository context
incremental file indexing
terminal responsiveness
tool parallelism
diff generation
test execution
```

---

## Research

Optimize for:

```text
parallel retrieval
source deduplication
source caching
worker isolation
compact synthesis
```

---

## Swarm

Optimize for:

```text
worker scheduling
parallelism
queue throughput
DAG critical path
aggregation
load balancing
```

---

# 50. Swarm Critical-Path Optimization

Do not measure Swarm only by total work.

Measure:

```text
critical path duration
worker idle time
worker utilization
dependency wait time
aggregation time
verification time
```

Optimize the DAG itself.

Find tasks that can run concurrently.

Avoid unnecessary synchronization barriers.

---

# 51. Distributed Worker Efficiency

For workers:

```text
startup latency
lease acquisition
DB polling
heartbeat overhead
task execution
result persistence
```

Optimize worker utilization.

Do not heartbeat excessively.

Do not poll the DB aggressively.

Prefer efficient wake/scheduling mechanisms where supported.

---

# 52. Retry Optimization

Retries can destroy performance and cost.

Audit:

```text
retry count
backoff
jitter
retryable errors
non-retryable errors
duplicate side effects
```

Never retry:

```text
invalid command
authorization failure
bad input
deterministic schema error
```

without strong reason.

Use:

```text
exponential backoff
jitter
bounded attempts
```

---

# 53. Timeout Optimization

Set timeouts by operation:

```text
DB
HTTP
LLM
tool
terminal
worker
queue
approval
```

Do not use one giant timeout for everything.

Measure actual distributions and set timeouts around realistic tail behavior.

---

# 54. Performance Regression Framework

Create benchmarks for:

```text
Chat TTFT
Agentic iteration
Coding tool cycle
Research worker
Swarm DAG
context assembly
database-heavy request
frontend rendering
socket throughput
```

Run before and after optimization.

Store benchmark results.

---

# 55. Load Testing

Test:

```text
1 concurrent user
10
50
100
500
```

or the highest realistic environment available.

Measure:

```text
p50
p95
p99
error rate
queue time
DB saturation
CPU
memory
provider saturation
```

Find the first bottleneck.

Do not scale every subsystem blindly.

---

# 56. Capacity Model

Produce a rough capacity model:

```text
one server
→ X concurrent Chat runs

Y concurrent Agentic runs
Z workers
DB throughput
provider throughput
```

Show what becomes the bottleneck first.

---

# 57. Performance vs Correctness Guardrails

Every optimization must preserve:

```text
authorization
visibility
memory isolation
tool dependency order
message ordering
event ordering
durability
idempotency
```

If parallel execution conflicts with any of these, preserve correctness.

---

# 58. Performance Observability

Add dashboards/metrics for:

```text
request latency
TTFT
runtime latency
context latency
DB latency
tool latency
queue latency
worker latency
LLM latency
tokens
cost
cache hit rate
event rate
frontend render rate
```

Correlate by:

```text
runId
runtime
model
workspace
agent
```

---

# 59. Performance Findings Classification

Every optimization candidate must be classified:

```text
P0 — severe latency/resource problem
P1 — high-impact hot path
P2 — meaningful efficiency improvement
P3 — polish
```

Also classify:

```text
CPU-bound
IO-bound
DB-bound
network-bound
model-bound
serialization-bound
render-bound
contention-bound
```

---

# 60. Required Optimization Report

Produce:

## A. Latency Waterfall

Current vs optimized.

## B. Top 20 Bottlenecks

For every bottleneck:

```text
location
cause
measurement
critical path contribution
fix
expected improvement
risk
```

## C. Database Report

Show:

```text
query count
slow queries
N+1 queries
index opportunities
pool utilization
```

## D. LLM Report

Show:

```text
calls/run
tokens/run
TTFT
generation time
prompt composition
cost
```

## E. Tool Report

Show:

```text
calls/run
serial vs parallel
latency
timeouts
retries
payload sizes
```

## F. Frontend Report

Show:

```text
render frequency
render duration
stream processing
memory growth
large-list behavior
```

## G. Cache Report

Show:

```text
cache
hit rate
miss cost
memory
TTL
invalidation
```

## H. Scaling Report

Show:

```text
concurrency
throughput
queue saturation
worker utilization
DB saturation
first bottleneck
```

---

# 61. Required Implementation Priority

Prioritize this order unless measurements prove another order is better:

### P0

```text
event/privacy fan-out
unbounded memory/context
leaking background operations
connection/resource exhaustion
```

### P1

```text
parallel context assembly
cache frequently repeated reads
parallel safe tools
connection reuse
stream batching
move noncritical work off hot path
real token accounting
```

### P2

```text
model routing
frontend rendering
file-tree caching
search/index optimization
worker scheduling
```

### P3

```text
prefetch
speculative work
advanced batching
micro-optimizations
```

---

# 62. Required Engineering Output

After implementation provide:

## Performance Score

```text
TTFT: X/10
Context: X/10
DB: X/10
LLM efficiency: X/10
Tool execution: X/10
Agent orchestration: X/10
Frontend: X/10
Caching: X/10
Scalability: X/10
Cost efficiency: X/10
```

## Before/After Table

| Metric               | Before | After | Change |
| -------------------- | -----: | ----: | -----: |
| Context assembly p50 |        |       |        |
| Context assembly p95 |        |       |        |
| Chat TTFT p50        |        |       |        |
| Chat TTFT p95        |        |       |        |
| Agent iteration      |        |       |        |
| Tool batch latency   |        |       |        |
| DB queries/request   |        |       |        |
| Prompt tokens/run    |        |       |        |
| Model calls/run      |        |       |        |
| Cost/run             |        |       |        |
| Socket events/sec    |        |       |        |
| Frontend renders/sec |        |       |        |

Only populate numbers backed by actual measurements.

---

# 63. Final Acceptance Criteria

Do not declare the optimization effort complete unless:

* [ ] baseline measurements exist;
* [ ] critical path is instrumented;
* [ ] context pipeline has been optimized;
* [ ] redundant DB work has been reduced;
* [ ] important caches exist;
* [ ] tool parallelism is implemented safely;
* [ ] context limits are enforced;
* [ ] large tool output is controlled;
* [ ] model connection reuse is implemented where appropriate;
* [ ] Socket.IO streaming is batched/throttled;
* [ ] frontend streaming does not trigger pathological rerenders;
* [ ] token accounting is real;
* [ ] memory hot-path writes are minimized;
* [ ] concurrency limits exist;
* [ ] retry/timeout behavior is bounded;
* [ ] load/performance tests exist;
* [ ] before/after measurements are recorded;
* [ ] no security, authorization, or durability regression was introduced.

---

# 64. Final Optimization Principle

The target architecture is not:

```text
make everything parallel
```

It is:

```text
remove unnecessary work
+
remove unnecessary waiting
+
remove unnecessary model calls
+
remove unnecessary DB calls
+
remove unnecessary context
+
reuse connections
+
cache stable data
+
parallelize independent work
+
batch high-frequency events
+
move noncritical work off the hot path
+
preserve correctness and durability
```

The desired system should move toward:

```text id="f2kz6q"
User
 ↓
Fast request admission
 ↓
Minimal context preparation
 ↓
Fast model start
 ↓
Immediate visible progress
 ↓
Parallel independent work
 ↓
Incremental persistence
 ↓
Efficient event streaming
 ↓
Verification
 ↓
Fast final response
```

The ultimate success criterion is:

> **The user should experience CrowdOS as fast and responsive even when the underlying task is complex.**

Do not optimize only the backend.

Optimize the **entire perceived execution path from user intent to useful result**.

Start by profiling the actual repository, identify the current top bottlenecks, implement the highest-ROI changes, benchmark before/after, and continue iterating until the measured latency, throughput, token efficiency, and cost materially improve without regressions.
