// ─── Playwright launcher (real adapter + test seam) ───────────────────
// Lazy dynamic import so nothing loads Playwright unless a workspace session
// actually opens — tests and servers that never browse never pay the cost.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { browserLaunchOptions, browserLauncher } from "./browser-types.js";

/**
 * Google refuses sign-in from an automated browser: Playwright's Chromium
 * reports `navigator.webdriver === true` and advertises the "Chromium" brand
 * instead of "Google Chrome", so the login answers "This browser or app may
 * not be secure". The brand is fixed by driving the installed Chrome; the
 * automation signal is hidden in the page (`hideWebDriverFlag`), because the
 * switch that clears it is Chromium-only and Chrome-branded answers that with
 * its own "unsupported command-line flag" banner.
 */
const IGNORED_DEFAULT_ARGS = [
  "--enable-automation",
  "--disable-component-extensions-with-background-pages",
];

/** Installed Chrome per platform; the first existing hit wins. */
function chromeExecutableCandidates(): string[] {
  if (process.platform === "win32") {
    const prefixes = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
      process.env.HOMEDRIVE ? join(process.env.HOMEDRIVE, "Program Files") : null,
      process.env.HOMEDRIVE ? join(process.env.HOMEDRIVE, "Program Files (x86)") : null,
    ].filter((prefix): prefix is string => Boolean(prefix));
    return prefixes.map((prefix) => join(prefix, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME;
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ...(home
        ? [join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]
        : []),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
}

/** The installed Chrome, or undefined when the machine has none. */
export function findChromeExecutable(
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  for (const candidate of chromeExecutableCandidates()) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Chrome's sandbox, asked for wherever the host can give it: without it
 * Playwright adds `--no-sandbox`, and Chrome-branded answers that with the
 * yellow "unsupported command-line flag" banner. The installed Chrome ships
 * its own sandbox helper; Playwright's bundled Chromium (the fallback) usually
 * has none on Linux, so it keeps Playwright's default. Root cannot use the
 * sandbox at all.
 */
export function shouldEnableSandbox(
  usingInstalledChrome: boolean,
  platform: string = process.platform,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): boolean {
  if (!usingInstalledChrome) return false;
  if (platform === "linux" && uid === 0) return false;
  return true;
}

/**
 * `navigator.webdriver` is the page-visible half of "this browser is
 * automated". Chrome's own switch for it (`--disable-blink-features=
 * AutomationControlled`) is Chromium-only, and Chrome-branded answers that
 * with its own "unsupported command-line flag" banner — so the getter is
 * overridden in the page instead, where no unsupported switch is needed.
 *
 * A STRING, not a function: the page receives the source verbatim, so a
 * transpiler helper (esbuild's `__name`) cannot leak into the page and break
 * the script.
 */
export const HIDE_WEBDRIVER_SCRIPT =
  "Object.defineProperty(Navigator.prototype, 'webdriver', { get: function () { return false; }, configurable: true });";

/** Real Chrome when installed, and never an automation signal. */
export function buildLaunchOptions(executablePath?: string): browserLaunchOptions {
  return {
    headless: false,
    ...(executablePath ? { executablePath } : {}),
    chromiumSandbox: shouldEnableSandbox(Boolean(executablePath)),
    ignoreDefaultArgs: [...IGNORED_DEFAULT_ARGS],
  };
}

/**
 * Persistent context: the profile dir IS the browser state (cookies, storage),
 * so a workspace keeps its signed-in session across runs. Headed on purpose:
 * the operator can see what the agent is doing.
 */
export function createPlaywrightLauncher(): browserLauncher {
  return async (profileDir) => {
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(
      profileDir,
      buildLaunchOptions(findChromeExecutable()),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    // Runs before any page script in every frame: the page must not see the
    // automation flag, and no Chromium-only switch may be used for it.
    await context.addInitScript(HIDE_WEBDRIVER_SCRIPT);
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
