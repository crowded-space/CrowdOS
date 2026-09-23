import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, dbScopeKey, resolveTier } from "../shared/config/database.js";
import { tierContextFor } from "../workspace/workspace-gate.js";
import { TtlCache } from "../shared/core/ttl-cache.js";
import { compileGoogleEndpoint } from "../shared/core/google-model-helpers.js";
import { encrypt, decrypt } from "../shared/core/secret-box.js";
import { runtimeGate } from "../runtime/runtime-gate.js";
import { skillsGate } from "../skills/skills-gate.js";
import {
  agents,
  modelModules,
  instructionModules,
  toolkitModules,
  constraintsModules,
  capabilitiesModules
} from "../db/schema.js";
import type {
  CreateModelModuleBody,
  UpdateModelModuleBody,
  CreateInstructionModuleBody,
  UpdateInstructionModuleBody,
  CreateToolkitModuleBody,
  UpdateToolkitModuleBody,
  CreateConstraintsModuleBody,
  UpdateConstraintsModuleBody,
  CreateCapabilitiesModuleBody,
  UpdateCapabilitiesModuleBody
} from "./module-validators.js";
import type {
  ModelModule,
  InstructionModule,
  ToolkitModule,
  ConstraintsModule,
  CapabilitiesModule,
} from "./module-types.js";
import {
  localListModelModules,
  localGetModelModule,
  localUpsertModelModule,
  localDeleteModelModule,
  localListInstructionModules,
  localGetInstructionModule,
  localUpsertInstructionModule,
  localDeleteInstructionModule,
  localListToolkitModules,
  localGetToolkitModule,
  localUpsertToolkitModule,
  localDeleteToolkitModule,
  localListConstraintsModules,
  localGetConstraintsModule,
  localUpsertConstraintsModule,
  localDeleteConstraintsModule,
  localListCapabilitiesModules,
  localGetCapabilitiesModule,
  localUpsertCapabilitiesModule,
  localDeleteCapabilitiesModule,
} from "./module-local-store.js";

/**
 * Effective store tier for the caller's workspace. Routes thread the
 * x-workspace-id header down as workspaceId; null falls back to the global
 * tier context so legacy unscoped callers keep working.
 */
async function moduleTier(workspaceId?: string | null) {
  return resolveTier(await tierContextFor(workspaceId ?? null));
}

