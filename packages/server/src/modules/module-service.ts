import { eq, asc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, dbScopeKey, resolveTier, isConnectionError } from "../shared/config/database.js";
import { tierContextFor } from "../workspace/workspace-gate.js";
import { TtlCache } from "../shared/core/ttl-cache.js";
import { compileGoogleEndpoint } from "../shared/core/google-model-helpers.js";
import { encrypt, decrypt } from "../shared/core/secret-box.js";
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
  ModuleType,
} from "./module-types.js";
import {
  localListModelModules,
  localGetModelModule,
  localUpsertModelModule,
  localDeleteModelModule,
  localModelModuleOwnerScope,
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
  try {
    return resolveTier(await tierContextFor(workspaceId ?? null));
  } catch (err) {
    // tierContextFor reads the registry, not the module tables — a registry
    // failure must surface as a 4xx client error, never a bare 500.
    // ponytail: coded error (not a class) so no gate export is needed.
    if (isConnectionError(err)) throw err;
    throw Object.assign(new Error(`Invalid workspace scope: ${workspaceId ?? "null"}`), {
      code: "INVALID_WORKSPACE",
      statusCode: 400,
    });
  }
}

/** Serialize a module row for the local JSON store (Date fields -> ISO). */
type SerializedRow<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };
function serializeRow<T extends { createdAt: Date; updatedAt: Date }>(row: T): SerializedRow<T> {
  return {
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  } as SerializedRow<T>;
}

export type { ModuleType };

// Dynamic on purpose: a static runtime-gate import closes the cycle
// middlewares -> module-gate -> module-service -> runtime-gate ->
// context-pipeline-manager, which instantiates the middlewares at module
// eval time (they'd still be half-initialized).
async function invalidateRuntimeModelCache(): Promise<void> {
  const { runtimeGate } = await import("../runtime/runtime-gate.js");
  runtimeGate.invalidateModelModuleCache();
}

function referrersOf(roster: any[], moduleType: ModuleType, moduleId: string): any[] {
  const key =
    moduleType === "model" ? "modelModuleId"
    : moduleType === "instruction" ? "instructionModuleId"
    : moduleType === "toolkit" ? "toolkitModuleId"
    : moduleType === "constraints" ? "constraintsModuleId"
    : "capabilitiesModuleId";
  // ALL referrers (filter, not find): the 409 message should name every
  // blocker, not just the first. findReferencingAgent keeps first-only shape
  // for route compat (out of scope); new callers prefer findReferencingAgents.
  return roster.filter((a: any) => a?.[key] === moduleId);
}

export async function findReferencingAgents(moduleType: ModuleType, moduleId: string, workspaceId?: string | null) {
  const { agentRegistry } = await import("../agents/agent-gate.js");
  // null/undefined = legacy cross-workspace search (both legs: PG has no
  // workspace filter, local fans out); a named scope stays tenant-scoped.
  // M-05: guard lookups need the full roster — the default 200 cap
  // under-reported blockers and the delete could cascade after a partial 409.
  const roster = await agentRegistry.list({ ...(workspaceId == null ? {} : { workspaceId }), limit: 10000 });
  return referrersOf(roster, moduleType, moduleId);
}

export async function findReferencingAgent(moduleType: ModuleType, moduleId: string, workspaceId?: string | null) {
  // Tier-aware: getDb() throws in Local mode (no DATABASE_URL), which turned
  // every module de-registration into a 500 before the local file store was
  // ever consulted. The registry union reads local rows and PG only when the
  // dual tier can actually serve them.
  // Tenant scope: an agent in workspace B must not block deleting a module in
  // workspace A. Null scope keeps the legacy cross-workspace search.
  return (await findReferencingAgents(moduleType, moduleId, workspaceId))[0] ?? null;
}

const MODULE_LABELS: Record<ModuleType, string> = {
  model: "ModelModule",
  instruction: "InstructionModule",
  toolkit: "ToolkitModule",
  constraints: "ConstraintsModule",
  capabilities: "CapabilitiesModule",
};

