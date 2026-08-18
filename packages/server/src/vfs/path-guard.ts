// ─── Path Guard ──────────────────────────────────────────────────────
// Prevents path traversal attacks and normalizes workspace-relative paths.

import { posix } from "node:path";

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

/**
 * Resolve a workspace-relative path to an absolute filesystem path.
 * Throws if the resolved path escapes the workspace root.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (!isPathSafe(relativePath)) {
    throw new Error(`Unsafe path detected: ${relativePath}`);
  }

  const normalized = normalizePath(relativePath);
  const resolved = posix.join(workspaceRoot.replace(/\\/g, "/"), normalized);

  // Double-check: resolved path must start with workspace root
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!resolved.startsWith(normalizedRoot)) {
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