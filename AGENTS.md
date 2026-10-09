# AGENTS.md

Rules for any agent working in this repo.

Rules marked **[checked]** are enforced by a script. Everything else relies on you following it. If a check fails, the check is right until proven otherwise: never weaken, skip, or delete a check or test to get green.

## 0. Orientation

`CrowdOS.md` is the product spec and is large. Do not read it whole. Read only the sections for your task, plus the Domain Spec for the domain you touch (`re-docs/[Backend|Frontend|Desktop] Docs/Domain Spec/[Domain].md`).

| Touching | Read in CrowdOS.md |
|---|---|
| Mentions, active agent, routing | §7–§10 |
| Runtime selection, pin, Auto, Interpreter, Router | §6, §24, §25 |
| Runtimes, RuntimeResult, conformance | §22, §23, §26 |
| Swarm, workers, L0–L3 | §22, §31, §34 |
| Context, history, lock_in / lock_out | §11, §12, §27, §29 |
| State, events | §28 |
| Memory, isolation | §13, §30 |
| Mounts, persistence | §16, §17 |
| Implemented vs planned | §34 |

Code is truth for current behavior. The spec is truth for intent. If they disagree, do not silently pick one: record it as drift (§6).

## 1. Work protocol

Follow in order, every task.

1. **Scope.** Restate the task in 1–2 sentences. Name the domain(s) involved and the files you expect to change. If it spans more than one domain, say so before editing.
2. **Reproduce.** For a bug, first write a failing test (or capture the failing command output) that shows it. If you cannot reproduce it, say so. Do not guess-fix.
3. **Root cause.** State the cause in one sentence with `file:line` evidence. Fix it in the domain that owns the behavior, not at the call site where the symptom appeared. Do not add try/catch, null guards, flags, special cases, or fallbacks to silence a symptom.
4. **Smallest change.** Change only what the task needs. No drive-by refactors, renames, reformatting, or dependency changes. If you notice something else, list it in your report. Do not fix it.
5. **Blast radius.** Before finishing, search for every consumer of what you changed: gate exports, event names, socket events, DB columns/tables, types in `@crowdspace/shared`, config flags. Confirm each still works.
6. **Regression test.** Every bug fix adds a test that fails without the fix. Test through the gate. For runtime behavior, extend the conformance suite.
7. **Verify.** Run the checks in §2 and report real output. "Should work" is not a result.

### Stop rules (anti-circling)

Stop and report instead of continuing when:

- The same check still fails after 2 attempts with the same approach. Do not try a third variation. Report what you tried, what you observed, your current hypothesis, and what you need.
- You are about to undo or redo your own earlier edit in this task. You are oscillating. Re-read the failing output and restate the cause first.
- The fix needs something you were not asked for: a new abstraction, a gate shape change, a new dependency, or touching an invariant in §5.
- A test looks wrong. Do not edit it to pass. Explain why it is wrong, separately from your fix.

Never "fix" by disabling a feature flag, a check, a test, or a rollback report.

### Size limits

- Unless the change is mechanical, keep it under about 800 changed lines, and under about 500 for complex logic. If the task needs more, stop after the plan and propose stages: the smallest coherent stage that can land and be verified on its own.
- Prefer a new file over growing an existing one. Aim for files under ~500 lines excluding tests. Past ~800 lines, add new functionality in a new file unless there is a documented reason.
- Resist growing the hot spots: `<FILL IN: the 3-5 central orchestration files, e.g. the router, the swarm runtime, the main socket handler>`. New concepts get their own module behind the owning gate.
- When you extract code, move its tests and its Domain Spec notes with it.

## 2. Definition of done

Use the repo's scripts only. Never call the underlying tools directly (raw `tsc`, `vitest`, `eslint`), so every run uses the same defaults. Replace the placeholders below with your real scripts.

Run in this order:

1. The checks for the package you changed.
2. If you touched `packages/shared`, a gate shape, or the runtime contract, the full suite before you report done.
3. Ask first before anything slow or heavy (full e2e, docker, the queue profile).

```bash
npm run typecheck     # CONFIRM script name
npm run lint          # CONFIRM: should include the boundary + naming rules below
npm test              # CONFIRM: must include the runtime contract conformance suite
npm run check:docs    # TO BUILD: gate exports == Domain Spec Ports
```