/**
 * PG-tier delete guard: a module row can be referenced by agents in ANY
 * workspace (legacy shared rows carry no workspace of their own), so the
 * blocker search is deliberately unscoped — a scoped route check alone let
 * workspace A delete a module workspace B's agents still use. Local-tier
 * rows live in per-workspace folders where the scoped route check suffices.
 */
async function assertNoPgBlockers(moduleType: ModuleType, id: string): Promise<void> {
  const blockers = await findReferencingAgents(moduleType, id);
  if (blockers.length === 0) return;
  const names = blockers.map((a: any) => `"${a.name}"`).join(", ");
  throw Object.assign(
    new Error(`${MODULE_LABELS[moduleType]} is still used by agent ${names}. Reassign or delete that agent first.`),
    { name: "Conflict", code: "MODULE_IN_USE", statusCode: 409 },
  );
}

export interface ModuleReferenceIds {
  modelModuleId?: string | null;
  instructionModuleId: string;
  toolkitModuleId?: string | null;
  constraintsModuleId?: string | null;
  capabilitiesModuleId?: string | null;
}

// Single choke point for module-reference validation (Agents calls this via gate).
// ponytail: check-then-use TOCTOU remains (delete between validate and insert
// still races). M-02: schema.ts:224-228 ALREADY carries the FKs (instruction
// NOT NULL + cascade; others set null), so the 409 guard is safety-critical,
// not advisory — a raced delete cascades instead of failing.
export async function validateModuleReferences(ids: ModuleReferenceIds, dbOverride?: any, workspaceId?: string | null): Promise<void> {
  // Local tier: PG rows don't exist here, so validate against the local store.
  // Opt-in via workspaceId (Agents passes it on create); absent scope keeps
  // the legacy PG path so existing callers are unaffected.
  if (workspaceId !== undefined) {
    const { tier } = await moduleTier(workspaceId);
    if (tier === "local") {
      const [m, i, t, c, cap] = await Promise.all([
        ids.modelModuleId != null ? localGetModelModule(ids.modelModuleId, workspaceId) : Promise.resolve(null),
        localGetInstructionModule(ids.instructionModuleId, workspaceId),
        ids.toolkitModuleId != null ? localGetToolkitModule(ids.toolkitModuleId, workspaceId) : Promise.resolve(null),
        ids.constraintsModuleId != null ? localGetConstraintsModule(ids.constraintsModuleId, workspaceId) : Promise.resolve(null),
        ids.capabilitiesModuleId != null ? localGetCapabilitiesModule(ids.capabilitiesModuleId, workspaceId) : Promise.resolve(null),
      ]);
      if (ids.modelModuleId != null && !m) throw new Error(`ModelModule not found: ${ids.modelModuleId}`);
      if (!i) throw new Error(`InstructionModule not found: ${ids.instructionModuleId}`);
      if (ids.toolkitModuleId != null && !t) throw new Error(`ToolkitModule not found: ${ids.toolkitModuleId}`);
      if (ids.constraintsModuleId != null && !c) throw new Error(`ConstraintsModule not found: ${ids.constraintsModuleId}`);
      if (ids.capabilitiesModuleId != null && !cap) throw new Error(`CapabilitiesModule not found: ${ids.capabilitiesModuleId}`);
      return;
    }
  }
  const db = dbOverride || getDb();
  const [modelModule, instructionModule, toolkitModule, constraintsModule, capabilitiesModule] =
    await Promise.all([
      ids.modelModuleId != null
        ? db.query.modelModules.findFirst({ where: eq(modelModules.id, ids.modelModuleId) })
        : Promise.resolve(null),
      db.query.instructionModules.findFirst({ where: eq(instructionModules.id, ids.instructionModuleId) }),
      ids.toolkitModuleId != null
        ? db.query.toolkitModules.findFirst({ where: eq(toolkitModules.id, ids.toolkitModuleId) })
        : Promise.resolve(null),
      ids.constraintsModuleId != null
        ? db.query.constraintsModules.findFirst({ where: eq(constraintsModules.id, ids.constraintsModuleId) })
        : Promise.resolve(null),
      ids.capabilitiesModuleId != null
        ? db.query.capabilitiesModules.findFirst({ where: eq(capabilitiesModules.id, ids.capabilitiesModuleId) })
        : Promise.resolve(null),
    ]);
  if (ids.modelModuleId != null && !modelModule) throw new Error(`ModelModule not found: ${ids.modelModuleId}`);
  if (!instructionModule) throw new Error(`InstructionModule not found: ${ids.instructionModuleId}`);
  if (ids.toolkitModuleId != null && !toolkitModule) throw new Error(`ToolkitModule not found: ${ids.toolkitModuleId}`);
  if (ids.constraintsModuleId != null && !constraintsModule) throw new Error(`ConstraintsModule not found: ${ids.constraintsModuleId}`);
  if (ids.capabilitiesModuleId != null && !capabilitiesModule) throw new Error(`CapabilitiesModule not found: ${ids.capabilitiesModuleId}`);
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  /** True when the probe never reached the provider (timeout/DNS/refused). */
  offline?: boolean;
}

