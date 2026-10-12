# re-docs index

Map only. Truth lives in gates + their doc. Statuses:
`ok` done · `draft` writing · `migrate` ⚠ doc uses kebab, code rename pending — agents: do not rename code inside feature work, codemod later · `uncovered` ⚠ no gate yet, future work.

| Domain | Gate (code) | Doc | Status |
|---|---|---|---|
| Agents | `agents/agent-gate.ts` | `Agents.md` | draft |
| Approvals | `approvals/approval-gate.ts` | `Approvals.md` | draft |
| Artifacts | `artifacts/artifacts-gate.ts` | `Artifacts.md` | draft |
| Channels | `channels/channel-gate.ts` | `Channels.md` | draft |
| ChannelMounts | `channel-mounts/channel-mount-gate.ts` | `ChannelMounts.md` | draft |
| Capabilities | `capabilities/capabilities-gate.ts` | `Capabilities.md` | draft |
| EventBroker | `event-broker/event-broker-gate.ts` | `EventBroker.md` | draft |
| Events | `events/events-gate.ts` | `Events.md` | draft |
| Memories | `memories/memories-gate.ts` | `Memories.md` | draft |
| Messages | `messages/message-gate.ts` | `Messages.md` | draft |
| Modules | `modules/module-gate.ts` | `Modules.md` | draft |
| Observability | `observability/observability-gate.ts` | `Observability.md` | draft |
| Queue | `queue/queue-gate.ts` | `Queue.md` | draft |
| Runs | `runs/runs-gate.ts` | `Runs.md` | draft |
| State | `state/state-gate.ts` | `State.md` | draft |
| Runtime | `runtime/runtime-gate.ts` | `Runtime.md` | draft |
| Runtime/Context | `runtime/context-gate.ts` | `Runtime/Context.md` | draft |
| SearchProviders | `search-providers/search-provider-gate.ts` | `SearchProviders.md` | draft |
| Skills | `skills/skills-gate.ts` | `Skills.md` | draft |
| Swarm | `swarm/swarm-gate.ts` | `Swarm.md` | draft |
| Threads | `threads/thread-gate.ts` | `Threads.md` | draft |
| Tools | `tools/tools-gate.ts` | `Tools.md` | draft |
| Filesystem | `Filesystem/filesystem-gate.ts` | `Filesystem.md` | draft |
| Workspace | `Workspace/workspace-gate.ts` ⚠ | `Workspace.md` | migrate |
| Auth/Pin | `Shared/auth/pin-gate.ts` ⚠ | `Auth/Pin.md` | migrate |
| Desktop | `packages/desktop/desktopGate.ts` ⚠ | — | uncovered |
| Client | — | — | uncovered |
| Routes | — | — | uncovered |

Rule: gate added/renamed → same task updates this table. ⚠ rows: docs-only kebab for now; code renames via later codemod, never inside feature work.

## Target Contract
> Status: Target. This index is a map only. Truth lives in gates plus their domain docs. Every domain doc carries an Architectural Standard (Target) section; this table tracks doc completeness (draft, migrate, uncovered), never target conformance.
* Gate added or renamed → same task updates this table plus the domain doc standard if the shape changes.
* Target changes → same-task updates to linked feature and flow docs plus their Target Contract sections.
