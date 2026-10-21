// B3 live view: the Browser-owned 1 fps loop. Fake launcher + fake timers only;
// no Playwright, no network. The loop is driven through the public stream port.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { setBrowserLauncherForTests } from "./browser-launcher.js";
import { openBrowser } from "./browser-service.js";
import { resetBrowserSessionsForTests } from "./browser-session.js";
import {
  resetBrowserStreamsForTests,
  subscribeBrowserStream,
  unsubscribeBrowserStream,
} from "./browser-stream.js";
import type { browserFrame, browserStreamSink, browserStreamState } from "./browser-stream.js";
import type { browserPage } from "./browser-types.js";

const WS = "ws-browser-stream";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-browser-stream-"));
  setLocalStoreDirForTests(dir);
  vi.useFakeTimers();
});

afterEach(async () => {
  resetBrowserStreamsForTests();
  await resetBrowserSessionsForTests();
  setBrowserLauncherForTests(null);
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function fakePage(overrides: Partial<browserPage> = {}): browserPage {
  return {
    goto: async () => null,
    screenshot: async () => JPEG,
    click: async () => {},
    fill: async () => {},
    mouseClick: async () => {},
    keyboardType: async () => {},
    innerText: async () => "",
    waitForSelector: async () => null,
    waitForLoadState: async () => {},
    title: async () => "Example",
    url: () => "https://example.com/",
    ...overrides,
  };
}

function recordingSink() {
  const frames: browserFrame[] = [];
  const states: browserStreamState[] = [];
  const sink: browserStreamSink = {
    onFrame: (frame) => frames.push(frame),
    onState: (state) => states.push(state),
  };
  return { frames, states, sink };
}

/** Install a launcher returning one page; `calls` counts launches. */
function installLauncher(page: browserPage = fakePage()) {
  const calls = { count: 0 };
  setBrowserLauncherForTests(async () => {
    calls.count += 1;
    return { page, close: async () => {} };
  });
  return calls;
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("browser stream loop", () => {
  it("fires the first tick immediately on first subscribe", async () => {
    installLauncher();
    await openBrowser(WS);
    const { frames, states, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    // No interval has elapsed yet: the first frame is the immediate tick.
    await flush();

    expect(frames).toHaveLength(1);
    expect(states).toEqual([
      { workspaceId: WS, open: true, url: "https://example.com/", title: "Example" },
    ]);
  });

  it("keeps a 1 fps cadence", async () => {
    installLauncher();
    await openBrowser(WS);
    const { frames, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    await flush();
    expect(frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3000);
    expect(frames).toHaveLength(5);
  });

  it("skips ticks while a slow capture is still in flight", async () => {
    let releaseScreenshot: () => void = () => {};
    const screenshotGate = new Promise<void>((resolve) => {
      releaseScreenshot = resolve;
    });
    let screenshotCalls = 0;
    installLauncher(
      fakePage({
        screenshot: async (opts) => {
          screenshotCalls += 1;
          expect(opts).toEqual({ type: "jpeg", quality: 60 });
          await screenshotGate;
          return JPEG;
        },
      }),
    );
    await openBrowser(WS);
    const { frames, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    await flush();
    expect(screenshotCalls).toBe(1);

    // Two intervals pass while the capture is unresolved: no pile-up.
    await vi.advanceTimersByTimeAsync(2000);
    expect(screenshotCalls).toBe(1);
    expect(frames).toHaveLength(0);

    releaseScreenshot();
    await flush();
    expect(frames).toHaveLength(1);
  });

  it("drops a capture that completes after unsubscribe", async () => {
    let releaseScreenshot: () => void = () => {};
    const screenshotGate = new Promise<void>((resolve) => {
      releaseScreenshot = resolve;
    });
    installLauncher(
      fakePage({
        screenshot: async () => {
          await screenshotGate;
          return JPEG;
        },
      }),
    );
    await openBrowser(WS);
    const { frames, states, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    await flush();
    expect(frames).toHaveLength(0);

    unsubscribeBrowserStream(WS);
    releaseScreenshot();
    await flush();

    expect(frames).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  it("does not deliver a stale capture to a resubscribed sink", async () => {
    let releaseScreenshot: () => void = () => {};
    const screenshotGate = new Promise<void>((resolve) => {
      releaseScreenshot = resolve;
    });
    let screenshotCalls = 0;
    installLauncher(
      fakePage({
        screenshot: async () => {
          screenshotCalls += 1;
          // Hold exactly the first (stale) capture; later ticks resolve at once.
          if (screenshotCalls === 1) await screenshotGate;
          return JPEG;
        },
      }),
    );
    await openBrowser(WS);
    const a = recordingSink();
    const b = recordingSink();

    subscribeBrowserStream(WS, a.sink);
    await flush();
    expect(screenshotCalls).toBe(1);

    unsubscribeBrowserStream(WS);
    subscribeBrowserStream(WS, b.sink);
    await flush();
    // B's fresh tick is queued behind the still-held capture.
    expect(b.frames).toHaveLength(0);

    releaseScreenshot();
    await flush();

    expect(a.frames).toHaveLength(0);
    expect(a.states).toHaveLength(0);
    expect(b.frames).toHaveLength(1);
    expect(b.states).toHaveLength(1);
  });

  it("emits state only when url/title/open change", async () => {
    let currentUrl = "https://example.com/one";
    let currentTitle = "One";
    installLauncher(
      fakePage({
        url: () => currentUrl,
        title: async () => currentTitle,
      }),
    );
    await openBrowser(WS);
    const { states, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    await flush();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ open: true, url: currentUrl, title: currentTitle });

    // Same page next tick: no duplicate state event.
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toHaveLength(1);

    currentUrl = "https://example.com/two";
    currentTitle = "Two";
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toHaveLength(2);
    expect(states[1]).toMatchObject({ open: true, url: currentUrl, title: currentTitle });
  });

  it("reports closed once without launching, and emits no frames", async () => {
    const launcher = installLauncher();
    const { frames, states, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    await flush();

    expect(frames).toHaveLength(0);
    expect(states).toEqual([
      { workspaceId: WS, open: false, url: null, title: null },
    ]);
    expect(launcher.count).toBe(0);

    // Repeated ticks keep the same closed fact: change-only dedupe holds.
    await vi.advanceTimersByTimeAsync(3000);
    expect(states).toHaveLength(1);
    expect(launcher.count).toBe(0);
  });

  it("stops on unsubscribe and re-emits immediately on resubscribe", async () => {
    installLauncher();
    await openBrowser(WS);
    const { frames, states, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    await flush();
    expect(frames).toHaveLength(1);
    expect(states).toHaveLength(1);

    unsubscribeBrowserStream(WS);
    await vi.advanceTimersByTimeAsync(5000);
    expect(frames).toHaveLength(1);
    expect(states).toHaveLength(1);

    subscribeBrowserStream(WS, sink);
    await flush();
    expect(frames).toHaveLength(2);
    // A fresh entry has no lastState, so the state is re-emitted on resubscribe.
    expect(states).toHaveLength(2);
  });

  it("sends a JPEG base64 frame with a numeric timestamp", async () => {
    installLauncher();
    await openBrowser(WS);
    const { frames, sink } = recordingSink();

    subscribeBrowserStream(WS, sink);
    await flush();

    expect(frames[0]).toEqual({
      workspaceId: WS,
      mimeType: "image/jpeg",
      data: JPEG.toString("base64"),
      ts: expect.any(Number),
    });
  });
});
