# Runtime router and flavors
> Type: Feature · Status: aligned · Updated: 2026-10-05

## Intent
Every execution request needs one deterministic answer — which runtime flavor runs this turn — plus a stable contract per flavor so callers (Queue, Sockets, Routes) hand off `(agent, input)` without knowing how execution works.

## Architectural decision
Routing is a fixed precedence chain — explicit override → librarian/tag match → authority-level default — with disabled-flavor pins enforced at BOTH router and executor layers, so neither an explicit override nor a tag match can slip into a disabled runtime [Observed]. Unknown types warn and fall back to agentic instead of throwing, and `execute` itself never rejects on agent failure (failed `RuntimeResult`, never a throw) [Observed]. The rejected alternative is caching the flag reads: both layers re-evaluate `RESEARCH_V1`/`SWARM_V1` per call so a flag flip takes effect without reboot [Inferred].

## How it works
Before routing, `execute` stabilizes intent with pure `interpret({ content, explicitRuntime })` (raw @-targets, mode hint, execution hints; `ambiguous` with listed assumptions when bare) and carries it as `packet.interpreterOutput` — the Router itself takes no intent input and its precedence is unchanged. `runtimeGate.route` delegates to the singleton `RuntimeRouter`: an explicit `explicitRuntime` wins (subject to research/swarm pins), else a librarian-agent match or channel-tag match (`coding|dev`, `research|data`, `swarm|ops`) decides, else authority level decides (L0–1 agentic, L2 swarm-or-agentic, L3+ conversational). The executor re-pins research/swarm → agentic when flags are off, hot-swaps the runtime map per call, and falls back to agentic for unknown types. Each flavor implements one contract (`IRuntime.execute(packet, broker)`): conversational runs a single LLM call with no tools; agentic runs the tool loop with resume-skip, budget re-check, and per-call checkpoint touches; coding runs a pi-core session over the registered provider adapter; research decomposes → isolated search → evidence bundle → synthesis; swarm plans → persists a task DAG → dispatches → aggregates → verifies (or delegates wholesale to agentic when `SWARM_V1` is off). Provider binding happens during context assembly: the agent's model module is read with the execution workspace, its stored provider is stamped on `packet.metadata`, and `RuntimeKernel.callLLM` selects the matching adapter; Google is only the fallback when no module row resolves.

## Components involved
| Domain spec | Role |
| --- | --- |
| <../Domain Spec/Runtime.md> | Owns routing order, flag pins, the five flavor contracts, and run open/close around execution |
| <../Domain Spec/Runs.md> | Owns run rows and the transition state machine Runtime walks (adopt/open/close) |
| <../Domain Spec/Swarm.md> | Owns swarm DAG storage/dispatch consumed by the swarm flavor |
| <../Domain Spec/Tools.md> | Owns tool implementations executed by the agentic loop |
| <../Domain Spec/Queue.md> | Owns delivery into `runtimeGate.execute`; never routes |

## Current state
Real: router precedence, dual-layer research/swarm pins, all five flavors, unknown-type fallback to agentic, cancel-as-`cancelled` (never failure). Flag-gated: research flavor (`RESEARCH_V1`, default off → agentic), swarm flavor (`SWARM_V1`, default off → agentic). Stub: none.

## Alignment notes
- 2026-10-05 Model provider binding: context assembly now passes `ctx.workspaceId` to `moduleGate.model.get` and includes it in the model cache key, so workspace-local custom/OpenAI-compatible rows resolve to their own adapters. Unbound agents reject with `MODEL_MODULE_NOT_CONFIGURED` — no Google fallback remains.
- 2026-09-16 D3 (§23, low-pressure): 5 flavors kept; composition reading is Coding=Agentic+Sandbox, Research=Planning+Swarm. Planning/Observer/Orchestrator not built — correctly deferred per §34 (overlap Nitehunter/L0, non-priority). No speculative build.
- 2026-09-16 D4 (§20/§34): Skills trigger system stays future/non-priority. Minimal service + tool injection kept; no action.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* COMPOSER_MODE_TO_RUNTIME covers every composer mode including swarm, or swarm entry is explicitly unsupported with a documented path. Silent missing entries are forbidden.
* Pin-versus-genuine routing is caller-distinguishable, not log-only. Silent pins are forbidden.
* closeRun has a defined read-after-close consistency rule. Fire-and-forget close without a contract is forbidden. Authority: Runtime standard.
## Open gaps
- `COMPOSER_MODE_TO_RUNTIME` maps `chat → conversational` but has no `swarm` entry — composer-driven swarm routing path unverified.
- Pin-vs-genuine-routing is indistinguishable to callers (pins log only) — whether operators need a pin signal is unverified.
- `closeRun` is fire-and-forget, so callers may observe the terminal state one hop late — read-after-close consistency unverified.
