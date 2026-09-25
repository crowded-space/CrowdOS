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

import {
  DEFAULT_WORKSPACE_SCOPE,
  searchableWorkspaceScopes,
  mutateJsonArray,
  readJsonArray,
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
  if (process.env.VITEST !== undefined) return DEFAULT_WORKSPACE_SCOPE;
  return null;
}

function revive<T extends { createdAt: unknown; updatedAt: unknown }>(row: T): any {
  return {
    ...row,
    createdAt: new Date(row.createdAt as unknown as string),
    updatedAt: new Date(row.updatedAt as unknown as string),
  };
}

/** Scopes to search for a get-by-id when the caller has no workspace id. */
function scopesFor(workspaceId?: string | null): Array<string | null> {
  return workspaceId && workspaceId.trim() ? [workspaceId] : searchableWorkspaceScopes();
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
  await mutateJsonArray<Serialized<ModelModule>>(
    MODEL_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteModelModule(id: string, workspaceId?: string | null): Promise<boolean> {
  let deleted = false;
  for (const scope of scopesFor(workspaceId)) {
    await mutateJsonArray<Serialized<ModelModule>>(
      MODEL_FILE,
      (rows) => rows.filter((r) => {
        if (r.id === id) { deleted = true; return false; }
        return true;
      }),
      scope,
    );
  }
  return deleted;
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
  await mutateJsonArray<Serialized<InstructionModule>>(
    INSTRUCTION_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteInstructionModule(id: string, workspaceId?: string | null): Promise<boolean> {
  let deleted = false;
  for (const scope of scopesFor(workspaceId)) {
    await mutateJsonArray<Serialized<InstructionModule>>(
      INSTRUCTION_FILE,
      (rows) => rows.filter((r) => {
        if (r.id === id) { deleted = true; return false; }
        return true;
      }),
      scope,
    );
  }
  return deleted;
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
  await mutateJsonArray<Serialized<ToolkitModule>>(
    TOOLKIT_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteToolkitModule(id: string, workspaceId?: string | null): Promise<boolean> {
  let deleted = false;
  for (const scope of scopesFor(workspaceId)) {
    await mutateJsonArray<Serialized<ToolkitModule>>(
      TOOLKIT_FILE,
      (rows) => rows.filter((r) => {
        if (r.id === id) { deleted = true; return false; }
        return true;
      }),
      scope,
    );
  }
  return deleted;
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
  await mutateJsonArray<Serialized<ConstraintsModule>>(
    CONSTRAINTS_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteConstraintsModule(id: string, workspaceId?: string | null): Promise<boolean> {
  let deleted = false;
  for (const scope of scopesFor(workspaceId)) {
    await mutateJsonArray<Serialized<ConstraintsModule>>(
      CONSTRAINTS_FILE,
      (rows) => rows.filter((r) => {
        if (r.id === id) { deleted = true; return false; }
        return true;
      }),
      scope,
    );
  }
  return deleted;
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
  await mutateJsonArray<Serialized<CapabilitiesModule>>(
    CAPABILITIES_FILE,
    (rows) => [...rows.filter((r) => r.id !== row.id), row],
    scope,
  );
}

export async function localDeleteCapabilitiesModule(id: string, workspaceId?: string | null): Promise<boolean> {
  let deleted = false;
  for (const scope of scopesFor(workspaceId)) {
    await mutateJsonArray<Serialized<CapabilitiesModule>>(
      CAPABILITIES_FILE,
      (rows) => rows.filter((r) => {
        if (r.id === id) { deleted = true; return false; }
        return true;
      }),
      scope,
    );
  }
  return deleted;
}
