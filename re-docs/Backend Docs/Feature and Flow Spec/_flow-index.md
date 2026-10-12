# Feature and Flow index

Map only. Truth lives in the doc + its linked domain specs. Statuses mirror each doc's header.
`aligned` verified · `drifting` has recorded drift · `legacy` retired but documented.

## Features

| Doc | Status | Domain specs |
|---|---|---|
| <Agent profiles and roster.md> | aligned | <../Domain Spec/Agents.md> |
| <Module library.md> | aligned | <../Domain Spec/Modules.md> |
| <Skill catalog and tool resolution.md> | aligned | <../Domain Spec/Skills.md> |
| <Capability discovery and expansion flow.md> | aligned | <../Domain Spec/Capabilities.md> <../Domain Spec/Skills.md> |
| <Threads and sub-conversations.md> | aligned | <../Domain Spec/Threads.md> |
| <Workspaces and provisioning.md> | aligned | <../Domain Spec/Workspace.md> |
| <Channels and archive.md> | aligned | <../Domain Spec/Channels.md> |
| <Channel mounts.md> | aligned | <../Domain Spec/ChannelMounts.md> |
| <Runtime router and flavors.md> | aligned | <../Domain Spec/Runtime.md> |
| <Context assembly pipeline.md> | aligned | <../Domain Spec/Context.md> |
| <Provider adapters and streaming.md> | aligned | <../Domain Spec/Runtime.md> |
| <Swarm DAG and delegation.md> | aligned | <../Domain Spec/Swarm.md> |
| <Durable runs and checkpoints.md> | aligned | <../Domain Spec/Runs.md> |
| <Queue delivery and housekeeping.md> | aligned | <../Domain Spec/Queue.md> |
| <Tool registry, Guard and MCP.md> | aligned | <../Domain Spec/Tools.md> |
| <Web search fan-out.md> | aligned | <../Domain Spec/SearchProviders.md> |
| <Legacy L3 dispatch (retired).md> | legacy | <../Domain Spec/Agents.md> |
| <Memory vault and embeddings.md> | aligned | <../Domain Spec/Memories.md> |
| <Artifacts and retention.md> | aligned | <../Domain Spec/Artifacts.md> |
| <Message history.md> | aligned | <../Domain Spec/Messages.md> |
| <Filesystem and metadata mirror.md> | aligned | <../Domain Spec/Filesystem.md> |
| <API-key auth and roles.md> | legacy | <../Domain Spec/Auth.md> |
| <Screenlock PIN.md> | aligned | <../Domain Spec/Pin.md> |
| <Escalation chain.md> | aligned | <../Domain Spec/Agents.md> |
| <Spawn retention and archive.md> | aligned | <../Domain Spec/Agents.md> |
| <Observability spans and cost ledger.md> | drifting | <../Domain Spec/Observability.md> |
| <Typed event bus.md> | aligned | <../Domain Spec/EventBroker.md> <../Domain Spec/Events.md> |
| <Approval lifecycle.md> | drifting | <../Domain Spec/Approvals.md> |

## Flows

| Doc | Status | Domain specs |
|---|---|---|
| <Chat send-message flow.md> | aligned | <../Domain Spec/Runtime.md> <../Domain Spec/Runs.md> <../Domain Spec/Messages.md> |
| <Agentic tool loop.md> | aligned | <../Domain Spec/Runtime.md> <../Domain Spec/Tools.md> <../Domain Spec/Runs.md> |
| <Coding loop.md> | aligned | <../Domain Spec/Runtime.md> <../Domain Spec/Tools.md> <../Domain Spec/Artifacts.md> |
| <Research pipeline.md> | aligned | <../Domain Spec/Runtime.md> <../Domain Spec/SearchProviders.md> <../Domain Spec/Artifacts.md> |
| <Swarm execution flow.md> | aligned | <../Domain Spec/Swarm.md> <../Domain Spec/Runtime.md> <../Domain Spec/Runs.md> |
| <Approval decision flow.md> | aligned | <../Domain Spec/Approvals.md> <../Domain Spec/Tools.md> <../Domain Spec/Runs.md> |
| <Compensation undo flow.md> | aligned | <../Domain Spec/Runs.md> <../Domain Spec/Tools.md> |
| <Escalation flow.md> | aligned | <../Domain Spec/Agents.md> |
| <Thread lifecycle flow.md> | aligned | <../Domain Spec/Threads.md> |
| <Scheduler triggers flow.md> | aligned | <../Domain Spec/Queue.md> <../Domain Spec/Tools.md> |
| <Memory write flow.md> | aligned | <../Domain Spec/Memories.md> |
| <Workspace provisioning flow.md> | aligned | <../Domain Spec/Workspace.md> <../Domain Spec/Filesystem.md> |
| <Mount resolution flow.md> | aligned | <../Domain Spec/ChannelMounts.md> <../Domain Spec/Channels.md> |
| <Retention sweeps flow.md> | aligned | <../Domain Spec/Agents.md> <../Domain Spec/Artifacts.md> <../Domain Spec/Memories.md> <../Domain Spec/Approvals.md> <../Domain Spec/Runs.md> |
| <Cost ledger flow.md> | drifting | <../Domain Spec/Observability.md> |
| <Recovery and resume.md> | aligned | <../Domain Spec/Runs.md> <../Domain Spec/Queue.md> <../Domain Spec/Runtime.md> <../Domain Spec/Approvals.md> |

## Cross-links (feature ↔ flow)

- Approval lifecycle ↔ Approval decision flow
- Durable runs and checkpoints ↔ Recovery and resume, Compensation undo flow
- Swarm DAG and delegation ↔ Swarm execution flow
- Escalation chain ↔ Escalation flow
- Threads and sub-conversations ↔ Thread lifecycle flow
- Workspaces and provisioning ↔ Workspace provisioning flow
- Channel mounts ↔ Mount resolution flow
- Memory vault and embeddings ↔ Memory write flow
- Artifacts and retention + Spawn retention and archive ↔ Retention sweeps flow
- Observability spans and cost ledger ↔ Cost ledger flow
- Queue delivery and housekeeping ↔ Scheduler triggers flow, Recovery and resume
- Runtime router and flavors ↔ Chat send-message flow, Agentic tool loop, Coding loop, Research pipeline
- Typed event bus ↔ Reconnect digest flow (the §29 log is the catch-up source that flow replays from)
- Capability discovery and expansion flow ↔ Skill catalog and tool resolution, Context assembly pipeline, Tool registry Guard and MCP

Rule: new feature/flow doc → same task adds its row here + cross-links. Behavior change → update the doc AND this index if links change.

## Target Contract
> Status: Target. This index is a map only. Truth lives in the doc plus its linked domain specs. Every feature and flow doc carries a Target Contract section that is flow-scoped; authority stays in the linked domain specs and is never duplicated here.
* New feature or flow doc → same task adds its row here plus cross-links plus a Target Contract in the doc.
* aligned means current-state verified against cited code. drifting means recorded drift versus code, with Target Contract stating the required end state. legacy means retired but documented.
