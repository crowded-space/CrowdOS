// ─── Per-workspace browser sessions (single actor) ────────────────────
// One browser + one page per workspace. Every command for a workspace runs on
// that workspace's promise chain, in call order: two tool calls can never drive
// the same page concurrently (Playwright page operations are not reentrant).

import { join } from "node:path";
import { resolveLocalStoreDir } from "../shared/core/local-file.js";
import { getBrowserLauncher } from "./browser-launcher.js";
import type { browserHandle, browserPage } from "./browser-types.js";

/** `<workspaceFolder>/vfs/.crowdos/browser/profile` — persistent browser state. */
export function resolveBrowserProfileDir(workspaceId?: string | null): string {
  return join(resolveLocalStoreDir(workspaceId), "browser", "profile");
}

interface browserSession {
  handle: browserHandle | null;
  queue: Promise<unknown>;
}

const sessions = new Map<string, browserSession>();

function sessionFor(workspaceId: string): browserSession {
  let session = sessions.get(workspaceId);
  if (!session) {
    // The entry is registered synchronously, so two concurrent first commands
    // share one session (and one page) instead of racing to open two browsers.
    session = { handle: null, queue: Promise.resolve() };
    sessions.set(workspaceId, session);
  }
  return session;
}

/**
 * Serialize one page command for a workspace. A rejected command still reaches
 * its caller, but the chain itself continues — one failed navigation must not
 * wedge the workspace's browser for every later call.
 */
export function enqueueCommand<T>(
  workspaceId: string,
  task: (page: browserPage) => Promise<T>,
): Promise<T> {
  const session = sessionFor(workspaceId);
  const run = async (): Promise<T> => {
    if (!session.handle) {
      session.handle = await getBrowserLauncher()(resolveBrowserProfileDir(workspaceId));
    }
    return task(session.handle.page);
  };
  const next = session.queue.then(run, run);
  session.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Run a command only when the workspace browser is ALREADY open; never launches.
 * Returns null when there is no current session (closed, or closed mid-queue).
 */
export async function enqueueIfOpen<T>(
  workspaceId: string,
  task: (page: browserPage) => Promise<T>,
): Promise<T | null> {
  const session = sessions.get(workspaceId);
  if (!session) return null;
  const run = async (): Promise<T | null> => {
    // closeWorkspaceSession deletes the entry before draining the queue. The
    // identity check keeps a queued state read from resurrecting a browser that
    // was closed while the read waited — the same leak class enqueueCommand's
    // captured-session check fixed.
    if (sessions.get(workspaceId) !== session || !session.handle) return null;
    return task(session.handle.page);
  };
  const next = session.queue.then(run, run);
  session.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Close one workspace's browser. Best-effort: shutdown must never throw. */
export async function closeWorkspaceSession(workspaceId: string): Promise<void> {
  const session = sessions.get(workspaceId);
  if (!session) return;
  // Drop the entry first so a later command opens a fresh session instead of
  // queueing behind a browser that is about to close.
  sessions.delete(workspaceId);
  try {
    await session.queue;
  } catch {}
  try {
    if (session.handle) await session.handle.close();
  } catch {}
}

/** Close every workspace browser. Best-effort: never throws. */
export async function closeAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => closeWorkspaceSession(id).catch(() => undefined)));
}

/** Test helper: close everything so no fake handle survives into the next test. */
export async function resetBrowserSessionsForTests(): Promise<void> {
  await closeAllSessions();
}
