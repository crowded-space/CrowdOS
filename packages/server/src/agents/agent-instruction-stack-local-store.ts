// ─── Agent Instruction Stack Local Store (studio manifest local/db decoupling) ─
// File truth for per-agent instruction stacks when the workspace tier is
// local (no database record). The PG `agent_instruction_stacks` table has no
// local tier, so the manifest read/write path 500'd every local-only
// workspace with a bare getDb() throw.
//
// Canon: one JSON array file per workspace inside the runtime store (same
// layout as the module catalogs):
//
//   <workspaceFolder>/vfs/.crowdos/instruction-stacks.json
//
// Rows mirror the PG columns (id/agentId/instructionModuleId/priorityOrder/
// isEnabled) so service results keep one shape across tiers. A workspace id
// scopes every read and write; without one, reads fan out (the stack lookup
// by agent id has no other way to know which folder owns the agent).
//
// Scope hygiene (mirrors the module store): production callers must name the
// workspace — an unscoped replace would silently file the stack under the
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

export interface LocalInstructionStackLink {
  id: string;
  agentId: string;
  instructionModuleId: string;
  priorityOrder: number;
  isEnabled: boolean;
}

const STACK_FILE = "instruction-stacks.json";

/**
 * Effective scope for a replace. Returns the trimmed scope, the bare
 * "default" placeholder under vitest fixtures, or null to refuse the write.
 */
function replaceScope(workspaceId?: string | null): string | null {
  const trimmed = workspaceId?.trim();
  if (trimmed) return trimmed;
  if (isTestStoreDir()) return DEFAULT_WORKSPACE_SCOPE;
  return null;
}

/** Every workspace folder a lookup should search when no scope was given. */
function scopesFor(workspaceId?: string | null): Array<string | null> {
  const trimmed = workspaceId?.trim();
  if (trimmed) return [trimmed];
  return searchableWorkspaceScopes();
}

/**
 * Enabled stack links for one agent, ascending priorityOrder (mirrors the PG
 * orderBy). A named scope reads one folder; an unscoped read merges every
 * registered workspace by link id.
 */
export async function localListInstructionStackLinks(
  agentId: string,
  workspaceId?: string | null,
): Promise<LocalInstructionStackLink[]> {
  const byId = new Map<string, LocalInstructionStackLink>();
  for (const scope of scopesFor(workspaceId)) {
    const rows = await readJsonArray<LocalInstructionStackLink>(STACK_FILE, scope).catch(
      () => [] as LocalInstructionStackLink[],
    );
    for (const row of rows) {
      if (!row || row.agentId !== agentId || !row.isEnabled) continue;
      if (typeof row.instructionModuleId !== "string") continue;
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => a.priorityOrder - b.priorityOrder);
}

/**
 * All-or-nothing local replace: the whole stack for the agent in the owning
 * folder is swapped under one file lock. Ids and priority steps mirror the
 * PG writer (`ais_<agent>_<n>_<now>`, steps of 10) so rows stay comparable
 * across tiers.
 */
export async function localReplaceInstructionStack(
  agentId: string,
  instructionModuleIds: string[],
  workspaceId?: string | null,
): Promise<LocalInstructionStackLink[]> {
  const scope = replaceScope(workspaceId);
  if (!scope) {
    throw new Error(
      "localReplaceInstructionStack: workspaceId is required when replacing a stack (refusing to write to the 'default' scope)",
    );
  }
  const now = Date.now().toString(36);
  const next = instructionModuleIds.map((instructionModuleId, i) => ({
    id: `ais_${agentId}_${i + 1}_${now}`,
    agentId,
    instructionModuleId,
    priorityOrder: (i + 1) * 10,
    isEnabled: true,
  }));
  await mutateJsonArray<LocalInstructionStackLink>(
    STACK_FILE,
    (rows) => [...rows.filter((r) => r.agentId !== agentId), ...next],
    scope,
  );
  return next;
}
