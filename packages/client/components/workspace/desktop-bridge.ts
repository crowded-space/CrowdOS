/**
 * The desktop shell's `window.crowdos` bridge, behind one typed wrapper.
 *
 * The bridge is absent in a plain browser, so every caller has to branch on its
 * presence; keeping the shape (and its legacy variants) in one place stops the
 * mount UI from each re-deriving it — and stops an `any` cast spreading.
 *
 * Contract: `packages/desktop/preload/bridge.ts` (`PickDirectoryResult`) over the
 * `crowdos:dialog:openDirectory` IPC channel, titled "Select Repository Root".
 */

/** Mirrors the desktop bridge's own `PickDirectoryResult`: cancel → null path. */
export type pickDirectoryOutcome = { canceled: boolean; path: string | null };

type crowdosBridge = {
  pickDirectory?: (opts?: { initialPath?: string }) => Promise<unknown>;
};

function bridge(): crowdosBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { crowdos?: crowdosBridge }).crowdos;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

/** Whether the native OS folder dialog is reachable from this renderer. */
export function canPickDirectoryNative(): boolean {
  return typeof bridge()?.pickDirectory === 'function';
}

/**
 * Open the native folder dialog. Normalizes the raw IPC payload: the current
 * bridge returns `{ canceled, path }`, but a bare string or an Electron
 * `{ filePaths }` result must not be mistaken for a cancellation.
 */
export async function pickDirectoryNative(initialPath?: string | null): Promise<pickDirectoryOutcome> {
  const pick = bridge()?.pickDirectory;
  if (typeof pick !== 'function') return { canceled: true, path: null };
  const raw = await pick(initialPath ? { initialPath } : undefined);
  if (typeof raw === 'string') {
    return raw ? { canceled: false, path: raw } : { canceled: true, path: null };
  }
  if (raw && typeof raw === 'object') {
    const record = raw as { canceled?: boolean; path?: unknown; filePaths?: unknown };
    const direct = typeof record.path === 'string' ? record.path : null;
    const fromList = Array.isArray(record.filePaths) && typeof record.filePaths[0] === 'string'
      ? record.filePaths[0]
      : null;
    const picked = direct || fromList;
    if (picked) return { canceled: false, path: picked };
  }
  return { canceled: true, path: null };
}