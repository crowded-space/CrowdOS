// Browser session lifecycle + single-actor queue. No Playwright, no page.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import {
  closeAllSessions,
  closeWorkspaceSession,
  enqueueCommand,
  resetBrowserSessionsForTests,
  resolveBrowserProfileDir,
} from "./browser-session.js";
import { setBrowserLauncherForTests } from "./browser-launcher.js";
import type { browserPage } from "./browser-types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakePage(overrides: Partial<browserPage> = {}): browserPage {
  return {
    goto: async () => null,
    screenshot: async () => Buffer.from([1, 2, 3]),
    click: async () => {},
    fill: async () => {},
    mouseClick: async () => {},
    keyboardType: async () => {},
    innerText: async () => "",
    waitForSelector: async () => null,
    waitForLoadState: async () => {},
    title: async () => "Fake",
    url: () => "about:blank",
    ...overrides,
  };
}

let dirs: string[] = [];

afterEach(async () => {
  await resetBrowserSessionsForTests();
  setBrowserLauncherForTests(null);
  setLocalStoreDirForTests(null);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("browser session profile", () => {
  it("resolves the persistent profile under the workspace crowdos dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "crowdos-browser-profile-"));
    dirs.push(dir);
    setLocalStoreDirForTests(dir);

    expect(resolveBrowserProfileDir("default")).toBe(
      join(dir, "default", "vfs", ".crowdos", "browser", "profile"),
    );
    expect(resolveBrowserProfileDir("ws-2").endsWith(join("vfs", ".crowdos", "browser", "profile"))).toBe(true);
  });
});

describe("browser single-actor queue", () => {
  it("runs commands strictly in call order even when they overlap", async () => {
    const events: string[] = [];
    let inFlight = 0;
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        goto: async () => {
          inFlight += 1;
          events.push("start");
          await sleep(5);
          events.push("end");
          inFlight -= 1;
          return null;
        },
      }),
      close: async () => {},
    }));

    await Promise.all([
      enqueueCommand("ws-queue", async (page) => page.goto("https://a.example")),
      enqueueCommand("ws-queue", async (page) => page.goto("https://b.example")),
      enqueueCommand("ws-queue", async (page) => page.goto("https://c.example")),
    ]);

    expect(events).toEqual(["start", "end", "start", "end", "start", "end"]);
    expect(inFlight).toBe(0);
  });

  it("surfaces a rejection to its caller without poisoning the chain", async () => {
    setBrowserLauncherForTests(async () => ({ page: fakePage(), close: async () => {} }));

    await expect(
      enqueueCommand("ws-reject", async () => {
        throw new Error("command failed");
      }),
    ).rejects.toThrow("command failed");

    await expect(enqueueCommand("ws-reject", async () => "still alive")).resolves.toBe("still alive");
  });
});

describe("browser session close", () => {
  it("closes the handle and re-opens on the next command", async () => {
    let opens = 0;
    let closes = 0;
    setBrowserLauncherForTests(async () => {
      opens += 1;
      return {
        page: fakePage(),
        close: async () => {
          closes += 1;
        },
      };
    });

    await enqueueCommand("ws-close", async (page) => page.title());
    await closeWorkspaceSession("ws-close");
    expect(closes).toBe(1);

    await enqueueCommand("ws-close", async (page) => page.title());
    expect(opens).toBe(2);
  });

  it("does not open a second browser for a command queued before close", async () => {
    let opens = 0;
    let closes = 0;
    let releaseGate!: () => void;
    let gotoStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const started = new Promise<void>((resolve) => {
      gotoStarted = resolve;
    });
    setBrowserLauncherForTests(async () => {
      opens += 1;
      return {
        page: fakePage({
          goto: async () => {
            gotoStarted();
            await gate;
            return null;
          },
        }),
        close: async () => {
          closes += 1;
        },
      };
    });

    const navigate = enqueueCommand("ws-close-queued", async (page) => page.goto("https://a.example"));
    const title = enqueueCommand("ws-close-queued", async (page) => page.title());
    await started;
    const closing = closeWorkspaceSession("ws-close-queued");
    releaseGate();

    await expect(navigate).resolves.toBeNull();
    await expect(title).resolves.toBe("Fake");
    await closing;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it("does not open a second browser when closeAllSessions follows a queued command", async () => {
    let opens = 0;
    let closes = 0;
    let releaseGate!: () => void;
    let gotoStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const started = new Promise<void>((resolve) => {
      gotoStarted = resolve;
    });
    setBrowserLauncherForTests(async () => {
      opens += 1;
      return {
        page: fakePage({
          goto: async () => {
            gotoStarted();
            await gate;
            return null;
          },
        }),
        close: async () => {
          closes += 1;
        },
      };
    });

    const navigate = enqueueCommand("ws-close-all-queued", async (page) => page.goto("https://a.example"));
    const title = enqueueCommand("ws-close-all-queued", async (page) => page.title());
    await started;
    const closing = closeAllSessions();
    releaseGate();

    await expect(navigate).resolves.toBeNull();
    await expect(title).resolves.toBe("Fake");
    await closing;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it("closeAllSessions closes every workspace and never throws", async () => {
    setBrowserLauncherForTests(async (profileDir) => ({
      page: fakePage(),
      close: async () => {
        if (profileDir.includes("bad")) throw new Error("close failed");
      },
    }));

    await enqueueCommand("ws-good", async (page) => page.title());
    await enqueueCommand("ws-bad", async (page) => page.title());

    await expect(closeAllSessions()).resolves.toBeUndefined();
    // A later command must open a fresh session, proving the map was cleared.
    await expect(enqueueCommand("ws-good", async (page) => page.title())).resolves.toBe("Fake");
  });
});
