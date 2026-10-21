// Browser behavior ports: URL guard, navigate, screenshot artifact, and the
// B2 control verbs. Fake page only — no Playwright, no network, no real browser.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { env } from "../shared/config/env.js";
import {
  clickAtBrowser,
  clickBrowser,
  getBrowserState,
  navigateBrowser,
  readBrowser,
  screenshotBrowser,
  typeBrowser,
  typeTextBrowser,
  waitBrowser,
} from "./browser-service.js";
import { closeWorkspaceSession, resetBrowserSessionsForTests } from "./browser-session.js";
import { setBrowserLauncherForTests } from "./browser-launcher.js";
import type { browserPage } from "./browser-types.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

const WS = "ws-browser-service";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-browser-service-"));
  setLocalStoreDirForTests(dir);
  setRegistryFilePathForTests(join(dir, "workspaces.json"));
  const { saveWorkspaceRecord } = await import("../workspace/workspace-gate.js");
  const now = new Date().toISOString();
  await saveWorkspaceRecord({
    id: WS,
    name: WS,
    icon: "box",
    databaseUrl: "",
    rootPath: join(dir, WS),
    screenLockPinHash: null,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(async () => {
  await resetBrowserSessionsForTests();
  setBrowserLauncherForTests(null);
  setLocalStoreDirForTests(null);
  setRegistryFilePathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function fakePage(overrides: Partial<browserPage> = {}): browserPage {
  return {
    goto: async () => null,
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("navigateBrowser", () => {
  it("rejects unsafe URLs before opening a session or calling goto", async () => {
    const gotoCalls: string[] = [];
    let launcherCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return {
        page: fakePage({ goto: async (url) => { gotoCalls.push(url); return null; } }),
        close: async () => {},
      };
    });

    await expect(navigateBrowser(WS, "file:///C:/x")).rejects.toThrow(/guard/i);
    await expect(navigateBrowser(WS, "http://127.0.0.1/")).rejects.toThrow(/guard/i);

    expect(gotoCalls).toEqual([]);
    expect(launcherCalls).toBe(0);
  });

  it("returns the final url and title after domcontentloaded navigation", async () => {
    let captured: { url: string; opts: unknown } | null = null;
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        goto: async (url, opts) => {
          captured = { url, opts };
          return null;
        },
        url: () => "https://example.com/final",
        title: async () => "Final Title",
      }),
      close: async () => {},
    }));

    const result = await navigateBrowser(WS, "https://example.com/start");

    expect(result).toEqual({ url: "https://example.com/final", title: "Final Title" });
    expect(captured!.url).toBe("https://example.com/start");
    expect(captured!.opts).toEqual({ waitUntil: "domcontentloaded", timeout: 30000 });
  });
});

describe("screenshotBrowser", () => {
  it("stores a PNG artifact on disk with binary bytes", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        screenshot: async () => png,
        url: () => "https://example.com/shot",
        title: async () => "Shot",
      }),
      close: async () => {},
    }));

    const result = await screenshotBrowser(WS, { agentId: "agent-b1", workspaceId: WS });

    expect(result.artifactId).toMatch(/^art_/);
    expect(result.path.endsWith(".png")).toBe(true);
    expect(result.url).toBe("https://example.com/shot");
    expect(result.title).toBe("Shot");

    const onDisk = readFileSync(join(dir, WS, result.path));
    expect(onDisk.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(onDisk.equals(png)).toBe(true);
  });
});

describe("clickBrowser", () => {
  it("clicks the selector and reports the final url and title", async () => {
    const clicks: string[] = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        click: async (selector) => {
          clicks.push(selector);
        },
        url: () => "https://example.com/after-click",
        title: async () => "After Click",
      }),
      close: async () => {},
    }));

    const result = await clickBrowser(WS, "#submit");

    expect(clicks).toEqual(["#submit"]);
    expect(result).toEqual({ url: "https://example.com/after-click", title: "After Click" });
  });
});

describe("typeBrowser", () => {
  it("fills the selector with the given text", async () => {
    const fills: Array<[string, string]> = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        fill: async (selector, value) => {
          fills.push([selector, value]);
        },
        url: () => "https://example.com/after-type",
        title: async () => "After Type",
      }),
      close: async () => {},
    }));

    const result = await typeBrowser(WS, "#q", "hello world");

    expect(fills).toEqual([["#q", "hello world"]]);
    expect(result).toEqual({ url: "https://example.com/after-type", title: "After Type" });
  });
});

describe("clickAtBrowser", () => {
  it("clicks the page at the given coordinates and reports the final url and title", async () => {
    const clicks: Array<[number, number]> = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        mouseClick: async (x, y) => {
          clicks.push([x, y]);
        },
        url: () => "https://example.com/after-click-at",
        title: async () => "After Click At",
      }),
      close: async () => {},
    }));

    const result = await clickAtBrowser(WS, 120, 340);

    expect(clicks).toEqual([[120, 340]]);
    expect(result).toEqual({ url: "https://example.com/after-click-at", title: "After Click At" });
  });
});

