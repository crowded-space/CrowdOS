# Domain Facade Standard

Every feature domain exposes exactly one public entry point — its **Gate**. Everything else inside the domain's folder is private implementation. This keeps domains isolated: a change inside one domain can't quietly ripple into another, and when something breaks, the blast radius stops at the folder boundary.

## Structure

```
./[Domain]/
  [domain]Gate.ts        ← the ONLY file other domains may import from
  ...everything else     ← private to this domain
```

Example:

```
./Agents/
  agentGate.ts            ← public facade
  agentService.ts         ← internal logic
  agentRepository.ts      ← internal data access
  agentTypes.ts           ← internal types
  agentValidators.ts      ← internal helpers
```

**Naming:** the `[Domain]` folder is PascalCase; the gate file is `camelCase` + `Gate.ts`, singularized to the domain's root noun.

- `./Agents/agentGate.ts`
- `./Billing/billingGate.ts`
- `./Notifications/notificationGate.ts`

## What goes in the gate

The gate exposes only the domain's **ports** — the small set of functions and types the rest of the app is allowed to depend on. It's a thin facade, not a place for business logic.

```ts
// ./Agents/agentGate.ts
import { createAgent, getAgentById, deactivateAgent } from './agentService';
import type { Agent, AgentId, CreateAgentInput } from './agentTypes';

export type { Agent, AgentId, CreateAgentInput };

export const agentGate = {
  create: createAgent,
  getById: getAgentById,
  deactivate: deactivateAgent,
};
```

- Wire internal functions into named ports and export them — don't write new logic directly in the gate.
- No fetch calls, no DB access, no branching logic in the gate file itself; that lives in the internals it wraps.
- Only export what something outside the domain genuinely needs. If nothing else uses it, it doesn't belong in the gate.

## Everything else

Internal files import freely from each other within the same domain folder. Split them however fits the domain — service/repository/validator, or something else entirely. That's the domain's business, not the rest of the app's.

## The one hard rule

**Nothing outside `./[Domain]/` may import from any file in that folder except `[domain]Gate.ts`.**

```ts
// ❌ Never — reaching past the gate into internals
import { createAgent } from '../Agents/agentService';

// ✅ Always — go through the gate
import { agentGate } from '../Agents/agentGate';
await agentGate.create(input);
```

This includes domain-to-domain calls. If `Chat` needs agent data, `chatGate.ts` imports `agentGate` — never `agentService` or `agentRepository` directly.

## When writing or editing code

- Scaffold a new domain's gate file first, even if it only wraps one function to start.
- Before importing from another `./[Domain]/` folder, check the path ends in `Gate.ts`. If it doesn't, go through the gate instead — even "just this once."
- Before restructuring a domain's internals (renaming, splitting, moving functions between files), confirm the gate's exported shape is unchanged. If it is, nothing outside the domain needs to know the refactor happened.
- If Domain A's gate needs Domain B's gate, and B's gate needs A's gate back, the boundary is drawn wrong — pull the shared piece into its own domain instead of letting two gates depend on each other.
- Shared, non-domain code (`./Shared/`, `./lib/`, `./config/`) is exempt — any domain can import it directly.
- Tests inside a domain's own folder may import internals directly. Tests exercising cross-domain behavior go through gates like any other consumer.

## Why this matters

The gate is the only contract the rest of the app relies on. As long as its exported shape stays stable, everything inside the folder can change, break, and get fixed without anyone outside noticing. When something does break, the search for "what could be involved" is scoped to one folder plus the gates it calls — not a grep across the whole codebase.

## Enforce it with lint

This rule is easy to violate by accident once a codebase grows. `eslint-plugin-boundaries`, or a per-domain `no-restricted-imports` rule, can turn "nothing outside the domain imports past the gate" into a build failure instead of a review catch. Worth adding once there are more than a couple of domains — check the plugin's current docs for exact config, since the API has shifted across versions.

## Subagent Model Routing

When spawning subagents:
- **Research tasks**: Use `flash`.
- **Implementation tasks**: Use `inherit`.

