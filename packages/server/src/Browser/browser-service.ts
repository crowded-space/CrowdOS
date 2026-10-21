// ─── Browser behavior ports ───────────────────────────────────────────
// Navigation is guard-checked before any session is touched: a file:// or
// loopback URL must fail without opening (or driving) a browser. Screenshots
// land in the Artifacts domain as a `file` row backed by a base64 data URI.
// Control verbs ride the same per-workspace queue; the state read is the one
// exception that must never open a browser to answer.

import { artifactsGate } from "../artifacts/artifacts-gate.js";
import { isSafeHttpUrl } from "../shared/core/url-guard.js";
import { enqueueCommand, enqueueIfOpen } from "./browser-session.js";
import type { browserLoadState } from "./browser-types.js";

/** Read output cap: page text is fed straight into a model context. */
const READ_TEXT_LIMIT = 20000;

export interface browserScreenshotContext {
  agentId: string;
  workspaceId: string;
  runId?: string | null;
}

export interface browserWaitOptions {
  selector?: string;
  loadState?: browserLoadState;
  timeoutMs?: number;
}

/** Navigate the workspace's page and report where it actually landed. */
export async function navigateBrowser(
  workspaceId: string,
  url: string,
): Promise<{ url: string; title: string }> {
  if (!isSafeHttpUrl(url)) {
    throw new Error(`Refusing to navigate to "${url}": URL failed the http/https safety guard.`);
  }
  return enqueueCommand(workspaceId, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { url: page.url(), title: await page.title() };
  });
}

/**
 * Open the workspace browser without navigating: the operator needs a page
 * (about:blank is fine) to log in before handing control to an agent.
 */
export async function openBrowser(workspaceId: string): Promise<{ url: string; title: string }> {
  return enqueueCommand(workspaceId, async (page) => ({
    url: page.url(),
    title: await page.title(),
  }));
}

/** Capture the current page as a PNG artifact on disk + an artifact row. */
export async function screenshotBrowser(
  workspaceId: string,
  ctx: browserScreenshotContext,
): Promise<{ artifactId: string; path: string; url: string; title: string }> {
  return enqueueCommand(workspaceId, async (page) => {
    const png = await page.screenshot({ type: "png" });
    const url = page.url();
    const title = await page.title();
    const row = await artifactsGate.create({
      workspaceId,
      producerAgent: ctx.agentId,
      runId: ctx.runId ?? null,
      type: "file",
      path: "browser-screenshot-" + Date.now() + ".png",
      contentRef: "data:image/png;base64," + png.toString("base64"),
      metadata: { url, title },
    });
    // row.path may be null when the filesystem write failed; the row id is
    // still the durable pointer, so keep it and report an empty path.
    return { artifactId: row.id, path: row.path ?? "", url, title };
  });
}

/** Click a selector on the workspace's page and report where it left us. */
export async function clickBrowser(
  workspaceId: string,
  selector: string,
): Promise<{ url: string; title: string }> {
  return enqueueCommand(workspaceId, async (page) => {
    await page.click(selector);
    return { url: page.url(), title: await page.title() };
  });
}

/** Fill an input/textarea/contenteditable identified by selector. */
export async function typeBrowser(
  workspaceId: string,
  selector: string,
  text: string,
): Promise<{ url: string; title: string }> {
  return enqueueCommand(workspaceId, async (page) => {
    await page.fill(selector, text);
    return { url: page.url(), title: await page.title() };
  });
}

/** Click viewport coordinates on the workspace's page (panel takeover). */
export async function clickAtBrowser(
  workspaceId: string,
  x: number,
  y: number,
): Promise<{ url: string; title: string }> {
  return enqueueCommand(workspaceId, async (page) => {
    await page.mouseClick(x, y);
    return { url: page.url(), title: await page.title() };
  });
}

/** Type into the focused element on the workspace's page (panel takeover). */
export async function typeTextBrowser(
  workspaceId: string,
  text: string,
): Promise<{ url: string; title: string }> {
  return enqueueCommand(workspaceId, async (page) => {
    await page.keyboardType(text);
    return { url: page.url(), title: await page.title() };
  });
}

/**
 * Read the rendered text of the page body. Capped because the output goes into
 * the model's context; `truncated` tells the caller the cut happened.
 */
export async function readBrowser(workspaceId: string): Promise<{
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}> {
  return enqueueCommand(workspaceId, async (page) => {
    const raw = await page.innerText("body");
    const truncated = raw.length > READ_TEXT_LIMIT;
    return {
      url: page.url(),
      title: await page.title(),
      text: truncated ? raw.slice(0, READ_TEXT_LIMIT) : raw,
      truncated,
    };
  });
}

/** Wait for a selector to become visible, or for a page load state. */
export async function waitBrowser(
  workspaceId: string,
  opts: browserWaitOptions,
): Promise<{ url: string; title: string }> {
  // Validate before enqueue: a no-op wait would silently report success.
  if (!opts.selector && !opts.loadState) {
    throw new Error("waitBrowser requires a selector or a loadState.");
  }
  const timeout = opts.timeoutMs ?? 30000;
  return enqueueCommand(workspaceId, async (page) => {
    if (opts.selector) {
      await page.waitForSelector(opts.selector, { state: "visible", timeout });
    } else {
      await page.waitForLoadState(opts.loadState ?? "load", { timeout });
    }
    return { url: page.url(), title: await page.title() };
  });
}

/**
 * Probe the current page without touching a browser that is not open: `open`
 * is a fact, never a suggestion to launch one.
 */
export async function getBrowserState(workspaceId: string): Promise<{
  open: boolean;
  url: string | null;
  title: string | null;
}> {
  const state = await enqueueIfOpen(workspaceId, async (page) => ({
    open: true,
    url: page.url(),
    title: await page.title(),
  }));
  return state ?? { open: false, url: null, title: null };
}