describe("typeTextBrowser", () => {
  it("types into the focused element and reports the final url and title", async () => {
    const typed: string[] = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        keyboardType: async (text) => {
          typed.push(text);
        },
        url: () => "https://example.com/after-type-text",
        title: async () => "After Type Text",
      }),
      close: async () => {},
    }));

    const result = await typeTextBrowser(WS, "hello operator");

    expect(typed).toEqual(["hello operator"]);
    expect(result).toEqual({ url: "https://example.com/after-type-text", title: "After Type Text" });
  });
});

describe("readBrowser", () => {
  it("truncates body text longer than 20000 characters", async () => {
    const raw = "x".repeat(20001);
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        innerText: async (selector) => {
          expect(selector).toBe("body");
          return raw;
        },
        url: () => "https://example.com/read",
        title: async () => "Read",
      }),
      close: async () => {},
    }));

    const result = await readBrowser(WS);

    expect(result).toEqual({
      url: "https://example.com/read",
      title: "Read",
      text: raw.slice(0, 20000),
      truncated: true,
    });
    expect(result.text.length).toBe(20000);
  });

  it("does not truncate text of exactly 20000 characters", async () => {
    const raw = "x".repeat(20000);
    setBrowserLauncherForTests(async () => ({
      page: fakePage({ innerText: async () => raw }),
      close: async () => {},
    }));

    const result = await readBrowser(WS);

    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(20000);
  });

  it("returns short body text intact", async () => {
    setBrowserLauncherForTests(async () => ({
      page: fakePage({ innerText: async () => "short body" }),
      close: async () => {},
    }));

    const result = await readBrowser(WS);

    expect(result.text).toBe("short body");
    expect(result.truncated).toBe(false);
  });
});

describe("waitBrowser", () => {
  it("waits for a selector as visible with the default timeout", async () => {
    let captured: { selector: string; opts: unknown } | null = null;
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        waitForSelector: async (selector, opts) => {
          captured = { selector, opts };
          return null;
        },
        url: () => "https://example.com/waited",
        title: async () => "Waited",
      }),
      close: async () => {},
    }));

    const result = await waitBrowser(WS, { selector: "#ready" });

    expect(captured).toEqual({
      selector: "#ready",
      opts: { state: "visible", timeout: 30000 },
    });
    expect(result).toEqual({ url: "https://example.com/waited", title: "Waited" });
  });

  it("waits for a load state with an explicit timeout", async () => {
    let captured: { state: string | undefined; opts: unknown } | null = null;
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        waitForLoadState: async (state, opts) => {
          captured = { state, opts };
        },
      }),
      close: async () => {},
    }));

    await waitBrowser(WS, { loadState: "networkidle", timeoutMs: 1234 });

    expect(captured).toEqual({ state: "networkidle", opts: { timeout: 1234 } });
  });

  it("rejects when neither selector nor loadState is given, without launching", async () => {
    let launcherCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return { page: fakePage(), close: async () => {} };
    });

    await expect(waitBrowser(WS, {})).rejects.toThrow(/selector or a loadState/i);
    expect(launcherCalls).toBe(0);
  });
});

describe("getBrowserState", () => {
  it("reports closed without launching a browser", async () => {
    let launcherCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return { page: fakePage(), close: async () => {} };
    });

    const state = await getBrowserState(WS);

    expect(state).toEqual({ open: false, url: null, title: null });
    expect(launcherCalls).toBe(0);
  });

  it("reports url and title when the browser is already open", async () => {
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        url: () => "https://example.com/open",
        title: async () => "Open",
      }),
      close: async () => {},
    }));
    await navigateBrowser(WS, "https://example.com/");

    const state = await getBrowserState(WS);

    expect(state).toEqual({ open: true, url: "https://example.com/open", title: "Open" });
  });

  it("a state read queued behind a command reports closed when the session closes first", async () => {
    let releaseGoto: () => void = () => {};
    const gotoBlocked = new Promise<void>((resolve) => {
      releaseGoto = resolve;
    });
    let launcherCalls = 0;
    let closeCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return {
        page: fakePage({
          goto: async () => {
            await gotoBlocked;
            return null;
          },
          url: () => "https://example.com/open",
          title: async () => "Open",
        }),
        close: async () => {
          closeCalls += 1;
        },
      };
    });

    const navigate = navigateBrowser(WS, "https://example.com/");
    const stateRead = getBrowserState(WS);
    await delay(0);
    const closing = closeWorkspaceSession(WS);
    releaseGoto();

    const [, state] = await Promise.all([navigate, stateRead, closing]);

    expect(state).toEqual({ open: false, url: null, title: null });
    expect(launcherCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });
});

describe("workspace queue", () => {
  it("serializes concurrent control commands in call order", async () => {
    const events: string[] = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        click: async (selector) => {
          events.push(`click:start:${selector}`);
          await delay(20);
          events.push(`click:end:${selector}`);
        },
        innerText: async () => {
          events.push("read:start");
          await delay(20);
          events.push("read:end");
          return "done";
        },
      }),
      close: async () => {},
    }));

    const click = clickBrowser(WS, "#go");
    const read = readBrowser(WS);
    await Promise.all([click, read]);

    expect(events).toEqual(["click:start:#go", "click:end:#go", "read:start", "read:end"]);
  });
});