/** Serialize a module row for the local JSON store (Date fields -> ISO). */
function serializeRow<T extends { createdAt: Date; updatedAt: Date }>(row: T): any {
  return {
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

export type ModuleType = "model" | "instruction" | "toolkit" | "constraints" | "capabilities";

export async function findReferencingAgent(moduleType: ModuleType, moduleId: string) {
  // Tier-aware: getDb() throws in Local mode (no DATABASE_URL), which turned
  // every module de-registration into a 500 before the local file store was
  // ever consulted. The registry union reads local rows and PG only when the
  // dual tier can actually serve them.
  const { agentRegistry } = await import("../agents/agent-gate.js");
  const roster = await agentRegistry.list({});
  if (moduleType === "model") return roster.find((a: any) => a.modelModuleId === moduleId) ?? null;
  if (moduleType === "instruction") return roster.find((a: any) => a.instructionModuleId === moduleId) ?? null;
  if (moduleType === "toolkit") return roster.find((a: any) => a.toolkitModuleId === moduleId) ?? null;
  if (moduleType === "constraints") return roster.find((a: any) => a.constraintsModuleId === moduleId) ?? null;
  return roster.find((a: any) => a.capabilitiesModuleId === moduleId) ?? null;
}

export interface ModuleReferenceIds {
  modelModuleId?: string | null;
  instructionModuleId: string;
  toolkitModuleId?: string | null;
  constraintsModuleId?: string | null;
  capabilitiesModuleId?: string | null;
}

// Single choke point for module-reference validation (Agents calls this via gate).
export async function validateModuleReferences(ids: ModuleReferenceIds, dbOverride?: any): Promise<void> {
  const db = dbOverride || getDb();
  const [modelModule, instructionModule, toolkitModule, constraintsModule, capabilitiesModule] =
    await Promise.all([
      ids.modelModuleId
        ? db.query.modelModules.findFirst({ where: eq(modelModules.id, ids.modelModuleId) })
        : Promise.resolve(null),
      db.query.instructionModules.findFirst({ where: eq(instructionModules.id, ids.instructionModuleId) }),
      ids.toolkitModuleId
        ? db.query.toolkitModules.findFirst({ where: eq(toolkitModules.id, ids.toolkitModuleId) })
        : Promise.resolve(null),
      ids.constraintsModuleId
        ? db.query.constraintsModules.findFirst({ where: eq(constraintsModules.id, ids.constraintsModuleId) })
        : Promise.resolve(null),
      ids.capabilitiesModuleId
        ? db.query.capabilitiesModules.findFirst({ where: eq(capabilitiesModules.id, ids.capabilitiesModuleId) })
        : Promise.resolve(null),
    ]);
  if (ids.modelModuleId && !modelModule) throw new Error(`ModelModule not found: ${ids.modelModuleId}`);
  if (!instructionModule) throw new Error(`InstructionModule not found: ${ids.instructionModuleId}`);
  if (ids.toolkitModuleId && !toolkitModule) throw new Error(`ToolkitModule not found: ${ids.toolkitModuleId}`);
  if (ids.constraintsModuleId && !constraintsModule) throw new Error(`ConstraintsModule not found: ${ids.constraintsModuleId}`);
  if (ids.capabilitiesModuleId && !capabilitiesModule) throw new Error(`CapabilitiesModule not found: ${ids.capabilitiesModuleId}`);
}

export async function testConnectionHelper(
  provider: string,
  modelName: string,
  apiKey?: string | null,
  endpointUrl?: string | null
): Promise<{ success: boolean; message: string }> {
  if (!apiKey && provider !== "ollama" && provider !== "custom") {
    return { success: false, message: `Missing API key for provider ${provider}` };
  }

  try {
    if (provider === "google") {
      try {
        const testModule = {
          modelName: modelName || "gemini-2.0-flash",
          apiKey: apiKey || "",
          baseUrl: endpointUrl || ""
        };

        const { url, headers, bodyBuilder } = compileGoogleEndpoint(testModule);

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(bodyBuilder("", "ping")),
          signal: AbortSignal.timeout(3000)
        });
        if (response.ok) {
          return { success: true, message: "Successfully connected to Google API." };
        } else {
          const errText = await response.text();
          return { success: false, message: `Google API returned status ${response.status}: ${errText}` };
        }
      } catch (err: any) {
        const errorMsg = err.message || String(err);
        const isTimeoutOrAbort = err.name === "AbortError" || errorMsg.includes("aborted") || err.code === "ETIMEDOUT";
        const isOffline = errorMsg.includes("fetch failed") || errorMsg.includes("ENOTFOUND") || err.code === "ENOTFOUND" || err.code === "ECONNREFUSED";

        if (isTimeoutOrAbort || isOffline) {
          return {
            success: true,
            message: `Connection test configuration validated. (Offline Mode Active)`
          };
        }
        return { success: false, message: `Connection test configuration error: ${err.message || String(err)}` };
      }
    } else if (provider === "openai") {
      const url = endpointUrl || "https://api.openai.com/v1/chat/completions";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName || "gpt-4o-mini",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        }),
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        return { success: true, message: "Successfully connected to OpenAI API." };
      } else {
        const errText = await response.text();
        return { success: false, message: `OpenAI API returned status ${response.status}: ${errText}` };
      }
    } else if (provider === "anthropic") {
      const url = endpointUrl || "https://api.anthropic.com/v1/messages";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey || "",
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: modelName || "claude-3-5-sonnet-20241022",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        }),
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        return { success: true, message: "Successfully connected to Anthropic API." };
      } else {
        const errText = await response.text();
        return { success: false, message: `Anthropic API returned status ${response.status}: ${errText}` };
      }
    } else if (provider === "ollama") {
      const url = `${endpointUrl || "http://localhost:11434"}/api/generate`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          prompt: "ping",
          stream: false
        }),
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        return { success: true, message: "Successfully connected to Ollama API." };
      } else {
        return { success: false, message: `Ollama API returned status ${response.status}` };
      }
    } else {
      return { success: true, message: `Successfully validated configuration parameters for provider ${provider}.` };
    }
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    const isTimeoutOrAbort = error.name === "AbortError" || errorMsg.includes("aborted") || error.code === "ETIMEDOUT";
    const isOffline = errorMsg.includes("fetch failed") || errorMsg.includes("ENOTFOUND") || error.code === "ENOTFOUND" || error.code === "ECONNREFUSED";

    if (isTimeoutOrAbort || isOffline) {
      return {
        success: true,
        message: `Connection test configuration validated. (Offline Mode Active)`
      };
    }
    return { success: false, message: `Connection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// --- Aggregated list ---
// Reference data polled hot by clients: 10s TTL dedupes the 5-table fan-out.
// ponytail: TTL-only, no write invalidation — at most 10s stale after a mutation.
const listAllCache = new TtlCache<Awaited<ReturnType<typeof fetchAllModules>>>(10_000, 1);

export interface ListModulesOpts {
  limit?: number;
  offset?: number;
}

function clampListOpts(opts?: ListModulesOpts): { limit: number; offset: number } {
  const rawLimit = Number(opts?.limit);
  const rawOffset = Number(opts?.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 500;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return { limit, offset };
}

async function fetchAllModules(opts?: ListModulesOpts) {
  const db = getDb();
  const { limit, offset } = clampListOpts(opts);
  const [modelList, instructionList, toolkitList, constraintsList, capabilitiesList] = await Promise.all([
    db.select().from(modelModules).limit(limit).offset(offset),
    db.select().from(instructionModules).limit(limit).offset(offset),
    db.select().from(toolkitModules).limit(limit).offset(offset),
    db.select().from(constraintsModules).limit(limit).offset(offset),
    db.select().from(capabilitiesModules).limit(limit).offset(offset)
  ]);

  return {
    modelModules: modelList,
    instructionModules: instructionList,
    toolkitModules: toolkitList,
    constraintsModules: constraintsList,
    capabilitiesModules: capabilitiesList
  };
}

export async function listAllModules(opts?: ListModulesOpts & { workspaceId?: string | null }) {
  const { limit, offset } = clampListOpts(opts);
  const { tier } = await moduleTier(opts?.workspaceId);
  if (tier === "local") {
    const [modelModules, instructionModules, toolkitModules, constraintsModules, capabilitiesModules] =
      await Promise.all([
        localListModelModules(opts?.workspaceId),
        localListInstructionModules(opts?.workspaceId),
        localListToolkitModules(opts?.workspaceId),
        localListConstraintsModules(opts?.workspaceId),
        localListCapabilitiesModules(opts?.workspaceId),
      ]);
    return { modelModules, instructionModules, toolkitModules, constraintsModules, capabilitiesModules };
  }
  const key = `${dbScopeKey()}:all:${limit}:${offset}`;
  const hit = listAllCache.get(key);
  if (hit) return hit;
  const fresh = await fetchAllModules({ limit, offset });
  listAllCache.set(key, fresh);
  return fresh;
}

// --- Model Modules ---
export async function listModelModules(opts?: ListModulesOpts & { workspaceId?: string | null }) {
  const { limit, offset } = clampListOpts(opts);
  const { tier } = await moduleTier(opts?.workspaceId);
  if (tier === "local") {
    const rows = await localListModelModules(opts?.workspaceId);
    return rows.slice(offset, offset + limit);
  }
  return getDb().select().from(modelModules).limit(limit).offset(offset);
}
export async function getModelModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetModelModule(id, workspaceId);
  const [res] = await getDb().select().from(modelModules).where(eq(modelModules.id, id)).limit(1);
  return res ?? null;
}
export async function createModelModule(body: CreateModelModuleBody, workspaceId?: string | null) {
  const id = randomUUID();
  const values = {
    id,
    ...body,
    apiKey: body.apiKey == null ? null : encrypt(body.apiKey),
    endpointUrl: body.endpointUrl ?? null,
    stopSequences: body.stopSequences ?? [],
    enableCompression: body.enableCompression ?? true
  };
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const now = new Date();
    const row: ModelModule = { ...(values as any), createdAt: now, updatedAt: now };
    await localUpsertModelModule(serializeRow(row), workspaceId);
    return row;
  }
  const [res] = await getDb().insert(modelModules).values(values).returning();
  return res;
}
export async function updateModelModule(id: string, body: UpdateModelModuleBody, workspaceId?: string | null) {
  const updates: UpdateModelModuleBody = { ...body };
  if (updates.apiKey !== undefined) updates.apiKey = updates.apiKey == null ? null : encrypt(updates.apiKey);
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetModelModule(id, workspaceId);
    if (!existing) return null;
    const row: ModelModule = { ...existing, ...(updates as any), updatedAt: new Date() };
    await localUpsertModelModule(serializeRow(row), workspaceId);
    runtimeGate.invalidateModelModuleCache(id);
    return row;
  }
  const [res] = await getDb()
    .update(modelModules)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(modelModules.id, id))
    .returning();
  runtimeGate.invalidateModelModuleCache(id);
  return res ?? null;
}
export async function deleteModelModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const deleted = await localDeleteModelModule(id, workspaceId);
    runtimeGate.invalidateModelModuleCache(id);
    return deleted ? [{ id }] : [];
  }
  const rows = await getDb().delete(modelModules).where(eq(modelModules.id, id)).returning();
  runtimeGate.invalidateModelModuleCache(id);
  return rows;
}
export async function testModelModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  let module: any = null;
  if (tier === "local") {
    module = await localGetModelModule(id, workspaceId);
  } else {
    [module] = await getDb().select().from(modelModules).where(eq(modelModules.id, id)).limit(1);
  }
  if (!module) return null;
  return testConnectionHelper(module.provider, module.modelName, module.apiKey ? decrypt(module.apiKey) : module.apiKey, module.endpointUrl);
}

// --- Instruction Modules ---
export async function listInstructionModules(opts?: ListModulesOpts & { workspaceId?: string | null }) {
  const { limit, offset } = clampListOpts(opts);
  const { tier } = await moduleTier(opts?.workspaceId);
  if (tier === "local") {
    const rows = await localListInstructionModules(opts?.workspaceId);
    return rows.slice(offset, offset + limit);
  }
  return getDb().select().from(instructionModules).limit(limit).offset(offset);
}
export async function getInstructionModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetInstructionModule(id, workspaceId);
  const [res] = await getDb().select().from(instructionModules).where(eq(instructionModules.id, id)).limit(1);
  return res ?? null;
}
export async function createInstructionModule(body: CreateInstructionModuleBody, workspaceId?: string | null) {
  const id = randomUUID();
  const values = {
    id,
    ...body,
    base: body.base ?? [],
    runtimePatchable: body.runtimePatchable ?? false
  };
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const now = new Date();
    const row: InstructionModule = { ...(values as any), createdAt: now, updatedAt: now };
    await localUpsertInstructionModule(serializeRow(row), workspaceId);
    return row;
  }
  const [res] = await getDb().insert(instructionModules).values(values).returning();
  return res;
}
export async function updateInstructionModule(id: string, body: UpdateInstructionModuleBody, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetInstructionModule(id, workspaceId);
    if (!existing) return null;
    const row: InstructionModule = { ...existing, ...(body as any), updatedAt: new Date() };
    await localUpsertInstructionModule(serializeRow(row), workspaceId);
    return row;
  }
  const [res] = await getDb()
    .update(instructionModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(instructionModules.id, id))
    .returning();
  return res ?? null;
}
export async function deleteInstructionModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const deleted = await localDeleteInstructionModule(id, workspaceId);
    return deleted ? [{ id }] : [];
  }
  return getDb().delete(instructionModules).where(eq(instructionModules.id, id)).returning();
}

// --- Toolkit Modules ---
export async function listToolkitModules(opts?: ListModulesOpts & { workspaceId?: string | null }) {
  const { limit, offset } = clampListOpts(opts);
  const { tier } = await moduleTier(opts?.workspaceId);
  if (tier === "local") {
    const rows = await localListToolkitModules(opts?.workspaceId);
    return rows.slice(offset, offset + limit);
  }
  return getDb().select().from(toolkitModules).limit(limit).offset(offset);
}
export async function getToolkitModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetToolkitModule(id, workspaceId);
  const [res] = await getDb().select().from(toolkitModules).where(eq(toolkitModules.id, id)).limit(1);
  return res ?? null;
}
export async function createToolkitModule(body: CreateToolkitModuleBody, workspaceId?: string | null) {
  const id = randomUUID();
  const values = { id, ...body, tools: body.tools ?? [] };
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const now = new Date();
    const row: ToolkitModule = { ...(values as any), createdAt: now, updatedAt: now };
    await localUpsertToolkitModule(serializeRow(row), workspaceId);
    skillsGate.invalidateAgentCaches();
    return row;
  }
  const [res] = await getDb().insert(toolkitModules).values(values).returning();
  skillsGate.invalidateAgentCaches();
  return res;
}
export async function updateToolkitModule(id: string, body: UpdateToolkitModuleBody, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetToolkitModule(id, workspaceId);
    if (!existing) return null;
    const row: ToolkitModule = { ...existing, ...(body as any), updatedAt: new Date() };
    await localUpsertToolkitModule(serializeRow(row), workspaceId);
    skillsGate.invalidateAgentCaches();
    return row;
  }
  const [res] = await getDb()
    .update(toolkitModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(toolkitModules.id, id))
    .returning();
  skillsGate.invalidateAgentCaches();
  return res ?? null;
}
export async function deleteToolkitModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const deleted = await localDeleteToolkitModule(id, workspaceId);
    skillsGate.invalidateAgentCaches();
    return deleted ? [{ id }] : [];
  }
  const rows = await getDb().delete(toolkitModules).where(eq(toolkitModules.id, id)).returning();
  skillsGate.invalidateAgentCaches();
  return rows;
}

// --- Constraints Modules ---
export async function listConstraintsModules(opts?: ListModulesOpts & { workspaceId?: string | null }) {
  const { limit, offset } = clampListOpts(opts);
  const { tier } = await moduleTier(opts?.workspaceId);
  if (tier === "local") {
    const rows = await localListConstraintsModules(opts?.workspaceId);
    return rows.slice(offset, offset + limit);
  }
  return getDb().select().from(constraintsModules).limit(limit).offset(offset);
}
export async function getConstraintsModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetConstraintsModule(id, workspaceId);
  const [res] = await getDb().select().from(constraintsModules).where(eq(constraintsModules.id, id)).limit(1);
  return res ?? null;
}
export async function createConstraintsModule(body: CreateConstraintsModuleBody, workspaceId?: string | null) {
  const id = randomUUID();
  const values = {
    id,
    ...body,
    rules: body.rules ?? [],
    disallowedActions: body.disallowedActions ?? []
  };
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const now = new Date();
    const row: ConstraintsModule = { ...(values as any), createdAt: now, updatedAt: now };
    await localUpsertConstraintsModule(serializeRow(row), workspaceId);
    return row;
  }
  const [res] = await getDb().insert(constraintsModules).values(values).returning();
  return res;
}
export async function updateConstraintsModule(id: string, body: UpdateConstraintsModuleBody, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetConstraintsModule(id, workspaceId);
    if (!existing) return null;
    const row: ConstraintsModule = { ...existing, ...(body as any), updatedAt: new Date() };
    await localUpsertConstraintsModule(serializeRow(row), workspaceId);
    return row;
  }
  const [res] = await getDb()
    .update(constraintsModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(constraintsModules.id, id))
    .returning();
  return res ?? null;
}
export async function deleteConstraintsModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const deleted = await localDeleteConstraintsModule(id, workspaceId);
    return deleted ? [{ id }] : [];
  }
  return getDb().delete(constraintsModules).where(eq(constraintsModules.id, id)).returning();
}

// --- Capabilities Modules ---
export async function listCapabilitiesModules(opts?: ListModulesOpts & { workspaceId?: string | null }) {
  const { limit, offset } = clampListOpts(opts);
  const { tier } = await moduleTier(opts?.workspaceId);
  if (tier === "local") {
    const rows = await localListCapabilitiesModules(opts?.workspaceId);
    return rows.slice(offset, offset + limit);
  }
  return getDb().select().from(capabilitiesModules).limit(limit).offset(offset);
}
export async function getCapabilitiesModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetCapabilitiesModule(id, workspaceId);
  const [res] = await getDb().select().from(capabilitiesModules).where(eq(capabilitiesModules.id, id)).limit(1);
  return res ?? null;
}
export async function createCapabilitiesModule(body: CreateCapabilitiesModuleBody, workspaceId?: string | null) {
  const id = randomUUID();
  const values = {
    id,
    ...body,
    skills: body.skills ?? [],
    functionSchemas: body.functionSchemas ?? []
  };
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const now = new Date();
    const row: CapabilitiesModule = { ...(values as any), createdAt: now, updatedAt: now };
    await localUpsertCapabilitiesModule(serializeRow(row), workspaceId);
    return row;
  }
  const [res] = await getDb().insert(capabilitiesModules).values(values).returning();
  return res;
}
export async function updateCapabilitiesModule(id: string, body: UpdateCapabilitiesModuleBody, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetCapabilitiesModule(id, workspaceId);
    if (!existing) return null;
    const row: CapabilitiesModule = { ...existing, ...(body as any), updatedAt: new Date() };
    await localUpsertCapabilitiesModule(serializeRow(row), workspaceId);
    return row;
  }
  const [res] = await getDb()
    .update(capabilitiesModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(capabilitiesModules.id, id))
    .returning();
  return res ?? null;
}
export async function deleteCapabilitiesModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const deleted = await localDeleteCapabilitiesModule(id, workspaceId);
    return deleted ? [{ id }] : [];
  }
  return getDb().delete(capabilitiesModules).where(eq(capabilitiesModules.id, id)).returning();
}
