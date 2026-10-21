// ─── Browser domain types ─────────────────────────────────────────────
// Deliberately minimal: only the calls this domain actually makes. The launcher
// returns this exact handle shape so tests can inject a fake page without
// importing (or launching) Playwright.

export interface browserGotoOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeout?: number;
}

export interface browserScreenshotOptions {
  type?: "png" | "jpeg";
  /** JPEG quality (1-100). Ignored for PNG. */
  quality?: number;
}

export type browserLoadState = "load" | "domcontentloaded" | "networkidle";
export type browserSelectorState = "attached" | "visible" | "hidden" | "detached";

export interface browserPage {
  goto(url: string, opts?: browserGotoOptions): Promise<unknown>;
  screenshot(opts?: browserScreenshotOptions): Promise<Buffer>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  // Panel takeover: the image has no DOM, so the operator clicks viewport
  // coordinates and types into whatever element already has focus.
  mouseClick(x: number, y: number): Promise<void>;
  keyboardType(text: string): Promise<void>;
  innerText(selector: string): Promise<string>;
  waitForSelector(
    selector: string,
    opts?: { state?: browserSelectorState; timeout?: number },
  ): Promise<unknown>;
  waitForLoadState(state?: browserLoadState, opts?: { timeout?: number }): Promise<void>;
  title(): Promise<string>;
  url(): string;
}

export interface browserHandle {
  page: browserPage;
  close(): Promise<void>;
}

export type browserLauncher = (profileDir: string) => Promise<browserHandle>;
