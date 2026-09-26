import { z } from "zod";

const fewShotExampleSchema = z.object({
  scenario: z.string(),
  thoughtProcess: z.string(),
  actions: z.array(
    z.object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
    })
  ),
  expectedOutcome: z.string(),
});

export const skillPromptLayerSchema = z.object({
  systemPromptAdditions: z.array(z.string()).default([]),
  executionGuidelines: z.array(z.string()).default([]),
  fewShotExamples: z.array(fewShotExampleSchema).optional().default([]),
});

const categorySchema = z.enum(["cognitive", "operational", "swarm", "general"]);
const workflowPatternSchema = z.enum(["react", "plan_execute", "evaluator_optimizer"]);

export const createSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: categorySchema.default("general"),
  icon: z.string().optional().default("⚡"),
  requiredToolIds: z.array(z.string()).default([]),
  optionalToolIds: z.array(z.string()).default([]),
  promptLayer: skillPromptLayerSchema.default({ systemPromptAdditions: [], executionGuidelines: [], fewShotExamples: [] }),
  recommendedModels: z.array(z.string()).default([]),
  workflowPattern: workflowPatternSchema.default("react"),
});

// Defaults-free on purpose: zod's .partial() keeps .default()s (a parsed
// update body then carries every field), which silently resets omitted
// fields in the service merge. Omitted must stay absent here.
export const updateSkillSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  category: categorySchema.optional(),
  icon: z.string().optional(),
  requiredToolIds: z.array(z.string()).optional(),
  optionalToolIds: z.array(z.string()).optional(),
  promptLayer: z
    .object({
      systemPromptAdditions: z.array(z.string()).optional(),
      executionGuidelines: z.array(z.string()).optional(),
      fewShotExamples: z.array(fewShotExampleSchema).optional(),
    })
    .optional(),
  recommendedModels: z.array(z.string()).optional(),
  workflowPattern: workflowPatternSchema.optional(),
});

export const skillParamsSchema = z.object({
  id: z.string().min(1),
});

export type CreateSkillBody = z.infer<typeof createSkillSchema>;
export type UpdateSkillBody = z.infer<typeof updateSkillSchema>;
export type SkillParams = z.infer<typeof skillParamsSchema>;
