// ─── Entry visibility ────────────────────────────────────────────────
// One rule for "is this directory entry listed", shared by the Repo tree
// (LocalFilesystem.list) and the mount picker (channel-mount-service.browseFs).
//
// Why this file exists: the two callers used to answer differently. The tree
// hid every dotfile, so a mounted repository's markers vanished; the picker
// un-hid three of them, so the same directory had two answers depending on
// which surface asked. The picker's intent is the better rule — a repo marker
// is exactly what a user browsing for a repository is looking for — so the
// tree adopts it.
//
// This is a LISTING rule, not a jail. Nothing here grants access: a caller
// that names a hidden path explicitly still resolves it through its own path
// guard. Hiding is a display decision, never a security boundary.

/**
 * Repo markers that stay visible despite the leading dot.
 *
 * `.crowdos` is CrowdOS's own workspace-local state directory (Zone A);
 * `.crowdosrc` and `.ThisCrowd` are repository markers. All three are
 * meaningful to a user choosing or reading a repository, which ordinary
 * dotfiles (editor config, caches) are not.
 */
export const REPO_MARKER_NAMES: readonly string[] = [".ThisCrowd", ".crowdos", ".crowdosrc"];

/** True when a directory entry should be listed. Hidden = display only. */
export function isVisibleEntryName(name: string): boolean {
  if (REPO_MARKER_NAMES.includes(name)) return true;
  return !name.startsWith(".");
}
