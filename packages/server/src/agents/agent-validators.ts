import { z } from "zod";

const authorityLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const l3SubtypeSchema = z.enum(["worker", "supervisor"]);
const memorySharingPolicySchema = z.enum(["none", "horizontal", "vertical", "full"]);
const agentStatusSchema = z.enum(["idle", "working", "paused", "offline"]);

const permissionsSchema = z
  .object({
    spawnAgents: z.boolean().optional(),
    patchRuntime: z.boolean().optional(),
    accessAllChannels: z.boolean().optional(),
  })
  .optional();

// Query-string booleans arrive as strings; z.coerce.boolean() would map
// Boolean("false") === true. Only "true"/"1" mean true; anything else that
// is not a boolean literal drops the filter instead of flipping it.
const queryBooleanSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return undefined;
  },
  z.boolean(),
);

export const createAgentSchema = z.object({
  workspaceId: z.string().min(1).nullable().optional(),
  name: z.string().min(1),
  title: z.string().min(1),
  species: z.string().min(1).optional(),
  avatar: z.string().min(1).optional(),
  authorityLevel: authorityLevelSchema,
  l3Subtype: l3SubtypeSchema.optional(),
  modelModuleId: z.string().min(1).nullable().optional(),
  instructionModuleId: z.string().min(1),
  toolkitModuleId: z.string().min(1).optional(),
  constraintsModuleId: z.string().min(1).optional(),
  capabilitiesModuleId: z.string().min(1).optional(),
  memorySharingPolicy: memorySharingPolicySchema,
  isOmniscient: z.boolean().optional(),
  fallbackAgentId: z.string().min(1).optional(),
  categoryPermissions: z.array(z.string().min(1)).optional(),
  permissions: permissionsSchema,
  status: agentStatusSchema.optional(),
  isTemplate: z.boolean().optional(),
  contextTokenCap: z.number().int().min(1).nullable().optional(),
});

export const updateAgentSchema = z.object({
  workspaceId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  species: z.string().min(1).nullable().optional(),
  avatar: z.string().min(1).nullable().optional(),
  authorityLevel: authorityLevelSchema.optional(),
  l3Subtype: l3SubtypeSchema.nullable().optional(),
  modelModuleId: z.string().min(1).nullable().optional(),
  instructionModuleId: z.string().min(1).optional(),
  toolkitModuleId: z.string().min(1).nullable().optional(),
  constraintsModuleId: z.string().min(1).nullable().optional(),
  capabilitiesModuleId: z.string().min(1).nullable().optional(),
  memorySharingPolicy: memorySharingPolicySchema.optional(),
  isOmniscient: z.boolean().optional(),
  fallbackAgentId: z.string().min(1).nullable().optional(),
  categoryPermissions: z.array(z.string().min(1)).optional(),
  permissions: permissionsSchema,
  status: agentStatusSchema.optional(),
  isTemplate: z.boolean().optional(),
  contextTokenCap: z.number().int().min(1).nullable().optional(),
});

export const listAgentsQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  authorityLevel: z.coerce.number().int().min(0).max(3).optional(),
  status: agentStatusSchema.optional(),
  isTemplate: queryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const agentParamsSchema = z.object({
  id: z.string().min(1),
});

export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
export type AgentParams = z.infer<typeof agentParamsSchema>;
export type CreateAgentBody = z.infer<typeof createAgentSchema>;
export type UpdateAgentBody = z.infer<typeof updateAgentSchema>;
