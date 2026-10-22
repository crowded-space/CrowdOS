// ─── Agent Runtime Override Local Store (local tier runtime patches) ─────
// File truth for runtime overrides (live patches of an agent's operating
// instructions) when the workspace tier is local. The PG `runtime_overrides`
// table has no local tier, so a local-first workspace could not patch an
// agent's instructions at runtime at all.
//
// Canon: one JSON array file per workspace inside the runtime store:
//
//   <workspaceFolder>/vfs/.crowdos/runtime-overrides.json
//
// Rows mirror the PG columns (id/targetAgentId/overrideType/instructionPatch/
// permissionPatch/createdBy/expiresAt/createdAt) so the two tiers stay
// comparable. Dates are ISO strings — the same shape the PG timestamp columns
// serialize to over JSON.
//
// Scope hygiene (mirrors the instruction-stack store): production callers must
// name the workspace — an unscoped write would silently file the row under the
// "default" folder. Unit tests are exempt: their explicit per-test store dir
// (setLocalStoreDirForTests) makes unscoped writes a documented fixture
// mechanism, not production traffic.

import {
  DEFAULT_WORKSPACE_SCOPE,
  isTestStoreDir,
  mutateJsonArray,
  readJsonArray,
  searchableWorkspaceScopes,
} from "../shared/core/local-file.js";
import type { InstructionPatch, PermissionPatch } from "../types/runtime.types.js";

/** Mirror of the PG `runtime_override_type` enum. */
export type RuntimeOverrideType = "runtime_patch" | "temp_permission" | "context_inject";

/** One runtime override row (ISO date strings, like the PG rows on the wire). */
export interface LocalRuntimeOverride {
  id: string;
  targetAgentId: string;
  overrideType: RuntimeOverrideType;
  instructionPatch?: InstructionPatch | null;
  permissionPatch?: PermissionPatch | null;
  createdBy: string;
  /** ISO date string; null = never expires. */
  expiresAt: string | null;
  /** ISO date string. */
  createdAt: string;
}

/** Write input: `id` and `createdAt` are minted when the caller omits them. */
export type LocalRuntimeOverrideInput = Omit<
  LocalRuntimeOverride,
  "id" | "createdAt" | "expiresAt"
> & {
  id?: string;
  createdAt?: string;
  expiresAt?: string | null;
};

const OVERRIDE_FILE = "runtime-overrides.json";

/** Effective scope for a write. Named scope, the test-dir placeholder, or null. */
function writeScope(workspaceId?: string | null): string | null {
  const trimmed = workspaceId?.trim();
  if (trimmed) return trimmed;
  if (isTestStoreDir()) return DEFAULT_WORKSPACE_SCOPE;
  return null;
}

/** Scopes a read may visit: the named workspace, or every known one. */
function scopesFor(workspaceId?: string | null): Array<string | null> {
  const trimmed = workspaceId?.trim();
  if (trimmed) return [trimmed];
  return searchableWorkspaceScopes();
}

/**
 * Expired = the row carries an expiry and it is in the past. An unparseable
 * date is NOT expired (the PG path compares the same way: an invalid Date
 * never compares less-than now).
 */
function isExpired(row: LocalRuntimeOverride, now: number): boolean {
  if (!row.expiresAt) return false;
  const at = new Date(row.expiresAt).getTime();
  return Number.isFinite(at) && at < now;
}

/**
 * Override id: agent-scoped prefix + base36 timestamp + zero-padded counter.
 * Ids sort in creation order, so the "append order by override id" the patch
 * semantics rely on is the order the operator wrote them in.
 */
let overrideSeq = 0;
function mintOverrideId(agentId: string): string {
  overrideSeq = (overrideSeq + 1) % 10000;
  return `rov_${agentId}_${Date.now().toString(36)}_${String(overrideSeq).padStart(4, "0")}`;
}

