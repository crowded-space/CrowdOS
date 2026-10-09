// --- Module Local Store (C3 local-first) --------------------------------
// File truth for the module catalogs when the workspace tier is local
// (no database record, forced-local preference, or a cached outage).
//
// Canon: one JSON array file per module type inside the workspace's
// .crowdos store (same layout as categories/channels):
//
//   <workspaceFolder>/vfs/.crowdos/model-modules.json
//   <workspaceFolder>/vfs/.crowdos/instruction-modules.json
//   <workspaceFolder>/vfs/.crowdos/toolkit-modules.json
//   <workspaceFolder>/vfs/.crowdos/constraints-modules.json
//   <workspaceFolder>/vfs/.crowdos/capabilities-modules.json
//
// Rows are stored serialized (ISO date strings) and revived to Date on
// read so consumers see the same shape the PG rows produce.
//
// Scope hygiene (mirrors the agent store): production callers must name the
// workspace — an unscoped upsert would silently file the row under the
// "default" folder. Unit tests are exempt: their explicit per-test store dir
// (setLocalStoreDirForTests) makes unscoped writes a documented fixture
// mechanism, not production traffic.

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_WORKSPACE_SCOPE,
  isTestStoreDir,
  mutateJsonArray,
  readJsonArray,
  resolveLocalStoreDir,
} from "../shared/core/local-file.js";
import type {
  ModelModule,
  InstructionModule,
  ToolkitModule,
  ConstraintsModule,
  CapabilitiesModule,
} from "./module-types.js";

type Serialized<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };

const MODEL_FILE = "model-modules.json";
const INSTRUCTION_FILE = "instruction-modules.json";
const TOOLKIT_FILE = "toolkit-modules.json";
const CONSTRAINTS_FILE = "constraints-modules.json";
const CAPABILITIES_FILE = "capabilities-modules.json";

/**
 * Effective scope for an upsert. Returns the trimmed scope, the bare
 * "default" placeholder under vitest fixtures, or null to refuse the write.
 */
function upsertScope(workspaceId?: string | null): string | null {
  const trimmed = workspaceId?.trim();
  if (trimmed) return trimmed;
  // M-10: narrowed from any-VITEST env to the pinned test-dir flag (static
  // import; require() is unavailable in ESM).
  if (isTestStoreDir()) return DEFAULT_WORKSPACE_SCOPE;
  return null;
}

function revive<T extends { createdAt: unknown; updatedAt: unknown }>(row: T): any {
  const toDate = (v: unknown): Date => {
    const d = new Date(v as unknown as string);
    if (Number.isNaN(d.getTime())) {
      console.warn(`[modules] revive: invalid date ${JSON.stringify(v)} coerced to epoch`);
      return new Date(0);
    }
    return d;
  };
  return {
    ...row,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

/**
 * Scope for a get-by-id. Unscoped reads the default placeholder folder only
 * — the same folder an unscoped write lands in — never a fan-out across
 * every registered workspace (that leaked cross-tenant rows into unscoped
 * reads and made scopes disagree with the write path's trim).
 */
function scopesFor(workspaceId?: string | null): Array<string | null> {
  const trimmed = workspaceId?.trim();
  return trimmed ? [trimmed] : [null];
}

/**
 * Verify-before-mutate: readJsonArray maps corrupt/non-array files to []
 * (the read path must stay tolerant), but mutateJsonArray would then write
 * that [] straight over the corrupt bytes — silently destroying whatever
 * was left. Upstreams may only overwrite a file that parses as a JSON array
 * or does not exist yet.
 */
async function assertStoreWritable(file: string, scope: string | null): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(resolveLocalStoreDir(scope), file), "utf8");
  } catch {
    return; // missing file (or unreadable): nothing to lose here
  }
  if (!raw.trim()) return; // empty file: nothing to lose
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return;
  } catch {
    // fall through: not JSON
  }
  throw Object.assign(
    new Error(
      `Module store corrupt: ${file} (workspace ${scope ?? DEFAULT_WORKSPACE_SCOPE}) is not a JSON array; refusing to overwrite it. Repair or remove the file first.`,
    ),
    { code: "MODULE_STORE_CORRUPT", statusCode: 500 },
  );
}

