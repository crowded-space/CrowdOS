// B3 browser panel routes. Fastify inject only: fake launcher, no Playwright,
// no network. Every route is asserted through its HTTP surface.
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { validatorCompiler } from "../shared/core/validation.js";
import { setBrowserLauncherForTests } from "../Browser/browser-launcher.js";
import { resetBrowserSessionsForTests } from "../Browser/browser-session.js";
import type { browserPage } from "../Browser/browser-types.js";
import { browserRoutes } from "./browser.js";

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-browser-routes-"));
  setLocalStoreDirForTests(dir);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  await app.register(browserRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await resetBrowserSessionsForTests();
  setBrowserLauncherForTests(null);
  setLocalStoreDirForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function fakePage(overrides: Partial<browserPage> = {}): browserPage {
  return {
    goto: async () => null,
    screenshot: async () => Buffer.from([0xff, 0xd8]),
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

describe("GET /api/browser/state", () => {
  it("reports closed without launching a browser", async () => {
    let launcherCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return { page: fakePage(), close: async () => {} };
    });

    const res = await app.inject({ method: "GET", url: "/api/browser/state" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ open: false, url: null, title: null });
    expect(launcherCalls).toBe(0);
  });
});

describe("POST /api/browser/open and close", () => {
  it("opens without a url, then closes back to a closed state", async () => {
    let launcherCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return {
        page: fakePage({ url: () => "about:blank", title: async () => "Blank" }),
        close: async () => {},
      };
    });

    const opened = await app.inject({ method: "POST", url: "/api/browser/open", payload: {} });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ ok: true, url: "about:blank", title: "Blank" });
    expect(launcherCalls).toBe(1);

    const closed = await app.inject({ method: "POST", url: "/api/browser/close", payload: {} });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ ok: true });

    const state = await app.inject({ method: "GET", url: "/api/browser/state" });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ open: false, url: null, title: null });
  });

  it("rejects an unsafe url with the guard message and never calls goto", async () => {
    let gotoCalls = 0;
    let launcherCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return {
        page: fakePage({
          goto: async () => {
            gotoCalls += 1;
            return null;
          },
        }),
        close: async () => {},
      };
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/browser/open",
      payload: { url: "http://127.0.0.1/" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toMatch(/guard/i);
    expect(gotoCalls).toBe(0);
    expect(launcherCalls).toBe(0);
  });
});

describe("POST /api/browser/action", () => {
  it("navigates, clicks, and fills through the gate", async () => {
    const gotos: string[] = [];
    const clicks: string[] = [];
    const fills: Array<[string, string]> = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        goto: async (url) => {
          gotos.push(url);
          return null;
        },
        click: async (selector) => {
          clicks.push(selector);
        },
        fill: async (selector, value) => {
          fills.push([selector, value]);
        },
        url: () => "https://example.com/final",
        title: async () => "Final",
      }),
      close: async () => {},
    }));

    const navigated = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "navigate", url: "https://example.com/" },
    });
    expect(navigated.statusCode).toBe(200);
    expect(navigated.json()).toEqual({
      ok: true,
      url: "https://example.com/final",
      title: "Final",
    });
    expect(gotos).toEqual(["https://example.com/"]);

    const clicked = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "click", selector: "#go" },
    });
    expect(clicked.statusCode).toBe(200);
    expect(clicks).toEqual(["#go"]);

    const typed = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "type", selector: "#q", text: "crowdos" },
    });
    expect(typed.statusCode).toBe(200);
    expect(fills).toEqual([["#q", "crowdos"]]);
  });

  it("takes over the panel: coordinate click and focused typing", async () => {
    const clicks: Array<[number, number]> = [];
    const typed: string[] = [];
    setBrowserLauncherForTests(async () => ({
      page: fakePage({
        mouseClick: async (x, y) => {
          clicks.push([x, y]);
        },
        keyboardType: async (text) => {
          typed.push(text);
        },
        url: () => "https://example.com/takeover",
        title: async () => "Takeover",
      }),
      close: async () => {},
    }));

    const clicked = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "clickAt", x: 12, y: 34 },
    });
    expect(clicked.statusCode).toBe(200);
    expect(clicked.json()).toEqual({ ok: true, url: "https://example.com/takeover", title: "Takeover" });
    expect(clicks).toEqual([[12, 34]]);

    const typedRes = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "typeText", text: "operator input" },
    });
    expect(typedRes.statusCode).toBe(200);
    expect(typedRes.json()).toEqual({ ok: true, url: "https://example.com/takeover", title: "Takeover" });
    expect(typed).toEqual(["operator input"]);
  });

  it("rejects missing or negative coordinates and empty focused text", async () => {
    let launcherCalls = 0;
    let mouseClickCalls = 0;
    setBrowserLauncherForTests(async () => {
      launcherCalls += 1;
      return {
        page: fakePage({
          mouseClick: async () => {
            mouseClickCalls += 1;
          },
        }),
        close: async () => {},
      };
    });

    const missingX = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "clickAt", y: 10 },
    });
    expect(missingX.statusCode).toBe(400);
    expect(missingX.json().error).toMatch(/x/i);

    const negativeY = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "clickAt", x: 10, y: -1 },
    });
    expect(negativeY.statusCode).toBe(400);
    expect(launcherCalls).toBe(0);
    expect(mouseClickCalls).toBe(0);

    const emptyText = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "typeText", text: "" },
    });
    expect(emptyText.statusCode).toBe(400);
    expect(emptyText.json().error).toMatch(/text/i);
  });

  it("rejects unknown actions and missing per-action fields", async () => {
    const invalidAction = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "wait" },
    });
    expect(invalidAction.statusCode).toBe(400);
    expect(invalidAction.json().ok).toBe(false);

    const clickWithoutSelector = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "click" },
    });
    expect(clickWithoutSelector.statusCode).toBe(400);
    expect(clickWithoutSelector.json().error).toMatch(/selector/i);

    const typeWithoutText = await app.inject({
      method: "POST",
      url: "/api/browser/action",
      payload: { action: "type", selector: "#q" },
    });
    expect(typeWithoutText.statusCode).toBe(400);
    expect(typeWithoutText.json().error).toMatch(/text/i);
  });
});
