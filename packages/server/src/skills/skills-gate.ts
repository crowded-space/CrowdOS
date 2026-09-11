import { skillService } from "./skill-service.js";
import type { SkillDefinition, SkillPromptLayer, CreateSkillInput, UpdateSkillInput } from "./skill-types.js";
import {
  createSkillSchema,
  updateSkillSchema,
  skillParamsSchema,
  type CreateSkillBody,
  type UpdateSkillBody,
  type SkillParams,
} from "./skill-validators.js";

export type {
  SkillDefinition,
  SkillPromptLayer,
  CreateSkillInput,
  UpdateSkillInput,
  CreateSkillBody,
  UpdateSkillBody,
  SkillParams,
};

export {
  createSkillSchema,
  updateSkillSchema,
  skillParamsSchema,
};

export const skillsGate = {
  list: (filters?: { category?: string; limit?: number }) => skillService.list(filters),
  getById: (id: string) => skillService.getById(id),
  create: (input: CreateSkillInput) => skillService.create(input),
  update: (id: string, input: UpdateSkillInput) => skillService.update(id, input),
  delete: (id: string) => skillService.delete(id),
  getAgentSkills: (agentId: string) => skillService.getAgentSkills(agentId),
  assignSkill: (agentId: string, skillId: string) => skillService.assignSkill(agentId, skillId),
  removeSkill: (agentId: string, skillId: string) => skillService.removeSkill(agentId, skillId),
  getResolvedToolsForAgent: (agentId: string) => skillService.getResolvedToolsForAgent(agentId),
  invalidateAgentCaches: (agentId?: string) => skillService.invalidateAgentCaches(agentId),
};
