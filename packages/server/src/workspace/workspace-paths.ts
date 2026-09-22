// ─── Workspace Folder Paths (canon: mock-structure-polished) ──────────
// One workspace = one display-name folder:
//
//   <sandboxBase>/<folderName>/
//     workspace.json              <- singular registry copy, rootPath "."
//     vfs/
//       .crowdos/
//         workspace.json          <- runtime only (permissions, constraints, artifactDir, fsMounts)
//         categories.json         <- ONLY place for categories
//         channels.json           <- ONLY place for channels
//         cache/ runtime/ snapshots/
//       agents/<agentId>.json      <- one file per agent, single object
//       artifacts/                 <- plain file storage, no index
//       src/
//
// Global workspaces.json stays the portal/hub index and wins on load; the
// per-folder copies are rewritten from it. vfs/ is a local config sandbox only
// and is NEVER a mount target for user repositories.

import { join, resolve } from "node:path";

/** Windows device names a folder must never use (case-insensitive). */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Default folder-relative artifact directory (canon). */
export const DEFAULT_ARTIFACT_DIR = "vfs/artifacts";

/**
 * Sanitize a workspace display name into a browsable folder name.
 *
 * Display names are free text; folder names are not. Only characters illegal
 * on Windows/macOS are stripped, so "CrowdOS Nightly" stays readable instead
 * of becoming a slug.
 */
export function sanitizeWorkspaceFolderName(name: string): string {
  const trimmed = (name ?? "").trim() || "workspace";
  let out = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  out = out.replace(/[. ]+$/g, "").trim();
  if (!out) out = "workspace";
  if (out.length > 80) out = out.slice(0, 80).trim() || "workspace";
  if (WINDOWS_RESERVED.has(out.toLowerCase())) out = `${out}-workspace`;
  // The global index file owns this name at the workspaces root.
  if (out.toLowerCase() === "workspaces.json") out = "workspace";
  return out;
}

/** Absolute workspace folder: <sandboxBase>/<folderName>. */
export function resolveWorkspaceFolderPath(sandboxBase: string, folderName: string): string {
  return resolve(sandboxBase, folderName);
}

/** Absolute vfs dir: <folder>/vfs. Local config sandbox, never a mount target. */
export function resolveVfsDir(workspaceFolder: string): string {
  return join(resolve(workspaceFolder), "vfs");
}

/** Absolute runtime config dir: <folder>/vfs/.crowdos. */
export function resolveCrowdosDir(workspaceFolder: string): string {
  return join(resolveVfsDir(workspaceFolder), ".crowdos");
}

/** Absolute agents dir: <folder>/vfs/agents. */
export function resolveAgentsDir(workspaceFolder: string): string {
  return join(resolveVfsDir(workspaceFolder), "agents");
}

/** Absolute src dir: <folder>/vfs/src. */
export function resolveSrcDir(workspaceFolder: string): string {
  return join(resolveVfsDir(workspaceFolder), "src");
}

/**
 * Absolute artifacts dir: <folder>/<artifactDir> (folder-relative).
 * An absolute or traversal artifactDir is refused — the canon path is
 * folder-relative so generation can never escape the workspace folder.
 */
export function resolveArtifactsDir(workspaceFolder: string, artifactDir?: string | null): string {
  const rel = (artifactDir ?? "").trim() || DEFAULT_ARTIFACT_DIR;
  if (/^([a-zA-Z]:|[\\/])/.test(rel) || rel.includes("..")) return resolve(workspaceFolder, DEFAULT_ARTIFACT_DIR);
  return resolve(workspaceFolder, rel);
}

/**
 * Registry path for a workspace's artifact directory, in the relative form the
 * canon stores: "vfs/artifacts".
 */
export function normalizeArtifactDir(artifactDir?: string | null): string {
  const rel = (artifactDir ?? "").trim() || DEFAULT_ARTIFACT_DIR;
  if (/^([a-zA-Z]:|[\\/])/.test(rel) || rel.includes("..")) return DEFAULT_ARTIFACT_DIR;
  return rel.replace(/\\/g, "/");
}

/** Store an absolute path as folder-relative (for DB rows and file copies). */
export function toFolderRelative(absolutePath: string, workspaceFolder: string): string {
  const folder = resolve(workspaceFolder);
  const abs = resolve(absolutePath);
  const withSep = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p : p + "\\");
  const prefix = withSep(folder);
  const altPrefix = withSep(folder).replace(/\\/g, "/");
  let rel = abs;
  if (abs.startsWith(prefix)) rel = abs.slice(prefix.length);
  else if (abs.startsWith(altPrefix)) rel = abs.slice(altPrefix.length);
  return rel.replace(/\\/g, "/");
}
