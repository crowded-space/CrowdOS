import { skillService } from "./skill-service.js";
import type { CreateSkillInput, UpdateSkillInput } from "./skill-types.js";
import { listSummaries as listMarkdownSummaries, getSkill as getMarkdownSkill, composeSkills } from "./markdown-skill-store.js";
import {
  createSkillSchema,
  updateSkillSchema,
  skillParamsSchema,
  type CreateSkillBody,
  type UpdateSkillBody,
  type SkillParams,
} from "./skill-validators.js";

export type {
  CreateSkillBody,
  UpdateSkillBody,
  SkillParams,
};

export {
  createSkillSchema,
  updateSkillSchema,
  skillParamsSchema,
};

// §20 Markdown skills are the local-first half of the Skills system. They are
// exposed through this gate (the domain's only import surface) so callers
// get DB skills and Markdown skills from one place.
export { listSummaries as listMarkdownSummaries, getSkill as getMarkdownSkill } from "./markdown-skill-store.js";

export const skillsGate = {
  list: (filters?: { category?: string; limit?: number }) => skillService.list(filters),
  getById: (id: string) => skillService.getById(id),
  create: (input: CreateSkillInput) => skillService.create(input),
  update: (id: string, input: UpdateSkillInput) => skillService.update(id, input),
  delete: (id: string) => skillService.delete(id),
  getAgentSkills: (agentId: string) => skillService.getAgentSkills(agentId),
  assignSkill: (agentId: string, skillId: string) => skillService.assignSkill(agentId, skillId),
  removeSkill: (agentId: string, skillId: string) => skillService.removeSkill(agentId, skillId),
  replaceAgentSkills: (agentId: string, skillIds: string[]) => skillService.replaceAgentSkills(agentId, skillIds),
  getResolvedToolsForAgent: (agentId: string) => skillService.getResolvedToolsForAgent(agentId),
  invalidateAgentCaches: (agentId?: string) => skillService.invalidateAgentCaches(agentId),
  // §20 Markdown skills: discovery-first, lazily expanded (§17: Markdown on disk).
  listMarkdownSummaries,
  getMarkdownSkill,
  composeMarkdownSkills: composeSkills,
};