If a check named here does not exist, say "not available". Never report it as passing.

Done also means: the diff touches only what §1.1 predicted, docs are synced (§6), and the report in §9 is written.

### Tests

- Test behavior through the public surface: the domain gate, or the socket/REST API for transport code. Do not reach into another domain's internals.
- A change to agent or runtime logic must add an integration test. List the behaviors it covers in your report.
- Fake the provider boundary (the `google` / `openai` / `anthropic` / `ollama` / `custom` adapters), never the Router or a runtime.
- Assert on whole objects, not field by field.
- Do not add tests for statically defined values, or negative tests for logic you removed.

## 3. Domain Facade

One feature = one domain. If no domain fits, scaffold a new one first (gate first, even if it wraps one function).

```
./[Domain]/
  [domain]-gate.ts   ← ONLY file other domains may import
  ...rest            ← private to this domain
```

Gate is a thin facade, ports only:

```ts
// ./Agents/agent-gate.ts
// Depends-on: none
import { createAgent } from './agent-service';
import type { agent } from './agent-types';

export type { agent };
export const agentGate = { create: createAgent };
```

- No logic, fetch, DB, or branching in a gate. Wire + re-export only.
- Export only what outsiders use. Gate shape = contract.
- **[checked]** Nothing outside `./[Domain]/` imports past `*-gate.ts`.
- Gate-to-gate only. Cycle A↔B = wrong boundary, extract a shared domain.
- `Shared/`, `lib/`, `config/` are exempt. In-domain tests may import internals; cross-domain tests go through gates.
- Socket/REST handlers call gates, never services directly. Events/tables/queues have one owner domain.
- A bug in domain X is fixed in X, not patched in its caller.
- Do not add a gate export just to make your change compile. If the boundary feels wrong, stop and ask.

## 4. Naming

- `*.ts` → `kebab-case`. Ex: `agent-service.ts`, `agent-gate.ts`.
- `*.tsx` → `PascalCase`, file matches the exported component. Ex: `AgentStudioModal.tsx` exports `AgentStudioModal`.
- `type` / `interface` / `enum` names → `camelCase`. Ex: `type agentId = string`. This is intentional. TypeScript convention is PascalCase, so do not "correct" it.
- Everything else is standard: variables/functions `camelCase`, classes `PascalCase`, constants `UPPER_SNAKE_CASE`, folders: domains `PascalCase` (`./Agents/`), non-domains `kebab-case`.
- Gate file → `kebab-case` + `-gate.ts`. Ex: `./Agents/agent-gate.ts`.
- Existing `camelCase` files/types are frozen. New code follows this section. Bulk renames only via codemod, never mixed into feature work.

## 5. Load-bearing invariants

These are the things a "fix" quietly breaks. If your change touches one, say so in the report and confirm it still holds. If your fix would violate one, **stop and ask**. Do not work around it. If an invariant has no test, add one before changing the code.

1. **One state writer.** State transitions go through the sole mutator via `stateGate`. Runtimes never return state mutations. There is deliberately no `state_updates[]` on `RuntimeResult`. (§26, §28)
2. **One runtime contract.** All five runtimes return the same `RuntimeResult` and share tool authorization, capability deferral, cancellation, and usage accounting. Never special-case one runtime. The conformance suite stays green. (§23, §26)
3. **Authority comes from level, never from name or label.** The Router mapping must not invert: L0–L1 → Research/Agentic/Conversational, L2 → Swarm, L3 → narrow execution. (§25, §31)
4. **L3 workers are stateless.** No private memory, and `remember` is blocked at the tool executor. A worker is never invented: no eligible L3 means the task fails with a stated reason, never a silent re-run by the orchestrator. Failure text is never counted as success. (§31, §34)
5. **Swarm usage is fully accounted.** Workers, the planning call, and the verifier call all count toward budget. Never zero or drop usage. (§27, §34)
6. **Multiple mention is serial, in shared context, and is not a swarm.** (§10)
7. **Conspiracy / Murder are L0-activated only.** Never reachable by mention, `Auto`, or a lower tier. (§31)
8. **Runtime pin.** `channel_settings.pinned_runtime` is authoritative in both directions and scoped to its own channel. The client translates composer vocabulary to runtime names before writing (`chat` → `conversational`). The Router treats a pin as a preference; tier rules and rollback flags still apply. (§6, §34)
9. **Rollbacks are reported, never hidden.** `RESEARCH_V1` / `SWARM_V1` default to `false`; Research and Swarm then roll back to Agentic and report `rolledBackFrom`. Do not change defaults or swallow the report. Routing decisions stay logged with runtime, reason, and rollback. (§34)
10. **Workspace is the isolation boundary.** Same-named agents in different workspaces share nothing: memory, history, config, mounts. Every query touching agents, channels, history, or memory is workspace-scoped. History belongs to the channel; memory belongs to the agent. Never leak one into the other. (§1, §13, §30)
11. **Mounts.** Inheritance is Workspace → Category → Channel override, and an override **replaces**, never merges. (§16)
12. **Local-first.** The local filesystem is the source of truth. Redis and pgvector stay optional, and `QUEUE_MODE=inline` must keep working. (§17, §18)
13. **Implemented vs planned.** Do not build Planned/Pending items (§34), Nitehunter, Conspiracy, or Murder unless the task says so. Changes to `@crowdspace/pi-core` (the forked coding engine) are deliberate: ask first.

