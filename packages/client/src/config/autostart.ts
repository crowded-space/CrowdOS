/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Launch-on-login via the desktop shell (`crowdos:autostart:get/set`).
// No-op in browsers: returns null so callers render nothing.

type autostartBridge = {
  invoke?: (channel: string, payload?: unknown) => Promise<unknown>;
};

function bridge(): autostartBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { crowdos?: autostartBridge }).crowdos;
  return candidate && typeof candidate.invoke === 'function' ? candidate : null;
}

export function canAutostart(): boolean {
  return bridge() !== null;
}

export async function getAutostart(): Promise<boolean | null> {
  try {
    const res = (await bridge()?.invoke?.('crowdos:autostart:get')) as
      | { enabled?: boolean }
      | undefined;
    return typeof res?.enabled === 'boolean' ? res.enabled : null;
  } catch {
    return null;
  }
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  try {
    const res = (await bridge()?.invoke?.('crowdos:autostart:set', { enabled })) as
      | { enabled?: boolean }
      | undefined;
    return res?.enabled === enabled;
  } catch {
    return false;
  }
}
