/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Renderer → main file-log forwarder (QA audit 2026-09-23: logs/desktop.log
// never existed because no renderer code called `crowdos:log:write`).
// Best-effort only: never throws, never spams — warn/error + unhandled
// rejections are teed to the main-process log so packaged builds keep
// support evidence on disk. No-op in plain browsers (no `window.crowdos`).

type logBridge = {
  invoke?: (channel: string, payload?: unknown) => Promise<unknown>;
};

function bridge(): logBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { crowdos?: logBridge }).crowdos;
  return candidate && typeof candidate.invoke === 'function' ? candidate : null;
}

function send(level: 'info' | 'warn' | 'error', message: string): void {
  const invoke = bridge()?.invoke;
  if (!invoke) return;
  try {
    void invoke('crowdos:log:write', { level, message: message.slice(0, 4000) });
  } catch {
    // never break the renderer on logging
  }
}

function toMessage(args: unknown[]): string {
  try {
    return args
      .map((a) => {
        if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
      .slice(0, 4000);
  } catch {
    return 'unserializable log payload';
  }
}

/** Tee console.warn/error + unhandled rejections into logs/desktop.log. */
export function installDesktopLogForwarder(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!bridge()) return () => {};
  if ((globalThis as unknown as { __crowdosLogFwd?: boolean }).__crowdosLogFwd) return () => {};
  (globalThis as unknown as { __crowdosLogFwd?: boolean }).__crowdosLogFwd = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    send('warn', toMessage(args));
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    send('error', toMessage(args));
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    try {
      send('error', `unhandledrejection: ${toMessage([e.reason])}`);
    } catch {
      // ignore
    }
  };
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    console.warn = origWarn;
    console.error = origError;
    window.removeEventListener('unhandledrejection', onRejection);
    (globalThis as unknown as { __crowdosLogFwd?: boolean }).__crowdosLogFwd = false;
  };
}
