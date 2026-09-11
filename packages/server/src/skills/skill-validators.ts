import { z } from "zod";

export const skillPromptLayerSchema = z.object({
  systemPromptAdditions: z.array(z.string()).default([]),
  executionGuidelines: z.array(z.string()).default([]),
  fewShotExamples: z.array(
    z.object({
      scenario: z.string(),
      thoughtProcess: z.string(),
      actions: z.array(
        z.object({
          tool: z.string(),
          args: z.record(z.string(), z.unknown()),
        })
      ),
      expectedOutcome: z.string(),
    })
  ).optional().default([]),
});

export const createSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().default("general"),
  icon: z.string().optional().default("⚡"),
  requiredToolIds: z.array(z.string()).default([]),
  optionalToolIds: z.array(z.string()).default([]),
  promptLayer: skillPromptLayerSchema.default({ systemPromptAdditions: [], executionGuidelines: [], fewShotExamples: [] }),
  recommendedModels: z.array(z.string()).default([]),
  workflowPattern: z.enum(["react", "plan_execute", "evaluator_optimizer"]).default("react"),
});

export const updateSkillSchema = createSkillSchema.partial();

export const skillParamsSchema = z.object({
  id: z.string().min(1),
});

export type CreateSkillBody = z.infer<typeof createSkillSchema>;
export type UpdateSkillBody = z.infer<typeof updateSkillSchema>;
export type SkillParams = z.infer<typeof skillParamsSchema>;
