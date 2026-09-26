import { agentRegistry, AgentRegistry } from "./agent-service.js";
import { EscalationChain } from "./agent-errors.js";
import { localListAgentRows, localListAgents, localSeedDefaultAgent } from "./agent-local-store.js";
import type { LocalAgentRow } from "./agent-local-store.js";
import type {
  AgentProfile,
  AuthorityLevel,
  AgentStatus,
  MemorySharingPolicy,
  L3Subtype,
  AgentAuthorityPermissions,
  CreateAgentProfileInput,
  UpdateAgentProfileInput,
  AgentRegistryFilters,
} from "./agent-types.js";
import {
  createAgentSchema,
  updateAgentSchema,
  listAgentsQuerySchema,
  agentParamsSchema,
} from "./agent-validators.js";
import type {
  ListAgentsQuery,
  AgentParams,
  CreateAgentBody,
  UpdateAgentBody,
} from "./agent-validators.js";

export { AgentRegistry, agentRegistry, EscalationChain };
// NOTE: AgentRegistry/agentRegistry stay exported for existing callers
// (mention-parser, socket server, module-service). New code must use
// agentGate ports; migrating those callers is a follow-up.
export type {
  AgentProfile,
  AuthorityLevel,
  AgentStatus,
  MemorySharingPolicy,
  L3Subtype,
  AgentAuthorityPermissions,
  CreateAgentProfileInput,
  UpdateAgentProfileInput,
  AgentRegistryFilters,
  LocalAgentRow,
};
export {
  createAgentSchema,
  updateAgentSchema,
  listAgentsQuerySchema,
  agentParamsSchema,
};
export type { ListAgentsQuery, AgentParams, CreateAgentBody, UpdateAgentBody };

export const agentGate = {
  list: (filters?: AgentRegistryFilters, db?: any) => agentRegistry.list(filters, db),
  getById: (id: string, db?: any, workspaceId?: string | null) => agentRegistry.getById(id, db, workspaceId),
  create: (input: CreateAgentProfileInput, db?: any) => agentRegistry.create(input, db),
  update: (id: string, input: UpdateAgentProfileInput, db?: any, workspaceId?: string | null) =>
    agentRegistry.update(id, input, db, workspaceId),
  delete: (id: string, db?: any, workspaceId?: string | null) => agentRegistry.delete(id, db, workspaceId),
  setStatus: (agentId: string, status: AgentStatus, opts?: { broker?: any; db?: any; workspaceId?: string | null; errorInfo?: { code: string; message: string } }) =>
    agentRegistry.setStatus(agentId, status, opts as never),
  touchHeartbeat: (agentIds: string[], db?: any) => agentRegistry.touchHeartbeat(agentIds, db),
  sweepOrphans: (broker: any, opts?: { orphanAfterMs?: number; isLive?: (agentId: string) => boolean }) =>
    agentRegistry.sweepOrphans(broker, opts),
  // File-tier ports: sync/seed/snapshot callers route through the gate
  // instead of importing the local store (AGENTS.md §2 gate-only).
  listLocalAgents: (filters?: AgentRegistryFilters) => localListAgents(filters),
  listLocalAgentRows: (workspaceId?: string | null) => localListAgentRows(workspaceId),
  seedDefaultAgent: (workspaceId?: string | null) => localSeedDefaultAgent(workspaceId),
};
