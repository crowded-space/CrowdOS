import { agentRegistry, AgentRegistry } from "./agent-service.js";
import { AgentSpawnManager } from "./agent-spawn-manager.js";
import { EscalationChain, AgentError } from "./agent-errors.js";
import { startSpawnRetentionSweeper } from "./spawn-retention-sweeper.js";
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

export { AgentRegistry, agentRegistry, AgentSpawnManager, EscalationChain, AgentError };
export { startSpawnRetentionSweeper };
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
  getById: (id: string, db?: any) => agentRegistry.getById(id, db),
  create: (input: CreateAgentProfileInput, db?: any) => agentRegistry.create(input, db),
  update: (id: string, input: UpdateAgentProfileInput, db?: any) => agentRegistry.update(id, input, db),
  delete: (id: string, db?: any) => agentRegistry.delete(id, db),
  dispatch: AgentSpawnManager.dispatchAgent,
  escalate: EscalationChain.escalate,
};
