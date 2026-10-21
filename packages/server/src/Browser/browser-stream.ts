// ─── Live browser view (B3) ───────────────────────────────────────────
// One 1 fps JPEG loop per workspace, owned by this domain so every read of the
// page stays in the single actor. The socket server refcounts subscribers and
// injects a sink: a sink per socket would emit duplicate frames to the room.
// The loop uses `enqueueIfOpen`, so a closed browser costs no capture and no
// launch — it reports one change-only `open: false` state instead.

import { enqueueIfOpen } from "./browser-session.js";

const STREAM_INTERVAL_MS = 1000;
const STREAM_QUALITY = 60;

export type browserFrame = {
  workspaceId: string;
  mimeType: "image/jpeg";
  data: string;
  ts: number;
};

export type browserStreamState = {
  workspaceId: string;
  open: boolean;
  url: string | null;
  title: string | null;
};

export type browserStreamSink = {
  onFrame(frame: browserFrame): void;
  onState(state: browserStreamState): void;
};

interface browserStreamEntry {
  sink: browserStreamSink;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastState: string | null;
}

const streams = new Map<string, browserStreamEntry>();

/** Emit only when `{open,url,title}` changed; a dead sink must not kill the loop. */
function emitState(entry: browserStreamEntry, state: browserStreamState): void {
  const serialized = JSON.stringify({ open: state.open, url: state.url, title: state.title });
  if (serialized === entry.lastState) return;
  entry.lastState = serialized;
  try {
    entry.sink.onState(state);
  } catch {
    // The sink is a socket emitter; a closed transport is not a stream error.
  }
}

async function tick(entry: browserStreamEntry, workspaceId: string): Promise<void> {
  // A slow page must not queue ticks: the next interval skips this entry.
  if (entry.ticking) return;
  entry.ticking = true;
  try {
    const result = await enqueueIfOpen(workspaceId, async (page) => ({
      url: page.url(),
      title: await page.title(),
      jpeg: await page.screenshot({ type: "jpeg", quality: STREAM_QUALITY }),
    }));
    // Unsubscribe deletes the entry: a capture that completes afterwards must
    // not reach a room the viewer left, or a new subscriber's sink.
    if (streams.get(workspaceId) !== entry) return;
    if (!result) {
      emitState(entry, { workspaceId, open: false, url: null, title: null });
      return;
    }
    try {
      entry.sink.onFrame({
        workspaceId,
        mimeType: "image/jpeg",
        data: result.jpeg.toString("base64"),
        ts: Date.now(),
      });
    } catch {
      // Same guard as emitState: a dead emitter cannot stop the interval.
    }
    emitState(entry, { workspaceId, open: true, url: result.url, title: result.title });
  } catch {
    // A page that vanished mid-capture must not stop the loop; the next tick
    // re-probes and reports closed if the session is gone.
  } finally {
    entry.ticking = false;
  }
}

/**
 * Refcounted entry point: the first subscriber starts the loop, later
 * subscribers only replace the sink. Resubscribing keeps the existing timer.
 */
export function subscribeBrowserStream(workspaceId: string, sink: browserStreamSink): void {
  let entry = streams.get(workspaceId);
  if (!entry) {
    entry = { sink, timer: null, ticking: false, lastState: null };
    streams.set(workspaceId, entry);
  } else {
    entry.sink = sink;
  }
  if (entry.timer) return;
  void tick(entry, workspaceId);
  entry.timer = setInterval(() => {
    void tick(entry, workspaceId);
  }, STREAM_INTERVAL_MS);
  entry.timer.unref?.();
}

/** Drop the workspace loop. A resubscribe starts fresh and re-emits state. */
export function unsubscribeBrowserStream(workspaceId: string): void {
  const entry = streams.get(workspaceId);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  streams.delete(workspaceId);
}

/** Test helper: clear every timer and entry so no loop survives a test. */
export function resetBrowserStreamsForTests(): void {
  for (const entry of streams.values()) {
    if (entry.timer) clearInterval(entry.timer);
  }
  streams.clear();
}
