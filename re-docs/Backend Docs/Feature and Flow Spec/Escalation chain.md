# Escalation chain
> Type: Feature · Status: aligned · Updated: 2026-09-12

## Intent
When an agent errors, the failing agent must stop first and a more senior agent (or the user) must take over — visibly, in-channel. This feature exists so errors travel up the authority ladder L3→L2→L1→user with strike accounting for loops, instead of a broken agent retrying silently or acting while routing is still being decided.

## Architectural decision
Pause-first, resolve-second: `escalate()` pauses the failing agent row plus its runtime state before any target lookup, so a failing agent can never keep acting while routing is decided `[Observed]`. Loop errors carry extra weight — a typed `loop_detected` escalation plus a fixed 1-of-3 strike with a hardcoded reason, with downstream counting owned elsewhere `[Observed]`. Handoff is a public in-channel act, not a silent reassignment: a live target gets an `[ESCALATION]` system message with an escalation mention, is stepped through working/thinking, then posts a delayed takeover reply and resets to idle; when nobody is eligible the chain falls through to an `[EMERGENCY NOTIFICATION]` user message plus `budget:exceeded` `[Observed]`.

## How it works
`agentGate.escalate` enters `EscalationChain.escalate`. It emits `escalation:created` (typed `loop_detected` only for `LOOP_DETECTED`, else `warning`); loop errors additionally emit `strike:initiated` with fixed strike 1/3. It pauses the agent via `agentRegistry.setStatus` (atomic `agents` + `runtimeStates` write with error info, heartbeat, `agent:status`) plus `agent:paused`. Target resolution maps L3→L2, L2→L1, L1→user (level 0 and below fall through to the user path). When a target level applies, it finds a non-template, non-archived agent at that level that is neither offline nor paused; the first match gets an `[ESCALATION]` system message (with escalation mention) via `messageGate.append` plus `message:new`, is set working/thinking, then a 1.2s-delayed fire-and-forget timer posts its takeover reply (also via `messageGate.append`) and resets it to idle. Otherwise — no target level, no eligible agent — it writes an `[EMERGENCY NOTIFICATION]` user message via `messageGate.append` plus `message:new` and `budget:exceeded`. Live callers are the loop arbiter and the token tracker; resume is manual via update (the route emits `agent:resumed` on paused→non-paused transitions, with no automatic unpause).

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Agents.md> | Owns the chain (`agent-errors.ts`: `AgentError` type, `EscalationChain.escalate`, pause + target resolution + notifications) |
| <../Domain Spec/Messages.md> | Sole owner of the `messages` table; the chain's `[ESCALATION]` / takeover / `[EMERGENCY NOTIFICATION]` rows go through `messageGate.append` |
| <../Domain Spec/Swarm.md> | Consumes loop signals upstream (loop arbiter escalates through this chain; strike counting lives downstream) |

## Current state
Live as documented: every escalation pauses before resolving; loop strikes are fixed at 1/3; offline/paused targets are skipped; the takeover reply is a 1.2s `setTimeout` with no error handling; sweep-adjacent tables are untouched by this path. The chain emits `escalation:created`, `strike:initiated` (loops only), `agent:status`, `agent:paused`, `agent:thinking`, `message:new`, and `budget:exceeded` (user-fallthrough only).

## Alignment notes
`none found` — sampled claims verified: `escalation:created` typing (`agent-errors.ts:46-53`), fixed 1/3 loop strike (`agent-errors.ts:56-65`), pause-before-resolve ordering (`agent-errors.ts:67-70` vs `agent-errors.ts:87-100`), paused-status plus error-info runtime write (`agent-errors.ts:73-85`), L3→L2→L1→user resolution (`agent-errors.ts:89-100`), eligible-target filter skipping offline/paused (`agent-errors.ts:109`), `[ESCALATION]` message plus takeover/idle sequence (`agent-errors.ts:111-165`), and `[EMERGENCY NOTIFICATION]` plus `budget:exceeded` fallthrough (`agent-errors.ts:171-193`). No contradiction between the Agents domain doc escalation parts and cited code on the sampled paths.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Pause-first then resolve stays. Delayed takeover replies have error handling plus stuck-working recovery, not fire-and-forget.
* Strike emission is typed with downstream counting owned. Level-0 target has an explicit contract. Resume is explicit unpause with failed-work context. Authority: Agents standard.
## Open gaps
- The delayed takeover reply is a fire-and-forget `setTimeout` with no error handling — a DB/emit failure inside it is silent and leaves the target `working`.
- `strike:initiated` is emitted with `as any`, hinting the broker's typed contract does not cover it; downstream strike-counting ownership was not traced here.
- Level-0 agents and any level outside 1–3 fall straight to user notification — whether L0 has an intended escalation target is unverified.
- Resume is manual (unpause via update) with no automatic unpause, no checkpointing, and no retry of the failed work — operator flow beyond the route's `agent:resumed` emit is unverified.
