import { agentRegistry, AgentRegistry } from "./agentService";
import { AgentSpawnManager } from "./agentSpawnManager";
import { EscalationChain, AgentError } from "./agentErrors";
import { startSpawnRetentionSweeper } from "./spawnRetentionSweeper";
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
} from "./agentTypes";
import {
  createAgentSchema,
  updateAgentSchema,
  listAgentsQuerySchema,
  agentParamsSchema,
} from "./agentValidators";
import type {
  ListAgentsQuery,
  AgentParams,
  CreateAgentBody,
  UpdateAgentBody,
} from "./agentValidators";

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
  list: (filters?: AgentRegistryFilters) => agentRegistry.list(filters),
  getById: (id: string) => agentRegistry.getById(id),
  create: (input: CreateAgentProfileInput) => agentRegistry.create(input),
  update: (id: string, input: UpdateAgentProfileInput) => agentRegistry.update(id, input),
  delete: (id: string) => agentRegistry.delete(id),
  dispatch: AgentSpawnManager.dispatchAgent,
  escalate: EscalationChain.escalate,
};