### Breaking-change surfaces

Treat these as public contracts, even though CrowdOS is one app. Changing one needs a stated reason in the report and a safe path: add the new shape alongside the old one, or migrate. Never rename or reshape in place.

- Socket events and REST routes (the client and desktop shell depend on them)
- Types exported from `@crowdspace/shared`
- Database schema and migrations (Drizzle)
- On-disk state under `sandbox/` (JSON state, Markdown Skills/Instructions): existing workspaces must still load after your change
- Env vars and feature flags (`RESEARCH_V1`, `SWARM_V1`, `QUEUE_MODE`, ...)
- Server-authoritative rows such as `channel_settings`

## 6. Docs sync

- Code change ⇒ docs update in the SAME task.
- Gate shape change → its root's `Domain Spec/[Domain].md` (Ports/Relations) + that root's `_index.md` if gates move.
- Behavior/flow change → its root's `Feature and Flow Spec` doc + that root's `_flow-index.md` if links change.
- Drift found later → record in Alignment notes AND fix in the same task. Known drift is never left undocumented.
- Update only the docs your change actually affects, and list them in the report.
- Reference code by symbol name in docs, don't paste code. Pasted code is what drifts.
- Prefer generated over hand-written. Ports tables, schemas, and indexes that can be derived from code should come from a script and be verified in CI, not maintained by hand. If you catch yourself syncing the same fact in two places by hand, say so in the report.
- Do not add new doc types or folders beyond the Domain Spec / Feature and Flow Spec set.
- **[checked once `check:docs` exists]** Backend doc `Ports` must equal gate exports.
- Domain doc templates: Backend/Desktop use the v2 gate template. Frontend (no gates) uses the UI-adapted template with Props & Store instead of Ports. Alignment docs live in `Feature and Flow Spec/`. `_index.md` and `_flow-index.md` are maps only, no duplication.

## 7. Git (main only, review-gated)

- Never create a branch. Always `main`. No `checkout -b` / `switch -c`.
- If `main` is dirty or behind remote → stop, ask the user first. No auto pull/rebase/stash/reset.
- No auto-commit, auto-push, amend-after-push, or force-push. Never commit secrets / `.env`.
- Flow: finish → checks → stop → ask the user to live review/test → ask `commit?` → commit only on explicit yes → next task only after commit or explicit `continue without commit`.
- One logical change per commit. The message says why, not just what.
- When asked to commit, push, or pull, always use the `git-crow` custom script first to switch the git auth for this project.

## 8. Subagents

- Research tasks: `flash`. Return evidence (`file:line`, command output), not conclusions or proposed fixes.
- Implementation tasks: `inherit`.
- Never run two implementers on overlapping files at the same time.

## 9. Final report

End every task with exactly this, then ask `commit?`:

```
Cause:        one sentence (bugs) or goal (features)
Changed:      files, grouped by domain
Tests added:  names, and what each would catch
Checks:       command → pass/fail (real output for failures)
Blast radius: consumers you checked
Invariants:   any from §5 touched, and how you confirmed they hold
Docs updated: files
Not done:     things noticed but out of scope; anything you could not verify
```
