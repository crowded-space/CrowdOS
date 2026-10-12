# Escalation flow
> Type: Flow · Status: aligned · Updated: 2026-09-12

## Intent
An agent that errors must stop first and a more senior agent (or the user) must take over — visibly, in-channel. This flow exists so a failure travels the authority ladder L3→L2→L1→user as a timed sequence (pause → resolve → notify → take over) instead of a broken agent retrying silently or acting while routing is still decided.

## Architectural decision
Pause-first, resolve-second: `escalate()` pauses the failing agent row plus its runtime state before any target lookup, so a failing agent can never keep acting while routing is decided `[Observed]` (`agent-errors.ts:67-70` vs `agent-errors.ts:87-100`). Handoff is a public in-channel act, not a silent reassignment: a live target gets an `[ESCALATION]` system message, is stepped through working/thinking, then posts a delayed takeover reply and resets to idle — and when nobody is eligible the chain falls through to an `[EMERGENCY NOTIFICATION]` user message plus `budget:exceeded` `[Observed]`. Loop errors carry extra weight (typed `loop_detected` escalation plus a fixed 1-of-3 strike) with counting owned downstream `[Observed]`.

## How it works
1. A failure reaches `agentGate.escalate` → `EscalationChain.escalate` from a live caller (the loop arbiter or the token tracker).
2. The chain emits `escalation:created` — typed `loop_detected` only for `LOOP_DETECTED`, else `warning` (`agent-errors.ts:46-53`); loop errors additionally emit `strike:initiated` with fixed strike 1/3 (`agent-errors.ts:56-65`).
3. The failing agent is paused via `agentRegistry.setStatus` (atomic `agents` + `runtimeStates` write with error info, heartbeat, and `agent:status`) plus `agent:paused` (`agent-errors.ts:35-70`, `agent-service.ts:250-273`).
4. Target resolution maps L3→L2, L2→L1, L1→user; level 0 and below fall through to the user path (`agent-errors.ts:89-100`).
5. The chain picks the first non-template, non-archived agent at the target level that is neither offline nor paused (`agent-errors.ts:109`).
6. On a live target it writes an `[ESCALATION]` system message with an escalation mention via `messageGate.append` plus `message:new` (`agent-errors.ts:100-135`), sets the target working/thinking via `agentGate.setStatus` (`agent-errors.ts:136-138`), then a 1.2s fire-and-forget timer posts its takeover reply (also via `messageGate.append`) and resets it to idle (`agent-errors.ts:140-165`).
7. On no target level or no eligible agent it writes an `[EMERGENCY NOTIFICATION]` user message via `messageGate.append` plus `message:new` and `budget:exceeded` (`agent-errors.ts:170-193`).
8. Resume is manual: unpause via update (the route emits `agent:resumed` on paused→non-paused transitions); nothing auto-unpauses and the failed work is not retried.

## Components involved
| Domain spec | Role |
| ---- | ---- |
| <../Domain Spec/Agents.md> | Owns the chain (`agent-errors.ts`: `AgentError` type, `EscalationChain.escalate`, pause + target resolution + notifications) |
| <../Domain Spec/Messages.md> | Sole owner of the `messages` table; the chain's `[ESCALATION]` / takeover / `[EMERGENCY NOTIFICATION]` rows go through `messageGate.append` |
| <../Domain Spec/Swarm.md> | Consumes loop signals upstream (the loop arbiter escalates through this chain; strike counting lives downstream) |
| <./Escalation chain.md> | Owns the contracts (event typings, strike shape, target-eligibility rules, fallthrough semantics) — see that doc, not duplicated here |

## Current state
Live as documented: every escalation pauses before resolving; loop strikes are fixed at 1/3; offline/paused targets are skipped; the takeover reply is a 1.2s `setTimeout` with no error handling; resume is manual with no checkpointing and no retry of the failed work. Emits: `escalation:created`, `strike:initiated` (loops only), `agent:status`, `agent:paused`, `agent:thinking`, `message:new`, `budget:exceeded` (user-fallthrough only).

## Alignment notes
`none found` — sampled claims verified: `escalation:created` typing (`agent-errors.ts:46-53`), fixed 1/3 loop strike (`agent-errors.ts:56-65`), pause-before-resolve ordering (`agent-errors.ts:67-70` vs `agent-errors.ts:87-100`), L3→L2→L1→user resolution (`agent-errors.ts:89-100`), eligible-target filter (`agent-errors.ts:109`), `[ESCALATION]` message plus takeover/idle sequence (`agent-errors.ts:111-165`), and `[EMERGENCY NOTIFICATION]` plus `budget:exceeded` fallthrough (`agent-errors.ts:172-193`). No contradiction between the Agents domain doc escalation parts and cited code on the sampled paths.

## User Decision:

## Target Contract
> Status: Target. Flow-scoped view. Authority stays in linked domain specs.
* Pause-before-resolve ordering stays with L3 to L2 to L1 to user resolution. Eligible-target filter skips offline and paused.
* Delayed reply failures are handled with defined recovery. Level-0 routing plus operator unpause flow are explicit contracts. Authority: Agents standard.
## Open gaps
- The delayed takeover reply is fire-and-forget with no error handling — a DB/emit failure inside it is silent and leaves the target `working`.
- Whether level-0 agents have an intended escalation target (they fall straight to user notification) is unverified.
- Operator flow after escalation (who unpauses, when, with what context on the failed work) is unverified beyond the route's `agent:resumed` emit.
