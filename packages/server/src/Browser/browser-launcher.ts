// ─── Playwright launcher (real adapter + test seam) ───────────────────
// Lazy dynamic import so nothing loads Playwright unless a workspace session
// actually opens — tests and servers that never browse never pay the cost.

import type { browserLauncher } from "./browser-types.js";

/**
 * Persistent context: the profile dir IS the browser state (cookies, storage),
 * so a workspace keeps its signed-in session across runs. Headed on purpose:
 * the operator can see what the agent is doing.
 */
export function createPlaywrightLauncher(): browserLauncher {
  return async (profileDir) => {
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(profileDir, { headless: false });
    const page = context.pages()[0] ?? (await context.newPage());
    // Explicit adapter: Playwright exposes `page.mouse`/`page.keyboard`, while
    // browserPage names the two takeover verbs directly so fakes stay tiny.
    return {
      page: {
        goto: (url, opts) => page.goto(url, opts),
        screenshot: (opts) => page.screenshot(opts),
        click: (selector, opts) => page.click(selector, opts),
        fill: (selector, value) => page.fill(selector, value),
        mouseClick: (x, y) => page.mouse.click(x, y),
        keyboardType: (text) => page.keyboard.type(text),
        innerText: (selector) => page.innerText(selector),
        waitForSelector: (selector, opts) => page.waitForSelector(selector, opts ?? {}),
        waitForLoadState: (state, opts) => page.waitForLoadState(state, opts),
        title: () => page.title(),
        url: () => page.url(),
      },
      close: () => context.close(),
    };
  };
}

// Same override pattern as setLocalStoreDirForTests: tests pin a fake launcher,
// production falls through to the real one with no branch at the call site.
let testLauncher: browserLauncher | null = null;

export function setBrowserLauncherForTests(launcher: browserLauncher | null): void {
  testLauncher = launcher;
}

export function getBrowserLauncher(): browserLauncher {
  return testLauncher ?? createPlaywrightLauncher();
}
