// ─── Browser tools ────────────────────────────────────────────────────
// The Tools domain owns the agent-facing verbs; all browser state (session,
// queue, profile) belongs to the Browser domain and is reached through its
// gate. All verbs are L0+L1 (`authLevelRequired: 1`) like create_artifact.
// click/type change page or server state, so they are `moderate`/side-effect;
// read/wait/state only observe.

import { browserGate } from "../Browser/browser-gate.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerBrowserTools(registry: ToolRegistry): void {
  registry.register({
    id: "browser_navigate",
    name: "browser_navigate",
    displayName: "Browser Navigate",
    description:
      "Navigate a real browser to a public web page and report the final URL and title. " +
      "Only http/https public URLs pass the safety guard. (Levels 0-1.)",
    category: "browser",
    sourceType: "native",
    effectClass: "side-effect",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http/https URL to open. Only public URLs pass the safety guard.",
        },
      },
      required: ["url"],
    },
    dangerLevel: "safe",
    authLevelRequired: 1,
    handler: async (args, ctx) => {
      try {
        const url = typeof args?.url === "string" ? args.url.trim() : "";
        if (!url) {
          return { success: false, output: "", error: "browser_navigate requires a non-empty url." };
        }
        const workspaceId = ctx?.workspaceId ?? "default";
        const result = await browserGate.navigate(workspaceId, url);
        return { success: true, output: JSON.stringify({ url: result.url, title: result.title }) };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });

  registry.register({
    id: "browser_screenshot",
    name: "browser_screenshot",
    displayName: "Browser Screenshot",
    description:
      "Capture the current browser page as a PNG artifact stored under the workspace artifact folder. " +
      "Use after browser_navigate. (Levels 0-1.)",
    category: "browser",
    sourceType: "native",
    effectClass: "read",
    parameters: {
      type: "object",
      properties: {},
    },
    dangerLevel: "safe",
    authLevelRequired: 1,
    handler: async (_args, ctx) => {
      try {
        const workspaceId = ctx?.workspaceId ?? "default";
        const result = await browserGate.screenshot(workspaceId, {
          agentId: ctx.agentId,
          workspaceId,
          runId: ctx.runId ?? null,
        });
        return {
          success: true,
          output: JSON.stringify({
            artifactId: result.artifactId,
            path: result.path,
            url: result.url,
            title: result.title,
          }),
          artifacts: [{ type: "file", path: result.path, mimeType: "image/png" }],
        };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });

  registry.register({
    id: "browser_click",
    name: "browser_click",
    displayName: "Browser Click",
    description:
      "Click an element identified by a CSS selector on the current page and report the resulting URL and title. " +
      "Use after browser_navigate. Never enter credentials: if a login wall appears, stop and report to the operator instead of signing in. (Levels 0-1.)",
    category: "browser",
    sourceType: "native",
    effectClass: "side-effect",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the element to click.",
        },
      },
      required: ["selector"],
    },
    dangerLevel: "moderate",
    authLevelRequired: 1,
    handler: async (args, ctx) => {
      try {
        const selector = typeof args?.selector === "string" ? args.selector.trim() : "";
        if (!selector) {
          return { success: false, output: "", error: "browser_click requires a non-empty selector." };
        }
        const workspaceId = ctx?.workspaceId ?? "default";
        const result = await browserGate.click(workspaceId, selector);
        return { success: true, output: JSON.stringify({ url: result.url, title: result.title }) };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });

  registry.register({
    id: "browser_type",
    name: "browser_type",
    displayName: "Browser Type",
    description:
      "Fill an input, textarea, or contenteditable element identified by a CSS selector with text, " +
      "then report the resulting URL and title. Use after browser_navigate. Never enter credentials: if a login wall appears, stop and report to the operator instead of signing in. (Levels 0-1.)",
    category: "browser",
    sourceType: "native",
    effectClass: "side-effect",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the field to fill.",
        },
        text: {
          type: "string",
          description: "Text to fill into the field.",
        },
      },
      required: ["selector", "text"],
    },
    dangerLevel: "moderate",
    authLevelRequired: 1,
    handler: async (args, ctx) => {
      try {
        const selector = typeof args?.selector === "string" ? args.selector.trim() : "";
        if (!selector) {
          return { success: false, output: "", error: "browser_type requires a non-empty selector." };
        }
        const text = typeof args?.text === "string" ? args.text : "";
        if (!text) {
          return { success: false, output: "", error: "browser_type requires non-empty text." };
        }
        const workspaceId = ctx?.workspaceId ?? "default";
        const result = await browserGate.type(workspaceId, selector, text);
        return { success: true, output: JSON.stringify({ url: result.url, title: result.title }) };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });

  registry.register({
    id: "browser_read",
    name: "browser_read",
    displayName: "Browser Read",
    description:
      "Read the rendered text of the current page body (capped at 20000 characters) and report it with the " +
      "URL and title. Use after browser_navigate. (Levels 0-1.)",
    category: "browser",
    sourceType: "native",
    effectClass: "read",
    parameters: {
      type: "object",
      properties: {},
    },
    dangerLevel: "safe",
    authLevelRequired: 1,
    handler: async (_args, ctx) => {
      try {
        const workspaceId = ctx?.workspaceId ?? "default";
        const result = await browserGate.read(workspaceId);
        return {
          success: true,
          output: JSON.stringify({
            url: result.url,
            title: result.title,
            text: result.text,
            truncated: result.truncated,
          }),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });

  registry.register({
    id: "browser_wait",
    name: "browser_wait",
    displayName: "Browser Wait",
    description:
      "Wait until a CSS selector is visible or the page reaches a load state, then report the URL and title. " +
      "Provide at least one of selector or loadState. (Levels 0-1.)",
    category: "browser",
    sourceType: "native",
    effectClass: "read",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to wait for (visible state).",
        },
        loadState: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description: "Page load state to wait for when no selector is given.",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum wait in milliseconds (default 30000).",
        },
      },
    },
    dangerLevel: "safe",
    authLevelRequired: 1,
    handler: async (args, ctx) => {
      try {
        const selector = typeof args?.selector === "string" ? args.selector.trim() : "";
        const loadState =
          args?.loadState === "load" ||
          args?.loadState === "domcontentloaded" ||
          args?.loadState === "networkidle"
            ? args.loadState
            : undefined;
        const timeoutMs = typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined;
        if (!selector && !loadState) {
          return {
            success: false,
            output: "",
            error: "browser_wait requires a selector or a loadState.",
          };
        }
        const workspaceId = ctx?.workspaceId ?? "default";
        const result = await browserGate.wait(workspaceId, {
          selector: selector || undefined,
          loadState,
          timeoutMs,
        });
        return { success: true, output: JSON.stringify({ url: result.url, title: result.title }) };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });

  registry.register({
    id: "browser_state",
    name: "browser_state",
    displayName: "Browser State",
    description:
      "Report whether a browser is open for this workspace and, when it is, the current URL and title. " +
      "Never opens a browser. (Levels 0-1.)",
    category: "browser",
    sourceType: "native",
    effectClass: "read",
    parameters: {
      type: "object",
      properties: {},
    },
    dangerLevel: "safe",
    authLevelRequired: 1,
    handler: async (_args, ctx) => {
      try {
        const workspaceId = ctx?.workspaceId ?? "default";
        const result = await browserGate.state(workspaceId);
        return {
          success: true,
          output: JSON.stringify({
            open: result.open,
            url: result.url,
            title: result.title,
          }),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });
}
