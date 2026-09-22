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
  /** Canon virtual mount set (inherit/override chain). */
  fsMounts?: FsMounts;
}

export interface CategoryMountRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  folderPath: string | null;
  /** Canon virtual mount set (inherit/override chain). */
  fsMounts?: FsMounts;
}

export interface WorkspaceMountRecord {
  id: string;
  name: string;
  /** Zone A — workspace-local state. Never a mount target. */
  rootPath: string;
  /** Zone B — the mounted repository, or null when nothing is mounted. */
  mountPath: string | null;
  folderPath: string | null;
  /** Canon virtual mount set for this workspace (mode "default"). */
  fsMounts?: FsMounts;
}

export interface FsBrowseEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

// ─── Canon virtual mounts (mock-structure-polished) ──────────────────
// Mounts are described in VIRTUAL paths (what the agent sees inside its
// sandbox), not host paths: a workspace declares them with mode "default", and
// each category/channel either "inherit"s the parent level or "override"s it
// with its own list. Resolution walks channel → category → workspace and the
// FIRST override wins; with no override anywhere, the workspace default applies.
// Host paths are a separate concern: they still pass validateMountPath's jail.

/** Which level declared a mount set. */
export type FsMountScope = "workspace" | "category" | "channel";

/** "default" = the workspace's own set; "inherit" = follow the parent; "override" = use these. */
export type FsMountMode = "default" | "inherit" | "override";

export interface FsMount {
  id: string;
  /** Virtual path the mount is read from (e.g. "/workspace/repository"). */
  source: string;
  /** Virtual path the mount appears at (e.g. "/mnt/repository"). */
  target: string;
  /** Free-form kind: repository, local, artifact, ... */
  type: string;
  readOnly: boolean;
}

export interface FsMounts {
  scope: FsMountScope;
  mode: FsMountMode;
  mounts: FsMount[];
}

/**
 * The resolved mount set for one (workspace, channel) pair, plus the level that
 * supplied it — the panel labels mounts by origin, and an agent inherits the
 * same answer the panel shows.
 */
export interface EffectiveMounts {
  workspaceId: string | null;
  /** Level whose mounts won: channel > category > workspace (first override).
   *  "none" when nothing declared any mounts. */
  source: "channel" | "category" | "workspace" | "none";
  mounts: FsMount[];
  /** Why no mounts resolved, when a level declared an unusable set. */
  reason: string | null;
}
