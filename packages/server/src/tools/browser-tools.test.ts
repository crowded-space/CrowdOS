// Browser tools at the registry level: definitions + handler contract with a
// fake launcher (the Browser seam), no real browser and no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { setRegistryFilePathForTests } from "../workspace/workspace-registry.js";
import { env } from "../shared/config/env.js";
import { setBrowserLauncherForTests } from "../Browser/browser-launcher.js";
import { resetBrowserSessionsForTests } from "../Browser/browser-session.js";
import type { browserPage } from "../Browser/browser-types.js";
import { ToolRegistry } from "./tool-registry.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

const WS = "ws-browser-tools";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-browser-tools-"));
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

const ctx = { agentId: "agent-b1", channelId: "channel-1", workspaceId: WS, runId: "run-b1" };

describe("browser tools registration", () => {
  it("registers all seven verbs at L1 with the right danger and effect class", () => {
    const registry = new ToolRegistry();

    const expected = [
      { id: "browser_navigate", danger: "safe", effect: "side-effect" },
      { id: "browser_screenshot", danger: "safe", effect: "read" },
      { id: "browser_click", danger: "moderate", effect: "side-effect" },
      { id: "browser_type", danger: "moderate", effect: "side-effect" },
      { id: "browser_read", danger: "safe", effect: "read" },
      { id: "browser_wait", danger: "safe", effect: "read" },
      { id: "browser_state", danger: "safe", effect: "read" },
    ] as const;

    for (const want of expected) {
      const def = registry.get(want.id);
      expect(def, want.id).toBeDefined();
      expect(def!.authLevelRequired).toBe(1);
      expect(def!.dangerLevel).toBe(want.danger);
      expect(def!.effectClass).toBe(want.effect);
      expect(def!.category).toBe("browser");
      expect(def!.sourceType).toBe("native");
    }

    expect(registry.get("browser_navigate")!.parameters.required).toEqual(["url"]);
    expect(registry.get("browser_click")!.parameters.required).toEqual(["selector"]);
    expect(registry.get("browser_type")!.parameters.required).toEqual(["selector", "text"]);
    expect(registry.get("browser_screenshot")!.parameters.required).toBeUndefined();
    expect(registry.get("browser_read")!.parameters.required).toBeUndefined();
    expect(registry.get("browser_wait")!.parameters.required).toBeUndefined();
    expect(registry.get("browser_state")!.parameters.required).toBeUndefined();
  });
});

describe("browser tool handlers", () => {
  it("rejects an empty url with a failed tool result", async () => {
    const registry = new ToolRegistry();
    const result = await registry.get("browser_navigate")!.handler({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("url");
  });

  it("navigates through the Browser gate and returns url + title", async () => {
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        goto: async () => null,
        url: () => "https://example.com/final",
        title: async () => "Final",
      }),
      close: async () => {},
    }));
    const registry = new ToolRegistry();

    const result = await registry.get("browser_navigate")!.handler(
      { url: "https://example.com/" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      url: "https://example.com/final",
      title: "Final",
    });
  });

  it("screenshots into an artifact and reports the artifact entry", async () => {
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
        url: () => "https://example.com/shot",
        title: async () => "Shot",
      }),
      close: async () => {},
    }));
    const registry = new ToolRegistry();

    const result = await registry.get("browser_screenshot")!.handler({}, ctx);

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.artifactId).toMatch(/^art_/);
    expect(payload.path.endsWith(".png")).toBe(true);
    expect(payload.url).toBe("https://example.com/shot");
    expect(result.artifacts).toEqual([
      { type: "file", path: payload.path, mimeType: "image/png" },
    ]);
  });

  it("rejects browser_click without a selector", async () => {
    const registry = new ToolRegistry();
    const result = await registry.get("browser_click")!.handler({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("selector");
  });

  it("rejects browser_type with a selector but no text", async () => {
    const registry = new ToolRegistry();
    const result = await registry.get("browser_type")!.handler({ selector: "#q" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("text");
  });

  it("rejects browser_wait with neither selector nor loadState", async () => {
    const registry = new ToolRegistry();
    const result = await registry.get("browser_wait")!.handler({}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/selector or a loadState/i);
  });

  it("reports a closed browser without launching one", async () => {
    let launcherCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return { page: fakePage(), close: async () => {} };
    });
    const registry = new ToolRegistry();

    const result = await registry.get("browser_state")!.handler({}, ctx);

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ open: false, url: null, title: null });
    expect(launcherCalls).toBe(0);
  });

  it("clicks through the gate and returns url + title", async () => {
    const clicks: string[] = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        click: async (selector) => {
          clicks.push(selector);
        },
        url: () => "https://example.com/clicked",
        title: async () => "Clicked",
      }),
      close: async () => {},
    }));
    const registry = new ToolRegistry();

    const result = await registry.get("browser_click")!.handler({ selector: "#go" }, ctx);

    expect(result.success).toBe(true);
    expect(clicks).toEqual(["#go"]);
    expect(JSON.parse(result.output)).toEqual({
      url: "https://example.com/clicked",
      title: "Clicked",
    });
  });

  it("types through the gate and returns url + title", async () => {
    const fills: Array<[string, string]> = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        fill: async (selector, value) => {
          fills.push([selector, value]);
        },
        url: () => "https://example.com/typed",
        title: async () => "Typed",
      }),
      close: async () => {},
    }));
    const registry = new ToolRegistry();

    const result = await registry.get("browser_type")!.handler(
      { selector: "#q", text: "crowdos" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(fills).toEqual([["#q", "crowdos"]]);
    expect(JSON.parse(result.output)).toEqual({
      url: "https://example.com/typed",
      title: "Typed",
    });
  });

  it("reads page text through the gate", async () => {
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        innerText: async () => "Body text",
        url: () => "https://example.com/read",
        title: async () => "Read",
      }),
      close: async () => {},
    }));
    const registry = new ToolRegistry();

    const result = await registry.get("browser_read")!.handler({}, ctx);

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      url: "https://example.com/read",
      title: "Read",
      text: "Body text",
      truncated: false,
    });
  });

  it("waits through the gate and returns url + title", async () => {
    let waited: { selector: string; opts: unknown } | null = null;
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        waitForSelector: async (selector, opts) => {
          waited = { selector, opts };
          return null;
        },
        url: () => "https://example.com/waited",
        title: async () => "Waited",
      }),
      close: async () => {},
    }));
    const registry = new ToolRegistry();

    const result = await registry.get("browser_wait")!.handler(
      { selector: "#ready", timeoutMs: 5000 },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(waited).toEqual({ selector: "#ready", opts: { state: "visible", timeout: 5000 } });
    expect(JSON.parse(result.output)).toEqual({
      url: "https://example.com/waited",
      title: "Waited",
    });
  });
});
