// ─── Workspace Runtime Config (canon: vfs/.crowdos/workspace.json) ─────
// The per-workspace runtime object, exactly as mock-structure-polished defines
// it. This file holds ONLY runtime policy:
//
//   {
//     "workspace": {
//       "id", "name", "createdAt",
//       "permissions": { network, shell, maxAgents },
//       "constraints": { networkAccess, shellExecution, memoryLimitMb, cpuLimit },
//       "artifactDir": "vfs/artifacts",
//       "fsMounts": { scope, mode, mounts: [...] }
//     }
//   }
//
// Categories and channels are NOT embedded here (they own their own files next
// to this one). The registry record stays the portal/hub truth; this object is
// the workspace's own runtime view, and artifact generation reads artifactDir
// from it so the default path lives with the workspace that owns it.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ARTIFACT_DIR, normalizeArtifactDir, resolveCrowdosDir } from "./workspace-paths.js";
// Folder resolution goes through the shared local-file resolver so this module
// agrees with every other local store (registry rootPath, else the display-name
// folder under the sandbox base, and the test override when one is set).
import { resolveWorkspaceFolderSync } from "../shared/core/local-file.js";

export interface WorkspacePermissions {
  network: boolean;
  shell: boolean;
  maxAgents: number;
}

export interface RuntimeConstraints {
  networkAccess: boolean;
  shellExecution: boolean;
  memoryLimitMb: number;
  cpuLimit: number;
}

/** Canon virtual mount descriptor (mirrors channel-mount-types). */
export interface WorkspaceFsMount {
  id: string;
  source: string;
  target: string;
  type: string;
  readOnly: boolean;
}

export interface WorkspaceFsMounts {
  scope: "workspace" | "category" | "channel";
  mode: "default" | "inherit" | "override";
  mounts: WorkspaceFsMount[];
}

export interface WorkspaceRuntimeConfig {
  id: string;
  name: string;
  createdAt: string;
  permissions: WorkspacePermissions;
  constraints: RuntimeConstraints;
  artifactDir: string;
  fsMounts: WorkspaceFsMounts;
}

export const DEFAULT_WORKSPACE_PERMISSIONS: WorkspacePermissions = {
  network: false,
  shell: false,
  maxAgents: 8,
};

export const DEFAULT_RUNTIME_CONSTRAINTS: RuntimeConstraints = {
  networkAccess: false,
  shellExecution: true,
  memoryLimitMb: 512,
  cpuLimit: 1,
};

export function defaultWorkspaceRuntimeConfig(input: {
  id: string;
  name?: string;
  createdAt?: string;
}): WorkspaceRuntimeConfig {
  return {
    id: input.id,
    name: input.name?.trim() || input.id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    permissions: { ...DEFAULT_WORKSPACE_PERMISSIONS },
    constraints: { ...DEFAULT_RUNTIME_CONSTRAINTS },
    artifactDir: DEFAULT_ARTIFACT_DIR,
    fsMounts: { scope: "workspace", mode: "default", mounts: [] },
  };
}

function runtimeConfigPath(workspaceFolder: string): string {
  return join(resolveCrowdosDir(workspaceFolder), "workspace.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Normalize a stored runtime object; malformed fields fall back to canon defaults. */
function normalize(raw: unknown, id: string): WorkspaceRuntimeConfig {
  const base = defaultWorkspaceRuntimeConfig({ id });
  if (!isRecord(raw)) return base;
  const inner = isRecord(raw.workspace) ? raw.workspace : raw;
  const permissions = isRecord(inner.permissions) ? inner.permissions : {};
  const constraints = isRecord(inner.constraints) ? inner.constraints : {};
  const fsMounts = isRecord(inner.fsMounts) ? inner.fsMounts : {};
  const mounts = Array.isArray(fsMounts.mounts)
    ? fsMounts.mounts.filter(isRecord).map((m) => ({
        id: typeof m.id === "string" ? m.id : "",
        source: typeof m.source === "string" ? m.source : "",
        target: typeof m.target === "string" ? m.target : "",
        type: typeof m.type === "string" ? m.type : "local",
        readOnly: m.readOnly === true,
      })).filter((m) => m.id && m.source && m.target)
    : [];
  return {
    id: typeof inner.id === "string" && inner.id.trim() ? inner.id : id,
    name: typeof inner.name === "string" && inner.name.trim() ? inner.name : base.name,
    createdAt: typeof inner.createdAt === "string" && inner.createdAt ? inner.createdAt : base.createdAt,
    permissions: {
      network: permissions.network === true,
      shell: permissions.shell === true,
      maxAgents: typeof permissions.maxAgents === "number" && permissions.maxAgents > 0
        ? Math.floor(permissions.maxAgents)
        : base.permissions.maxAgents,
    },
    constraints: {
      networkAccess: constraints.networkAccess === true,
      shellExecution: constraints.shellExecution !== false,
      memoryLimitMb: typeof constraints.memoryLimitMb === "number" && constraints.memoryLimitMb > 0
        ? Math.floor(constraints.memoryLimitMb)
        : base.constraints.memoryLimitMb,
      cpuLimit: typeof constraints.cpuLimit === "number" && constraints.cpuLimit > 0
        ? constraints.cpuLimit
        : base.constraints.cpuLimit,
    },
    artifactDir: normalizeArtifactDir(typeof inner.artifactDir === "string" ? inner.artifactDir : null),
    fsMounts: {
      scope: "workspace",
      mode: fsMounts.mode === "inherit" || fsMounts.mode === "override" ? fsMounts.mode : "default",
      mounts,
    },
  };
}

/**
 * Read a workspace's runtime object. A missing file yields canon defaults, so
 * callers never have to branch on "does this workspace have a config yet".
 */
export async function readWorkspaceRuntimeConfig(
  workspaceId: string,
  fallbackName?: string,
): Promise<WorkspaceRuntimeConfig> {
  const folder = resolveWorkspaceFolderSync(workspaceId);
  try {
    const raw = await fs.readFile(runtimeConfigPath(folder), "utf8");
    const parsed = normalize(JSON.parse(raw), workspaceId);
    return fallbackName && parsed.name === workspaceId ? { ...parsed, name: fallbackName } : parsed;
  } catch {
    return defaultWorkspaceRuntimeConfig({ id: workspaceId, name: fallbackName });
  }
}

/** Merge a patch into the runtime object and write it back (canon wrapper). */
export async function writeWorkspaceRuntimeConfig(
  workspaceId: string,
  patch: Partial<Omit<WorkspaceRuntimeConfig, "id">>,
  fallbackName?: string,
): Promise<WorkspaceRuntimeConfig> {
  const current = await readWorkspaceRuntimeConfig(workspaceId, fallbackName);
  const next: WorkspaceRuntimeConfig = {
    ...current,
    ...patch,
    id: current.id,
    permissions: { ...current.permissions, ...(patch.permissions ?? {}) },
    constraints: { ...current.constraints, ...(patch.constraints ?? {}) },
    fsMounts: patch.fsMounts ?? current.fsMounts,
    artifactDir: normalizeArtifactDir(patch.artifactDir ?? current.artifactDir),
  };
  const folder = resolveWorkspaceFolderSync(workspaceId);
  const file = runtimeConfigPath(folder);
  await fs.mkdir(join(folder, "vfs", ".crowdos"), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ workspace: next }, null, 2), "utf8");
  return next;
}
