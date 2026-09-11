import { z } from "zod";

export const providerEngineSchema = z.enum(["google", "openai", "anthropic", "ollama", "custom"]);

export const modelModuleSchema = z.object({
  label: z.string().min(1),
  provider: providerEngineSchema,
  modelName: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  endpointUrl: z.string().nullable().optional(),
  temperature: z.number(),
  topP: z.number(),
  maxOutputTokens: z.number().int(),
  stopSequences: z.array(z.string()).optional(),
  maxRecentMessages: z.number().int(),
  enableCompression: z.boolean().optional(),
  compressionThreshold: z.number().int(),
  costPer1k: z.number().nullable().optional()
});
export const updateModelModuleSchema = modelModuleSchema.partial();

export const instructionModuleSchema = z.object({
  label: z.string().min(1),
  base: z.array(z.string()).optional(),
  runtimePatchable: z.boolean().optional()
});
export const updateInstructionModuleSchema = instructionModuleSchema.partial();

export const toolkitModuleSchema = z.object({
  label: z.string().min(1),
  tools: z.array(z.string()).optional()
});
export const updateToolkitModuleSchema = toolkitModuleSchema.partial();

export const constraintsModuleSchema = z.object({
  label: z.string().min(1),
  rules: z.array(z.string()).optional(),
  disallowedActions: z.array(z.string()).optional()
});
export const updateConstraintsModuleSchema = constraintsModuleSchema.partial();

export const capabilitiesModuleSchema = z.object({
  label: z.string().min(1),
  skills: z.array(z.string()).optional(),
  functionSchemas: z.array(z.record(z.string(), z.any())).optional()
});
export const updateCapabilitiesModuleSchema = capabilitiesModuleSchema.partial();

export const paramIdSchema = z.object({
  id: z.string().min(1)
});

export type CreateModelModuleBody = z.infer<typeof modelModuleSchema>;
export type UpdateModelModuleBody = z.infer<typeof updateModelModuleSchema>;
export type CreateInstructionModuleBody = z.infer<typeof instructionModuleSchema>;
export type UpdateInstructionModuleBody = z.infer<typeof updateInstructionModuleSchema>;
export type CreateToolkitModuleBody = z.infer<typeof toolkitModuleSchema>;
export type UpdateToolkitModuleBody = z.infer<typeof updateToolkitModuleSchema>;
export type CreateConstraintsModuleBody = z.infer<typeof constraintsModuleSchema>;
export type UpdateConstraintsModuleBody = z.infer<typeof updateConstraintsModuleSchema>;
export type CreateCapabilitiesModuleBody = z.infer<typeof capabilitiesModuleSchema>;
export type UpdateCapabilitiesModuleBody = z.infer<typeof updateCapabilitiesModuleSchema>;
export type ModuleParams = z.infer<typeof paramIdSchema>;