/**
 * Active (not expired) overrides for one agent, ascending id — the local
 * mirror of the PG `orderBy(id)` read. Expired rows are filtered out here;
 * localSweepExpiredRuntimeOverrides removes them from disk.
 */
export async function localListRuntimeOverrides(
  agentId: string,
  workspaceId?: string | null,
): Promise<LocalRuntimeOverride[]> {
  const now = Date.now();
  const byId = new Map<string, LocalRuntimeOverride>();
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<LocalRuntimeOverride>(OVERRIDE_FILE, scope).catch(
      () => [] as LocalRuntimeOverride[],
    );
    for (const row of rows) {
      if (!row || row.targetAgentId !== agentId) continue;
      if (isExpired(row, now)) continue;
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Create or replace one override for an agent. The id and createdAt are
 * minted when the caller omits them. The write is all-or-nothing under the
 * file lock, and only ever replaces a row of the SAME agent (an id is scoped
 * by its agent, never globally).
 */
export async function localUpsertRuntimeOverride(
  input: LocalRuntimeOverrideInput,
  workspaceId?: string | null,
): Promise<LocalRuntimeOverride> {
  const scope = writeScope(workspaceId);
  if (!scope) {
    throw new Error(
      "localUpsertRuntimeOverride: workspaceId is required when writing a runtime override (refusing to write to the 'default' scope)",
    );
  }
  const row: LocalRuntimeOverride = {
    id: input.id?.trim() || mintOverrideId(input.targetAgentId),
    targetAgentId: input.targetAgentId,
    overrideType: input.overrideType,
    instructionPatch: input.instructionPatch ?? null,
    permissionPatch: input.permissionPatch ?? null,
    createdBy: input.createdBy,
    expiresAt: input.expiresAt ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  await mutateJsonArray<LocalRuntimeOverride>(
    OVERRIDE_FILE,
    (rows) => [
      ...rows.filter((r) => !(r.id === row.id && r.targetAgentId === row.targetAgentId)),
      row,
    ],
    scope,
  );
  return row;
}

/**
 * Delete one override of one agent. Scoped by agent AND id: an id is only
 * unique inside its agent, and a delete must never cross agents.
 */
export async function localDeleteRuntimeOverride(
  agentId: string,
  id: string,
  workspaceId?: string | null,
): Promise<boolean> {
  const scope = writeScope(workspaceId);
  if (!scope) return false;
  const rows = await readJsonArray<LocalRuntimeOverride>(OVERRIDE_FILE, scope);
  if (!rows.some((r) => r.targetAgentId === agentId && r.id === id)) return false;
  let deleted = false;
  await mutateJsonArray<LocalRuntimeOverride>(
    OVERRIDE_FILE,
    (current) =>
      current.filter((r) => {
        if (r.targetAgentId === agentId && r.id === id) {
          deleted = true;
          return false;
        }
        return true;
      }),
    scope,
  );
  return deleted;
}

/**
 * Expiry sweep: drop the agent's expired overrides — the local mirror of the
 * PG "delete where id in (expiredIds)" pass. The file is only rewritten when
 * something is actually expired, so a clean workspace keeps no empty file.
 */
export async function localSweepExpiredRuntimeOverrides(
  agentId: string,
  workspaceId?: string | null,
): Promise<number> {
  const scope = writeScope(workspaceId);
  if (!scope) return 0;
  const now = Date.now();
  const rows = await readJsonArray<LocalRuntimeOverride>(OVERRIDE_FILE, scope);
  if (!rows.some((r) => r.targetAgentId === agentId && isExpired(r, now))) return 0;
  let removed = 0;
  await mutateJsonArray<LocalRuntimeOverride>(
    OVERRIDE_FILE,
    (current) =>
      current.filter((r) => {
        if (r.targetAgentId !== agentId || !isExpired(r, now)) return true;
        removed += 1;
        return false;
      }),
    scope,
  );
  return removed;
}
