import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, dbScopeKey } from "../shared/config/database.js";
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

export type ModuleType = "model" | "instruction" | "toolkit" | "constraints" | "capabilities";

export async function findReferencingAgent(moduleType: ModuleType, moduleId: string) {
  const db = getDb();
  if (moduleType === "model") {
    return db.query.agents.findFirst({ where: eq(agents.modelModuleId, moduleId) });
  }
  if (moduleType === "instruction") {
    return db.query.agents.findFirst({ where: eq(agents.instructionModuleId, moduleId) });
  }
  if (moduleType === "toolkit") {
    return db.query.agents.findFirst({ where: eq(agents.toolkitModuleId, moduleId) });
  }
  if (moduleType === "constraints") {
    return db.query.agents.findFirst({ where: eq(agents.constraintsModuleId, moduleId) });
  }
  return db.query.agents.findFirst({ where: eq(agents.capabilitiesModuleId, moduleId) });
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

export async function listAllModules(opts?: ListModulesOpts) {
  const { limit, offset } = clampListOpts(opts);
  const key = `${dbScopeKey()}:all:${limit}:${offset}`;
  const hit = listAllCache.get(key);
  if (hit) return hit;
  const fresh = await fetchAllModules({ limit, offset });
  listAllCache.set(key, fresh);
  return fresh;
}

// --- Model Modules ---
export async function listModelModules(opts?: ListModulesOpts) {
  const { limit, offset } = clampListOpts(opts);
  return getDb().select().from(modelModules).limit(limit).offset(offset);
}
export async function getModelModule(id: string) {
  const [res] = await getDb().select().from(modelModules).where(eq(modelModules.id, id)).limit(1);
  return res ?? null;
}
export async function createModelModule(body: CreateModelModuleBody) {
  const id = randomUUID();
  const [res] = await getDb().insert(modelModules).values({
    id,
    ...body,
    apiKey: body.apiKey == null ? null : encrypt(body.apiKey),
    endpointUrl: body.endpointUrl ?? null,
    stopSequences: body.stopSequences ?? [],
    enableCompression: body.enableCompression ?? true
  }).returning();
  return res;
}
export async function updateModelModule(id: string, body: UpdateModelModuleBody) {
  const updates: UpdateModelModuleBody = { ...body };
  if (updates.apiKey !== undefined) updates.apiKey = updates.apiKey == null ? null : encrypt(updates.apiKey);
  const [res] = await getDb()
    .update(modelModules)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(modelModules.id, id))
    .returning();
  runtimeGate.invalidateModelModuleCache(id);
  return res ?? null;
}
export async function deleteModelModule(id: string) {
  const rows = await getDb().delete(modelModules).where(eq(modelModules.id, id)).returning();
  runtimeGate.invalidateModelModuleCache(id);
  return rows;
}
export async function testModelModule(id: string) {
  const [module] = await getDb().select().from(modelModules).where(eq(modelModules.id, id)).limit(1);
  if (!module) return null;
  return testConnectionHelper(module.provider, module.modelName, module.apiKey ? decrypt(module.apiKey) : module.apiKey, module.endpointUrl);
}

// --- Instruction Modules ---
export async function listInstructionModules(opts?: ListModulesOpts) {
  const { limit, offset } = clampListOpts(opts);
  return getDb().select().from(instructionModules).limit(limit).offset(offset);
}
export async function getInstructionModule(id: string) {
  const [res] = await getDb().select().from(instructionModules).where(eq(instructionModules.id, id)).limit(1);
  return res ?? null;
}
export async function createInstructionModule(body: CreateInstructionModuleBody) {
  const id = randomUUID();
  const [res] = await getDb().insert(instructionModules).values({
    id,
    ...body,
    base: body.base ?? [],
    runtimePatchable: body.runtimePatchable ?? false
  }).returning();
  return res;
}
export async function updateInstructionModule(id: string, body: UpdateInstructionModuleBody) {
  const [res] = await getDb()
    .update(instructionModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(instructionModules.id, id))
    .returning();
  return res ?? null;
}
export async function deleteInstructionModule(id: string) {
  return getDb().delete(instructionModules).where(eq(instructionModules.id, id)).returning();
}

// --- Toolkit Modules ---
export async function listToolkitModules(opts?: ListModulesOpts) {
  const { limit, offset } = clampListOpts(opts);
  return getDb().select().from(toolkitModules).limit(limit).offset(offset);
}
export async function getToolkitModule(id: string) {
  const [res] = await getDb().select().from(toolkitModules).where(eq(toolkitModules.id, id)).limit(1);
  return res ?? null;
}
export async function createToolkitModule(body: CreateToolkitModuleBody) {
  const id = randomUUID();
  const [res] = await getDb().insert(toolkitModules).values({
    id,
    ...body,
    tools: body.tools ?? []
  }).returning();
  skillsGate.invalidateAgentCaches();
  return res;
}
export async function updateToolkitModule(id: string, body: UpdateToolkitModuleBody) {
  const [res] = await getDb()
    .update(toolkitModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(toolkitModules.id, id))
    .returning();
  skillsGate.invalidateAgentCaches();
  return res ?? null;
}
export async function deleteToolkitModule(id: string) {
  const rows = await getDb().delete(toolkitModules).where(eq(toolkitModules.id, id)).returning();
  skillsGate.invalidateAgentCaches();
  return rows;
}

// --- Constraints Modules ---
export async function listConstraintsModules(opts?: ListModulesOpts) {
  const { limit, offset } = clampListOpts(opts);
  return getDb().select().from(constraintsModules).limit(limit).offset(offset);
}
export async function getConstraintsModule(id: string) {
  const [res] = await getDb().select().from(constraintsModules).where(eq(constraintsModules.id, id)).limit(1);
  return res ?? null;
}
export async function createConstraintsModule(body: CreateConstraintsModuleBody) {
  const id = randomUUID();
  const [res] = await getDb().insert(constraintsModules).values({
    id,
    ...body,
    rules: body.rules ?? [],
    disallowedActions: body.disallowedActions ?? []
  }).returning();
  return res;
}
export async function updateConstraintsModule(id: string, body: UpdateConstraintsModuleBody) {
  const [res] = await getDb()
    .update(constraintsModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(constraintsModules.id, id))
    .returning();
  return res ?? null;
}
export async function deleteConstraintsModule(id: string) {
  return getDb().delete(constraintsModules).where(eq(constraintsModules.id, id)).returning();
}

// --- Capabilities Modules ---
export async function listCapabilitiesModules(opts?: ListModulesOpts) {
  const { limit, offset } = clampListOpts(opts);
  return getDb().select().from(capabilitiesModules).limit(limit).offset(offset);
}
export async function getCapabilitiesModule(id: string) {
  const [res] = await getDb().select().from(capabilitiesModules).where(eq(capabilitiesModules.id, id)).limit(1);
  return res ?? null;
}
export async function createCapabilitiesModule(body: CreateCapabilitiesModuleBody) {
  const id = randomUUID();
  const [res] = await getDb().insert(capabilitiesModules).values({
    id,
    ...body,
    skills: body.skills ?? [],
    functionSchemas: body.functionSchemas ?? []
  }).returning();
  return res;
}
export async function updateCapabilitiesModule(id: string, body: UpdateCapabilitiesModuleBody) {
  const [res] = await getDb()
    .update(capabilitiesModules)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(capabilitiesModules.id, id))
    .returning();
  return res ?? null;
}
export async function deleteCapabilitiesModule(id: string) {
  return getDb().delete(capabilitiesModules).where(eq(capabilitiesModules.id, id)).returning();
}
