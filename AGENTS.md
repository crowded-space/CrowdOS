# AGENTS.md

## 1. Naming

- `*.ts` → `kebab-case`. Ex: `agent-service.ts`, `agent-gate.ts`.
- `*.tsx` → `PascalCase`, file matches exported component. Ex: `AgentStudioModal.tsx` exports `AgentStudioModal`.
- `type` / `interface` / `enum` names → `camelCase`. Ex: `type agentId = string`.
- `etc` → std naming: variables/functions `camelCase`, classes `PascalCase`, constants `UPPER_SNAKE_CASE`, folders: domains `PascalCase` (`./Agents/`), non-domains `kebab-case`.
- Gate file → `kebab-case` + `-gate.ts`. Ex: `./Agents/agent-gate.ts`.
- Existing `camelCase` files/types frozen. New code must follow this rule. Bulk renames only via codemod, never mixed into feature work.

## 2. Domain Facade

One feature = one domain. If no domain fits, scaffold a new one first (gate first, even if it wraps one function).

```
./[Domain]/
  [domain]-gate.ts   ← ONLY file other domains may import
  ...rest            ← private to this domain
```

Gate is thin facade, ports only:

```ts
// ./Agents/agent-gate.ts
// Depends-on: none
import { createAgent } from './agent-service';
import type { agent } from './agent-types';

export type { agent };
export const agentGate = { create: createAgent };
```

- No logic, fetch, DB, or branching in gate. Wire + re-export only.
- Export only what outsiders use. Gate shape = contract.
- Hard rule: nothing outside `./[Domain]/` imports past `*-gate.ts`.
- Gate-to-gate only. Cycle A↔B = wrong boundary, extract shared domain.
- `Shared/`, `lib/`, `config/` exempt. In-domain tests may import internals; cross-domain tests go through gates.
- Socket/REST handlers call gates, never services directly. Events/tables/queues have one owner domain.

## 3. Docs (Deliberate Comprehensive Minimal Scope)

Domain docs live in `re-docs/[Backend|Frontend|Desktop] Docs/Domain Spec/`:
- Backend/Desktop: v2 gate template (Purpose / Feature Scope / Expect / Flow / Current Implementation / Ports / Relations / Emits-Listens / Owns / Flags / Decisions / User Decision / Failure + Resume / Gaps).
- Frontend (no gates): UI-adapted template — same sections but Props & Store instead of Ports, Relations cover parents/children/store/socket, Owns covers local state/caches.
- Alignment docs (one README per feature/flow) live in `re-docs/[Backend|Frontend|Desktop] Docs/Feature and Flow Spec/`.

- Each root's `_index.md` (domains/areas) and `Feature and Flow Spec/_flow-index.md` (features/flows) are maps only, no duplication.
- Code is truth. Backend doc `Ports` must equal gate exports.

Objective: easier fix (blast radius = folder + doc), traceable API/relations (ports + depends-on), isolation (gate-only), spec sync (code + doc in same task).

## 4. Git (main only, review-gated)

- Never create a branch. Always `main`. No `checkout -b` / `switch -c`.
- If `main` dirty or behind remote → stop, ask user first. No auto pull/rebase/stash/reset.
- No auto-commit, auto-push, amend-after-push, or force-push. Never commit secrets / `.env`.
- Flow: finish → checks → stop → ask user to live review/test → ask `commit?` → commit only on explicit yes → next task only after commit or explicit `continue without commit`.
- If asked to commit, push and pull always use this `git-crow` custom script to switch the appropriate git auth for this project before doing the git action.
## 5. Subagent Model Routing

- Research tasks: `flash`.
- Implementation tasks: `inherit`.

## 6. Docs sync (strict)

- Codebase change ⇒ docs update in the SAME task. No exceptions.
- Gate shape change → its root's `Domain Spec/[Domain].md` (Ports/Relations) + that root's `_index.md` if gates move.
- Behavior/flow change → its root's `Feature and Flow Spec` doc + that root's `_flow-index.md` if links change.
- Drift found later → record in Alignment notes AND fix in the same task. Known drift is never left undocumented.
