// Launch options decide whether the built-in browser survives Google's
// sign-in gate: the page must not report `navigator.webdriver === true` and
// the browser must present itself as Chrome ("Google Chrome" brand), or the
// login answers "This browser or app may not be secure". The command line
// must also stay free of Chromium-only switches: Chrome-branded answers those
// with its own yellow "unsupported command-line flag" banner.
//
// Hermetic: Playwright is mocked, so no browser is launched here.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: h.launchPersistentContext },
}));

import {
  buildLaunchOptions,
  createPlaywrightLauncher,
  findChromeExecutable,
  HIDE_WEBDRIVER_SCRIPT,
  shouldEnableSandbox,
} from "./browser-launcher.js";

function fakeContext() {
  const page = {
    goto: vi.fn(),
    screenshot: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    mouse: { click: vi.fn() },
    keyboard: { type: vi.fn() },
    innerText: vi.fn(),
    waitForSelector: vi.fn(),
    waitForLoadState: vi.fn(),
    title: vi.fn(),
    url: vi.fn(),
  };
  return {
    page,
    context: {
      pages: () => [page],
      newPage: async () => page,
      addInitScript: vi.fn(),
      close: vi.fn(),
    },
  };
}

describe("browser launch options", () => {
  it("keeps Chromium-only switches off the command line", () => {
    const options = buildLaunchOptions();
    expect(options.headless).toBe(false);
    // The automation switch (and its infobar) goes, and the Google account
    // component extension stays enabled.
    expect(options.ignoreDefaultArgs).toContain("--enable-automation");
    expect(options.ignoreDefaultArgs).toContain("--disable-component-extensions-with-background-pages");
    // Chrome-branded warns about --disable-blink-features=..., so the
    // automation flag is hidden in the page instead of by a switch.
    expect(JSON.stringify(options)).not.toContain("--disable-blink-features");
  });

  it("drives the installed Chrome so the browser brands itself as Chrome", () => {
    expect(buildLaunchOptions("C:/chrome.exe").executablePath).toBe("C:/chrome.exe");
    expect(buildLaunchOptions().executablePath).toBeUndefined();
  });

  it("reports the installed Chrome, and none when the machine has none", () => {
    const seen: string[] = [];
    const found = findChromeExecutable((candidate) => {
      seen.push(candidate);
      return seen.length === 1;
    });
    expect(found).toBe(seen[0]);
    expect(findChromeExecutable(() => false)).toBeUndefined();
  });

  it("keeps Chrome's sandbox on, so the --no-sandbox banner never shows", () => {
    // The bundled Chromium keeps Playwright's default: its Linux build has no
    // sandbox helper. The installed Chrome has one and is asked to use it.
    expect(buildLaunchOptions("C:/chrome.exe").chromiumSandbox).toBe(true);
    expect(buildLaunchOptions().chromiumSandbox).toBe(false);
    expect(shouldEnableSandbox(true, "win32", null)).toBe(true);
    expect(shouldEnableSandbox(true, "darwin", 501)).toBe(true);
    expect(shouldEnableSandbox(true, "linux", 0)).toBe(false);
    expect(shouldEnableSandbox(true, "linux", 1000)).toBe(true);
    expect(shouldEnableSandbox(false, "win32", null)).toBe(false);
  });

  it("hides the automation flag from the page", () => {
    const originalNavigator = globalThis.Navigator;
    class FakeNavigator {
      declare webdriver: boolean;
    }
    (globalThis as unknown as { Navigator: unknown }).Navigator = FakeNavigator;
    try {
      // The script is a string, so the page runs it verbatim — no transpiler
      // helper can leak into it and break the override.
      new Function(HIDE_WEBDRIVER_SCRIPT)();
      expect(new FakeNavigator().webdriver).toBe(false);
    } finally {
      (globalThis as unknown as { Navigator: unknown }).Navigator = originalNavigator;
    }
  });
});

describe("createPlaywrightLauncher", () => {
  it("launches the persistent context with the sign-in-safe options", async () => {
    const { context } = fakeContext();
    h.launchPersistentContext.mockResolvedValue(context);

    const handle = await createPlaywrightLauncher()("/tmp/profile");
    await handle.close();

    expect(h.launchPersistentContext).toHaveBeenCalledTimes(1);
    const [profileDir, options] = h.launchPersistentContext.mock.calls[0];
    expect(profileDir).toBe("/tmp/profile");
    expect(options.ignoreDefaultArgs).toContain("--enable-automation");
    expect(options.executablePath).toBe(findChromeExecutable());
    expect(options.chromiumSandbox).toBe(Boolean(findChromeExecutable()));
    // The page must not see the automation flag: injected into every frame.
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
  });
});
