export const RuntimeEvents = {
  // Agent Events
  AGENT_SPAWNED: "agent:spawned",
  AGENT_DESPAWNED: "agent:despawned",
  AGENT_PAUSED: "agent:paused",
  AGENT_RESUMED: "agent:resumed",
  AGENT_LIFECYCLE: "agent:lifecycle",

  // Runtime State Events
  RUNTIME_STATE: "runtime:state",
  RUNTIME_SNAPSHOT: "runtime:snapshot",
  RUNTIME_OVERRIDE: "runtime:override",

  // Workspace Events
  WORKSPACE_PATCHED: "workspace:patched",
  WORKSPACE_SNAPSHOT: "workspace:snapshot",

  // Sandbox & VFS Events
  SANDBOX_UPDATED: "sandbox:updated",
  SANDBOX_STREAM: "sandbox:stream",
  SANDBOX_PROCESS: "sandbox:process",

  // Swarm Coordination Events
  SWARM_CREATED: "swarm:created",
  SWARM_UPDATED: "swarm:updated",
  SWARM_TERMINATED: "swarm:terminated",

  // Escalation & Governance Events
  ESCALATION_CREATED: "escalation:created",
  ESCALATION_UPDATED: "escalation:updated",
  ESCALATION_RESOLVED: "escalation:resolved",
} as const;

export type RuntimeEventType = typeof RuntimeEvents[keyof typeof RuntimeEvents];
