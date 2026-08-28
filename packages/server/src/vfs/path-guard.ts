// ─── Path Guard ──────────────────────────────────────────────────────
// Prevents path traversal attacks and normalizes workspace-relative paths.

import { posix } from "node:path";
import { realpathSync } from "node:fs";
import { dirname as nativeDirname, resolve as nativeResolve } from "node:path";

/**
 * Normalize a workspace-relative path to POSIX format.
 * Strips leading slashes and resolves `.` / `..` segments.
 */
export function normalizePath(inputPath: string): string {
  // Convert backslashes to forward slashes
  let normalized = inputPath.replace(/\\/g, "/");

  // Resolve the path (collapses .. and .)
  normalized = posix.normalize(normalized);

  // Strip leading slashes to make it relative
  normalized = normalized.replace(/^\/+/, "");

  // Remove trailing slashes (unless root)
  normalized = normalized.replace(/\/+$/, "");

  return normalized || ".";
}

/**
 * Check if a path is safe (no traversal outside workspace root).
 * Returns false if the path escapes the workspace boundary.
 */
export function isPathSafe(inputPath: string): boolean {
  const normalized = normalizePath(inputPath);

  // Reject if it starts with ".." or contains "/../"
  if (normalized.startsWith("..") || normalized.includes("/../")) {
    return false;
  }

  // Reject null bytes
  if (inputPath.includes("\0")) {
    return false;
  }

  // Reject absolute paths (drive letters on Windows, leading / on Unix)
  if (/^[a-zA-Z]:/.test(inputPath) || inputPath.startsWith("/")) {
    // Allow a single leading "/" since we strip it in normalizePath
    const stripped = inputPath.replace(/^\/+/, "");
    if (/^[a-zA-Z]:/.test(stripped)) {
      return false;
    }
  }

  return true;
}

function toSlashed(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Anchored containment check (SEC-3): candidate must equal root or live
 * strictly under root + separator. Case-insensitive on Windows.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  const norm = (p: string): string => {
    const slashed = toSlashed(p).replace(/\/+$/, "");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const c = norm(candidate);
  const r = norm(root);
  if (!r) return false;
  if (c === r) return true;
  return c.startsWith(r + "/");
}

/**
 * Realpath-resolve a path that may not exist yet: realpath the deepest
 * existing ancestor, then rejoin the remaining segments lexically.
 */
function resolveRealDeep(target: string): string {
  try {
    return realpathSync(target);
  } catch (err: any) {
    if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
  }
  const segments: string[] = [];
  let current = nativeResolve(target);
  for (;;) {
    const parent = nativeDirname(current);
    if (parent === current) return toSlashed(nativeResolve(current, ...segments));
    segments.unshift(posix.basename(toSlashed(current)));
    try {
      const base = realpathSync(parent);
      return toSlashed(nativeResolve(base, ...segments));
    } catch (err: any) {
      if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      current = parent;
    }
  }
}

/**
 * Resolve a workspace-relative path to an absolute filesystem path.
 * Throws if the resolved path escapes the workspace root.
 * SEC-3 hardened: anchored prefix + symlink (realpath) escape rejection.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (!isPathSafe(relativePath)) {
    throw new Error(`Unsafe path detected: ${relativePath}`);
  }

  let rootReal = toSlashed(workspaceRoot).replace(/\/+$/, "");
  try {
    rootReal = toSlashed(realpathSync(workspaceRoot)).replace(/\/+$/, "");
  } catch {
    /* fall back to lexical root */
  }

  const normalized = normalizePath(relativePath);
  const joined = normalized === "." ? rootReal : posix.join(rootReal, normalized);

  let resolved: string;
  try {
    resolved = resolveRealDeep(joined);
  } catch {
    resolved = joined;
  }

  if (!isInsideRoot(resolved, rootReal)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }

  return resolved;
}

/**
 * Extract the file/directory name from a path.
 */
export function extractName(filePath: string): string {
  return posix.basename(normalizePath(filePath));
}

/**
 * Guess MIME type from file extension (basic mapping).
 */
export function guessMimeType(filePath: string): string | null {
  const ext = posix.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".json": "application/json",
    ".html": "text/html",
    ".css": "text/css",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".yml": "text/yaml",
    ".yaml": "text/yaml",
    ".xml": "application/xml",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".wasm": "application/wasm",
  };
  return mimeMap[ext] ?? null;
}