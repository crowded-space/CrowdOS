/**
 * Repo panel view model — the pure mapping from the server's filesystem
 * responses to what the tree renders.
 *
 * Deliberately free of React and fetch so the honest-state rules can be tested
 * on their own. The panel must never render an empty tree that could be mistaken
 * for an empty repository (`re-docs/UI UX Overhaul/03-overhaul-plan.md`, Phase 4
 * item 5), so every "nothing to show" case has to name its own cause.
 */

import type { FileNodeDto } from '@/src/api/client';

/** One row in the tree. */
export type repoEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  /** Lower-case extension without the dot; '' when the name carries none. */
  ext: string;
  size?: number;
};

/** Which level of the mount chain supplied the root being shown (§16). */
export type mountSource = 'channel' | 'category' | 'workspace' | 'workspace-local';

/** The part of `MountScope` the panel renders. */
export type mountScopeView = {
  path: string;
  zone: 'mounted' | 'workspace-local';
  source: mountSource;
  /** Why a configured mount could not be used; null when nothing is wrong. */
  reason: string | null;
  /** Zone A root for this workspace — its own directory, never a mount target. */
  workspaceRoot: string;
  /** Basename of `path`, for the header. */
  displayName: string;
};

/** What to show in place of the tree when the tree cannot be shown honestly. */
export type scopeFailure = { headline: string; detail: string };

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // `dot <= 0` covers both "no dot" and a leading-dot name such as `.crowdos`,
  // which is a marker rather than an extension.
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function toRepoEntry(raw: FileNodeDto): repoEntry {
  return {
    name: raw.name,
    path: raw.path,
    kind: raw.type === 'directory' ? 'directory' : 'file',
    ext: extensionOf(raw.name),
    size: raw.size,
  };
}

/** Tolerant of a missing or non-array body: a bad payload must not crash the panel. */
export function toRepoEntries(raw: FileNodeDto[] | null | undefined): repoEntry[] {
  return Array.isArray(raw) ? raw.map(toRepoEntry) : [];
}

/** Human label for `MountInfo.source` — the four values the resolver can return. */
export function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'channel':
      return 'Channel mount';
    case 'category':
      return 'Category mount';
    case 'workspace':
      return 'Workspace mount';
    case 'workspace-local':
      return 'Workspace sandbox';
    default:
      return 'Not mounted';
  }
}

/**
 * Why this root, in one line — §16's inheritance chain made visible. Without it
 * `source` is a label the user has to decode from memory.
 */
export function sourceHint(source: string | null | undefined): string {
  switch (source) {
    case 'channel':
      return 'Set on this channel. Overrides the category and workspace mounts.';
    case 'category':
      return 'Inherited from this channel\u2019s category.';
    case 'workspace':
      return 'Inherited from the workspace mount.';
    case 'workspace-local':
      return 'Nothing is mounted, so this is the workspace\u2019s own directory.';
    default:
      return 'No repository is mounted for this channel.';
  }
}

/**
 * A configured mount that could not be used. Rendered above the tree so the
 * user sees the cause instead of an unexplained fallback to the sandbox.
 */
export function mountWarning(scope: mountScopeView | null): scopeFailure | null {
  if (!scope?.reason) return null;
  return { headline: 'Mount unavailable', detail: scope.reason };
}

/** Honest copy for a listing that really is empty. */
export function emptyTreeMessage(scope: mountScopeView | null): string {
  if (!scope) return 'No directory to list.';
  if (scope.zone === 'mounted') return 'This repository has no visible entries.';
  return 'This workspace sandbox is empty.';
}

/**
 * Map a failed listing request to a cause the user can act on. `serverMessage`
 * is the route's own message, which already names the offending path.
 */
export function describeFetchFailure(
  status: number | null,
  serverMessage: string | null,
  fallbackPath: string | null,
): scopeFailure {
  const where = fallbackPath ? ` (${fallbackPath})` : '';
  if (status === 404) {
    return {
      headline: 'Folder not found',
      detail: serverMessage || `The folder this channel points at no longer exists${where}.`,
    };
  }
  if (status === 403) {
    return {
      headline: 'Outside the allowed folders',
      detail: serverMessage || `This folder is not inside the workspace\u2019s allowed mount roots${where}.`,
    };
  }
  if (status !== null && status >= 500) {
    return {
      headline: 'The server could not read this folder',
      detail: serverMessage || `The filesystem request failed${where}.`,
    };
  }
  return {
    headline: 'Could not load the repository',
    detail: serverMessage || `The filesystem request failed${where}.`,
  };
}

/**
 * Zone A is an L0 capability (`read_workspace_local`, `authLevelRequired: 0`),
 * so the panel offers it as its own labelled root only where an L0 agent exists
 * to reach it. There is no operator identity in the store yet, so the roster is
 * the only available proxy — see `02-filesystem-model.md` §7 requirement 3.
 */
export function hasL0Agent(agents: Array<{ level?: number; isOmniscient?: boolean }> | null | undefined): boolean {
  if (!Array.isArray(agents)) return false;
  return agents.some((agent) => agent.level === 0 || agent.isOmniscient === true);
}

/**
 * Which filesystem root a selected path belongs to. The viewer must thread
 * this through the existing content transport — a Zone A path read through
 * the effective root would resolve a different directory under the same path.
 */
export type sandboxRoot = 'effective' | 'workspace-local';

/** True for Zone A paths, which the viewer renders read-only (L0 badge + no-save guard). */
export function isWorkspaceLocalRoot(root: sandboxRoot | string | null | undefined): boolean {
  return root === 'workspace-local';
}

/** Short human label naming which root an open path belongs to. */
export function sandboxRootLabel(root: sandboxRoot | string | null | undefined): string {
  return root === 'workspace-local' ? 'Workspace Local' : 'Repository';
}

/** One visible row of the tree, with the a11y set info it needs. */
export type treeRow = {
  entry: repoEntry;
  /** 1-based, for `aria-level` (a tree's root rows are level 1). */
  level: number;
  /** 1-based index among its siblings, for `aria-posinset`. */
  posInSet: number;
  /** Number of siblings, for `aria-setsize`. */
  setSize: number;
  expanded: boolean;
};

/**
 * Flatten the tree to the rows actually on screen. Arrow-key navigation needs
 * the visible order, and `aria-setsize`/`aria-posinset` must describe siblings
 * rather than the whole tree, so neither can be derived from the DOM afterwards.
 *
 * A directory that is expanded but has no loaded children contributes one row
 * and nothing else — the caller renders its loading or empty state from the
 * separate `childrenByPath` entry, which keeps this function pure.
 */
export function flattenTree(
  roots: repoEntry[],
  childrenByPath: Record<string, repoEntry[] | undefined>,
  expanded: ReadonlySet<string>,
): treeRow[] {
  const rows: treeRow[] = [];
  const walk = (siblings: repoEntry[], level: number) => {
    siblings.forEach((entry, index) => {
      const isDirectory = entry.kind === 'directory';
      const isExpanded = isDirectory && expanded.has(entry.path);
      rows.push({
        entry,
        level,
        posInSet: index + 1,
        setSize: siblings.length,
        expanded: isExpanded,
      });
      if (isExpanded) walk(childrenByPath[entry.path] ?? [], level + 1);
    });
  };
  walk(roots, 1);
  return rows;
}
