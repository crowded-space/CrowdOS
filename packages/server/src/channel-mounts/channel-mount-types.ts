export interface MountInfo {
  workspaceId: string | null;
  /** Zone B — the mounted repository, or null when nothing is mounted. */
  mountedPath: string | null;
  source: "channel" | "category" | "workspace" | "none";
  /**
   * Why the mount resolved the way it did. Populated when a path WAS configured
   * but could not be used (missing, not a directory, outside the allowed roots)
   * so the Right Panel can show an honest error instead of an empty tree that
   * looks like an empty repository.
   */
  reason?: string | null;
}

/**
 * The one answer to "which directory does this (workspace, channel) work in".
 *
 * Every consumer — the Repo panel, `tool-registry`, `coding-runtime`,
 * `runs-gate` — must resolve through this shape, or the panel and the agents
 * silently disagree the moment a mount is set.
 */
export interface EffectiveRoot {
  /** Absolute path the consumer must treat as its root. */
  path: string;
  /** `mounted` = Zone B (the user's repo). `workspace-local` = Zone A. */
  zone: "mounted" | "workspace-local";
  /** Which level supplied a mounted root, or `workspace-local` for Zone A. */
  source: "channel" | "category" | "workspace" | "workspace-local";
  /**
   * Why this is not the mounted repo, when a mount WAS configured but could
   * not be used (missing directory, outside the jail). Null when there was
   * simply nothing mounted. Lets the panel explain an empty tree instead of
   * showing one that looks like an empty repository.
   */
  reason: string | null;
}

/**
 * What the Repo panel renders: the effective root plus the Zone A sibling it
 * would fall back to. Carrying both is what lets the header say "mounted from
 * channel #general" versus "workspace sandbox" without a second round trip.
 */
export interface MountScope extends EffectiveRoot {
  /** Zone A root for this workspace — its own directory, never a mount target. */
  workspaceRoot: string;
  /** Basename of `path`, for panel headers. */
  displayName: string;
}

export interface ChannelMountRecord {
  id: string;
  workspaceId: string | null;
  categoryId: string | null;
  name: string;
  folderPath: string | null;
}

export interface CategoryMountRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  folderPath: string | null;
}

export interface WorkspaceMountRecord {
  id: string;
  name: string;
  /** Zone A — workspace-local state. Never a mount target. */
  rootPath: string;
  /** Zone B — the mounted repository, or null when nothing is mounted. */
  mountPath: string | null;
  folderPath: string | null;
}

export interface FsBrowseEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}