/**
 * Owner-scoped delete shared by all five catalogs. A scoped call touches one
 * folder. An unscoped call only ever touches the default placeholder folder
 * — never a fan-out across every workspace (that wiped same-id rows in
 * workspaces the caller never named).
 */
async function deleteFromFile<T extends { id: string }>(file: string, id: string, workspaceId?: string | null): Promise<boolean> {
  if (workspaceId && workspaceId.trim()) {
    const scope = workspaceId.trim();
    let deleted = false;
    await assertStoreWritable(file, scope);
    await mutateJsonArray<T>(
      file,
      (rows) => rows.filter((r) => {
        if (r.id === id) { deleted = true; return false; }
        return true;
      }),
      scope,
    );
    return deleted;
  }
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<T>(file, scope).catch(() => [] as T[]);
    if (!rows.some((r) => r.id === id)) continue;
    await mutateJsonArray<T>(file, (all) => all.filter((r) => r.id !== id), scope);
    return true;
  }
  return false;
}

// --- Model modules -------------------------------------------------------

export async function localListModelModules(workspaceId?: string | null): Promise<ModelModule[]> {
  const rows = await readJsonArray<Serialized<ModelModule>>(MODEL_FILE, workspaceId);
  return rows.map(revive);
}

export async function localGetModelModule(id: string, workspaceId?: string | null): Promise<ModelModule | null> {
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<Serialized<ModelModule>>(MODEL_FILE, scope).catch(() => []);
    const hit = rows.find((r) => r.id === id);
    if (hit) return revive(hit);
  }
  return null;
}