export async function testConnectionHelper(
  provider: string,
  modelName: string,
  apiKey?: string | null,
  endpointUrl?: string | null,
  apiEndpoint?: string | null
): Promise<ConnectionTestResult> {
  if (!apiKey && provider !== "ollama" && provider !== "custom") {
    return { success: false, message: `Missing API key for provider ${provider}` };
  }

  try {
    if ((provider === "openai" || provider === "custom") && apiEndpoint === "openai-responses") {
      // OpenAI Responses wire protocol: the probe must hit the same endpoint
      // shape the runtime will (never the chat-completions one).
      const base = (endpointUrl || (provider === "custom" ? "" : "https://api.openai.com/v1")).replace(/\/+$/, "");
      if (!base) {
        return { success: false, message: "Responses endpoint needs an endpointUrl" };
      }
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey || ""}`
        },
        body: JSON.stringify({
          model: modelName,
          input: "ping",
          max_output_tokens: 1
        }),
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        return { success: true, message: "Successfully connected to the OpenAI-Responses endpoint." };
      }
      const errText = await response.text();
      return { success: false, message: `Responses endpoint returned status ${response.status}: ${errText}` };
    } else if (provider === "google") {
      try {
        if (!modelName) {
          return { success: false, message: "Missing model name for provider google" };
        }
        const testModule = {
          modelName,
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
          // Probe never reached the provider: report failure with an
          // offline flag, never success. Callers (routes/modules.ts,
          // routes/providers.ts — out of scope) must treat offline:true as
          // config-shape validation only, not live-connectivity proof.
          return {
            success: false,
            offline: true,
            message: `Provider unreachable (offline). Configuration shape validated; live connectivity not confirmed.`
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
          model: modelName,
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
          model: modelName,
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
      // M-01: custom providers have no fixed probe endpoint. Validate the
      // endpoint shape (reachable URL + model name) instead of reporting a
      // misleading Unknown provider error.
      if (provider === "custom") {
        if (!endpointUrl) {
          return { success: false, message: "Custom provider needs an endpointUrl to probe." };
        }
        try {
          const parsed = new URL(endpointUrl);
          if (!/^https?:$/.test(parsed.protocol)) {
            return { success: false, message: `Custom endpointUrl must be http(s): ${endpointUrl}` };
          }
        } catch {
          return { success: false, message: `Custom endpointUrl is not a valid URL: ${endpointUrl}` };
        }
        if (!modelName) {
          return { success: false, message: "Custom provider needs a model name." };
        }
        return { success: true, message: "Custom endpoint shape validated (no live probe for custom providers).", offline: true };
      }
      return { success: false, message: `Unknown provider "${provider}": no probe endpoint, configuration not validated.` };
    }
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    const isTimeoutOrAbort = error.name === "AbortError" || errorMsg.includes("aborted") || error.code === "ETIMEDOUT";
    const isOffline = errorMsg.includes("fetch failed") || errorMsg.includes("ENOTFOUND") || error.code === "ENOTFOUND" || error.code === "ECONNREFUSED";

    if (isTimeoutOrAbort || isOffline) {
      return {
        success: false,
        offline: true,
        message: `Provider unreachable (offline). Configuration shape validated; live connectivity not confirmed.`
      };
    }
    return { success: false, message: `Connection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// --- Aggregated list ---
// Reference data polled hot by clients: 10s TTL dedupes the 5-table fan-out.
// Max 200 entries so workspace/tier/page keys coexist (was 1 slot: every page
// thrashed the previous entry). Cleared on any module mutation below.
const listAllCache = new TtlCache<Awaited<ReturnType<typeof fetchAllModules>>>(10_000, 200);

function clearListAllCache(): void {
  listAllCache.clear();
}
// NOTE on placement: the 15 mutations below call this FIRST, before their
// write. Post-write would be purer, but that needs ~30 insertions; pre-write
// is strictly better-or-equal here (single-user app: the only stale window
// is a list landing mid-mutation, and the 10s TTL backstops that). A failed
// mutation only costs one wasted re-fetch.

// Well-known id for the local-tier default instruction module, seeded by
// Agents on first create when a fresh local workspace has no catalog (see
// ensureDefaultModules). No default model module is seeded: a fresh workspace
// starts with zero model providers by contract.
export const DEFAULT_INSTRUCTION_MODULE_ID = "instr-default";

/**
 * Local-tier canon default (C3): a fresh local workspace has no catalog, so
 * "Launch Assembly" would reference an instruction row that never exists.
 * Seed the default InstructionModule per workspace, idempotent by well-known
 * id, straight through the local store — the REST create path mints its own
 * UUID (the Zod validator strips a client-supplied id), so gate create cannot
 * express "insert with this id". Local tier only; PG keeps strict validation.
 * Model modules are intentionally never seeded here: zero default provider.
 */
export async function ensureDefaultModules(workspaceId?: string | null): Promise<void> {
  const scope = workspaceId?.trim() || null;
  if (!scope) {
    // Nothing to seed into: the canon defaults are per-workspace rows. An
    // unscoped caller cannot name a folder, and seeding the "default"
    // placeholder is exactly what the store's production scope guard refuses
    // — so skip here and let the owning store surface its tenant-guard error.
    return;
  }
  // Local tier only: writing file-store rows while the workspace serves PG
  // would strand invisible data (and vice versa the seed already exists there).
  if ((await moduleTier(scope)).tier !== "local") return;
  if (!(await localGetInstructionModule(DEFAULT_INSTRUCTION_MODULE_ID, scope))) {
    await localUpsertInstructionModule(
      {
        id: DEFAULT_INSTRUCTION_MODULE_ID,
        label: "Default directives",
        base: ["Follow the workspace safety policies and answer honestly."],
        runtimePatchable: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any,
      scope,
    );
  }
}

export interface ListModulesOpts {
  limit?: number;
  offset?: number;
}

function clampListOpts(opts?: ListModulesOpts): { limit: number; offset: number } {
  // Number("")/Number(null) are 0 (finite): an empty query-string limit used
  // to clamp to 1 row instead of the documented default. Nullish/"" -> default.
  const num = (v?: number | string): number =>
    v === null || v === undefined || v === "" ? Number.NaN : Number(v);
  const rawLimit = num(opts?.limit);
  const rawOffset = num(opts?.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 500;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return { limit, offset };
}

async function fetchAllModules(opts?: ListModulesOpts) {
  const db = getDb();
  const { limit, offset } = clampListOpts(opts);
  const [modelList, instructionList, toolkitList, constraintsList, capabilitiesList] = await Promise.all([
    db.select().from(modelModules).orderBy(asc(modelModules.id)).limit(limit).offset(offset),
    db.select().from(instructionModules).orderBy(asc(instructionModules.id)).limit(limit).offset(offset),
    db.select().from(toolkitModules).orderBy(asc(toolkitModules.id)).limit(limit).offset(offset),
    db.select().from(constraintsModules).orderBy(asc(constraintsModules.id)).limit(limit).offset(offset),
    db.select().from(capabilitiesModules).orderBy(asc(capabilitiesModules.id)).limit(limit).offset(offset)
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
    // Pagination parity with the PG tier: the same limit/offset clamps apply,
    // so callers see one contract regardless of the effective tier.
    return {
      modelModules: modelModules.slice(offset, offset + limit),
      instructionModules: instructionModules.slice(offset, offset + limit),
      toolkitModules: toolkitModules.slice(offset, offset + limit),
      constraintsModules: constraintsModules.slice(offset, offset + limit),
      capabilitiesModules: capabilitiesModules.slice(offset, offset + limit),
    };
  }
  // Key includes workspace+db scope: the old dbScopeKey-only key served A's
  // cached rows to B whenever both shared one pooled handle ("global").
  const ws = opts?.workspaceId?.trim() || "unscoped";
  const key = `${ws}:${dbScopeKey()}:all:${limit}:${offset}`;
  const hit = listAllCache.get(key);
  if (hit) return hit;
  // Per-type limit/offset (not global): each table paginates independently.
  // Documented (not fetch-then-slice): 5 unbounded selects per listAll call
  // would punish the hot-poll path this cache exists to dedupe.
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
  return getDb().select().from(modelModules).orderBy(asc(modelModules.id)).limit(limit).offset(offset);
}
export async function getModelModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetModelModule(id, workspaceId);
  const [res] = await getDb().select().from(modelModules).where(eq(modelModules.id, id)).limit(1);
  return res ?? null;
}
export async function createModelModule(body: CreateModelModuleBody, workspaceId?: string | null) {
  clearListAllCache();
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
  clearListAllCache();
  const updates: UpdateModelModuleBody = { ...body };
  // Redacted-sentinel guard: reads go out via redactSecrets ("••••••••"/8-dot
  // mask, or "[REDACTED]" from header scrubbing). A client PUT-back of that
  // placeholder must NOT be encrypted as the new key (double-encrypt
  // corruption) — treat it as "keep existing".
  if (updates.apiKey !== undefined) {
    if (updates.apiKey === null) {
      updates.apiKey = null; // explicit clear
    } else if (updates.apiKey === "[REDACTED]" || /^[•*]{4,}$/.test(updates.apiKey)) {
      delete (updates as Record<string, unknown>).apiKey; // keep existing
    } else {
      updates.apiKey = encrypt(updates.apiKey);
    }
  }
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetModelModule(id, workspaceId);
    if (!existing) return null;
    const row: ModelModule = { ...existing, ...(updates as any), updatedAt: new Date() };
    // Owner-folder write-back: the row may live in a different folder than
    // the caller named (unscoped update after a scoped create). Writing to
    // the named scope would strand a second copy and leave the read path
    // serving the stale original.
    await localUpsertModelModule(serializeRow(row), await localModelModuleOwnerScope(id, workspaceId));
    await invalidateRuntimeModelCache();
    return row;
  }
  const [res] = await getDb()
    .update(modelModules)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(modelModules.id, id))
    .returning();
  await invalidateRuntimeModelCache();
  return res ?? null;
}
export async function deleteModelModule(id: string, workspaceId?: string | null) {
  clearListAllCache();
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetModelModule(id, workspaceId);
    const deleted = await localDeleteModelModule(id, workspaceId);
    await invalidateRuntimeModelCache();
    return deleted && existing ? [existing] : [];
  }
  await assertNoPgBlockers("model", id);
  const rows = await getDb().delete(modelModules).where(eq(modelModules.id, id)).returning();
  await invalidateRuntimeModelCache();
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
  // Corrupt/plaintext legacy rows must not 500 the health check: fall back
  // to the stored value when decrypt throws.
  let probeKey: string | null = module.apiKey;
  if (probeKey) {
    try {
      probeKey = decrypt(probeKey);
    } catch (err) {
      console.warn(`[modules] testModelModule: stored apiKey undecryptable for ${id}, probing with stored value as-is`);
    }
  }
  return testConnectionHelper(module.provider, module.modelName, probeKey, module.endpointUrl, module.apiEndpoint);
}

// --- Instruction Modules ---
export async function listInstructionModules(opts?: ListModulesOpts & { workspaceId?: string | null }) {
  const { limit, offset } = clampListOpts(opts);
  const { tier } = await moduleTier(opts?.workspaceId);
  if (tier === "local") {
    const rows = await localListInstructionModules(opts?.workspaceId);
    return rows.slice(offset, offset + limit);
  }
  return getDb().select().from(instructionModules).orderBy(asc(instructionModules.id)).limit(limit).offset(offset);
}
export async function getInstructionModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetInstructionModule(id, workspaceId);
  const [res] = await getDb().select().from(instructionModules).where(eq(instructionModules.id, id)).limit(1);
  return res ?? null;
}
export async function createInstructionModule(body: CreateInstructionModuleBody, workspaceId?: string | null) {
  clearListAllCache();
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
  clearListAllCache();
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
  clearListAllCache();
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetInstructionModule(id, workspaceId);
    const deleted = await localDeleteInstructionModule(id, workspaceId);
    return deleted && existing ? [existing] : [];
  }
  await assertNoPgBlockers("instruction", id);
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
  return getDb().select().from(toolkitModules).orderBy(asc(toolkitModules.id)).limit(limit).offset(offset);
}
export async function getToolkitModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetToolkitModule(id, workspaceId);
  const [res] = await getDb().select().from(toolkitModules).where(eq(toolkitModules.id, id)).limit(1);
  return res ?? null;
}
export async function createToolkitModule(body: CreateToolkitModuleBody, workspaceId?: string | null) {
  clearListAllCache();
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
  clearListAllCache();
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
  clearListAllCache();
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetToolkitModule(id, workspaceId);
    const deleted = await localDeleteToolkitModule(id, workspaceId);
    skillsGate.invalidateAgentCaches();
    return deleted && existing ? [existing] : [];
  }
  await assertNoPgBlockers("toolkit", id);
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
  return getDb().select().from(constraintsModules).orderBy(asc(constraintsModules.id)).limit(limit).offset(offset);
}
export async function getConstraintsModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetConstraintsModule(id, workspaceId);
  const [res] = await getDb().select().from(constraintsModules).where(eq(constraintsModules.id, id)).limit(1);
  return res ?? null;
}
export async function createConstraintsModule(body: CreateConstraintsModuleBody, workspaceId?: string | null) {
  clearListAllCache();
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
  clearListAllCache();
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
  clearListAllCache();
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetConstraintsModule(id, workspaceId);
    const deleted = await localDeleteConstraintsModule(id, workspaceId);
    return deleted && existing ? [existing] : [];
  }
  await assertNoPgBlockers("constraints", id);
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
  return getDb().select().from(capabilitiesModules).orderBy(asc(capabilitiesModules.id)).limit(limit).offset(offset);
}
export async function getCapabilitiesModule(id: string, workspaceId?: string | null) {
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") return localGetCapabilitiesModule(id, workspaceId);
  const [res] = await getDb().select().from(capabilitiesModules).where(eq(capabilitiesModules.id, id)).limit(1);
  return res ?? null;
}
export async function createCapabilitiesModule(body: CreateCapabilitiesModuleBody, workspaceId?: string | null) {
  clearListAllCache();
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
  clearListAllCache();
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
  clearListAllCache();
  const { tier } = await moduleTier(workspaceId);
  if (tier === "local") {
    const existing = await localGetCapabilitiesModule(id, workspaceId);
    const deleted = await localDeleteCapabilitiesModule(id, workspaceId);
    return deleted && existing ? [existing] : [];
  }
  await assertNoPgBlockers("capabilities", id);
  return getDb().delete(capabilitiesModules).where(eq(capabilitiesModules.id, id)).returning();
}
