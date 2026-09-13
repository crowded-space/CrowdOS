# CrowdOS — Runtime Feature Convergence Matrix

| Feature | FE | BE | Status | Action |
|---|---|---|---|---|
| Agent Lifecycle | Partial | Full | DIVERGED | MERGE |
| Swarm Runtime | UX Only | Missing | FE_ONLY | ADD_BE |
| Runtime Overrides | Partial | Full | PARTIAL | WIRE |
| Capability Modules | Missing | Exists | BE_ONLY | ADD_FE |
| Sandbox Streams | Partial | Partial | INCOMPLETE | CANONICALIZE |
| Parliament Flow | UX | Runtime | DIVERGED | MERGE |
| Workspace Sync | Partial | Partial | PARTIAL | REFACTOR |
| Provider Routing | Hidden | Full | BE_ONLY | ADD_FE |
| Escalation Graph | UX Only | Runtime Exists | PARTIAL | MERGE |

## Definition of Convergence Actions

1. **MERGE:** Blend frontend UX conceptual entities with backend PostgreSQL-backed business logic. Unify event payloads in the EventBroker.
2. **WIRE:** Connect existing backend routes or socket emissions directly to the Zustand state store and active React modules.
3. **ADD_FE:** Build settings forms, sidebar rosters, and modal overlays to reveal backend capabilities to the human operator.
4. **ADD_BE:** Provide backend tables, controllers, and socket hooks for features previously simulated locally.
5. **CANONICALIZE:** Migrate distinct types/schemas on client and server to shared definitions under `@crowdspace/shared`.
6. **REFACTOR:** Standardize real-time synchronization loops using snapshots and targeted patches rather than wholesale list re-fetching.