export async function localUpsertModelModule(row: Serialized<ModelModule>, workspaceId?: string | null): Promise<void> {
  const scope = upsertScope(workspaceId);
  if (!scope) throw new Error("localUpsertModelModule: workspaceId is required when creating a module (refusing to write to the 'default' scope)");
  await assertStoreWritable(MODEL_FILE, scope);
  await mutateJsonArray<Serialized<ModelModule>>(
    MODEL_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteModelModule(id: string, workspaceId?: string | null): Promise<boolean> {
  return deleteFromFile<Serialized<ModelModule>>(MODEL_FILE, id, workspaceId);
}

// --- Instruction modules -------------------------------------------------

export async function localListInstructionModules(workspaceId?: string | null): Promise<InstructionModule[]> {
  const rows = await readJsonArray<Serialized<InstructionModule>>(INSTRUCTION_FILE, workspaceId);
  return rows.map(revive);
}

export async function localGetInstructionModule(id: string, workspaceId?: string | null): Promise<InstructionModule | null> {
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<Serialized<InstructionModule>>(INSTRUCTION_FILE, scope).catch(() => []);
    const hit = rows.find((r) => r.id === id);
    if (hit) return revive(hit);
  }
  return null;
}

export async function localUpsertInstructionModule(row: Serialized<InstructionModule>, workspaceId?: string | null): Promise<void> {
  const scope = upsertScope(workspaceId);
  if (!scope) throw new Error("localUpsertInstructionModule: workspaceId is required when creating a module (refusing to write to the 'default' scope)");
  await assertStoreWritable(INSTRUCTION_FILE, scope);
  await mutateJsonArray<Serialized<InstructionModule>>(
    INSTRUCTION_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteInstructionModule(id: string, workspaceId?: string | null): Promise<boolean> {
  return deleteFromFile<Serialized<InstructionModule>>(INSTRUCTION_FILE, id, workspaceId);
}

// --- Toolkit modules -----------------------------------------------------

export async function localListToolkitModules(workspaceId?: string | null): Promise<ToolkitModule[]> {
  const rows = await readJsonArray<Serialized<ToolkitModule>>(TOOLKIT_FILE, workspaceId);
  return rows.map(revive);
}

export async function localGetToolkitModule(id: string, workspaceId?: string | null): Promise<ToolkitModule | null> {
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<Serialized<ToolkitModule>>(TOOLKIT_FILE, scope).catch(() => []);
    const hit = rows.find((r) => r.id === id);
    if (hit) return revive(hit);
  }
  return null;
}

export async function localUpsertToolkitModule(row: Serialized<ToolkitModule>, workspaceId?: string | null): Promise<void> {
  const scope = upsertScope(workspaceId);
  if (!scope) throw new Error("localUpsertToolkitModule: workspaceId is required when creating a module (refusing to write to the 'default' scope)");
  await assertStoreWritable(TOOLKIT_FILE, scope);
  await mutateJsonArray<Serialized<ToolkitModule>>(
    TOOLKIT_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteToolkitModule(id: string, workspaceId?: string | null): Promise<boolean> {
  return deleteFromFile<Serialized<ToolkitModule>>(TOOLKIT_FILE, id, workspaceId);
}

// --- Constraints modules -------------------------------------------------

export async function localListConstraintsModules(workspaceId?: string | null): Promise<ConstraintsModule[]> {
  const rows = await readJsonArray<Serialized<ConstraintsModule>>(CONSTRAINTS_FILE, workspaceId);
  return rows.map(revive);
}

export async function localGetConstraintsModule(id: string, workspaceId?: string | null): Promise<ConstraintsModule | null> {
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<Serialized<ConstraintsModule>>(CONSTRAINTS_FILE, scope).catch(() => []);
    const hit = rows.find((r) => r.id === id);
    if (hit) return revive(hit);
  }
  return null;
}

export async function localUpsertConstraintsModule(row: Serialized<ConstraintsModule>, workspaceId?: string | null): Promise<void> {
  const scope = upsertScope(workspaceId);
  if (!scope) throw new Error("localUpsertConstraintsModule: workspaceId is required when creating a module (refusing to write to the 'default' scope)");
  await assertStoreWritable(CONSTRAINTS_FILE, scope);
  await mutateJsonArray<Serialized<ConstraintsModule>>(
    CONSTRAINTS_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteConstraintsModule(id: string, workspaceId?: string | null): Promise<boolean> {
  return deleteFromFile<Serialized<ConstraintsModule>>(CONSTRAINTS_FILE, id, workspaceId);
}

// --- Capabilities modules ------------------------------------------------

export async function localListCapabilitiesModules(workspaceId?: string | null): Promise<CapabilitiesModule[]> {
  const rows = await readJsonArray<Serialized<CapabilitiesModule>>(CAPABILITIES_FILE, workspaceId);
  return rows.map(revive);
}

export async function localGetCapabilitiesModule(id: string, workspaceId?: string | null): Promise<CapabilitiesModule | null> {
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<Serialized<CapabilitiesModule>>(CAPABILITIES_FILE, scope).catch(() => []);
    const hit = rows.find((r) => r.id === id);
    if (hit) return revive(hit);
  }
  return null;
}

export async function localUpsertCapabilitiesModule(row: Serialized<CapabilitiesModule>, workspaceId?: string | null): Promise<void> {
  const scope = upsertScope(workspaceId);
  if (!scope) throw new Error("localUpsertCapabilitiesModule: workspaceId is required when creating a module (refusing to write to the 'default' scope)");
  await assertStoreWritable(CAPABILITIES_FILE, scope);
  await mutateJsonArray<Serialized<CapabilitiesModule>>(
    CAPABILITIES_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteCapabilitiesModule(id: string, workspaceId?: string | null): Promise<boolean> {
  return deleteFromFile<Serialized<CapabilitiesModule>>(CAPABILITIES_FILE, id, workspaceId);
}
