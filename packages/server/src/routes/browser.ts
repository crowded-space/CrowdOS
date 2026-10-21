import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { browserGate } from "../Browser/browser-gate.js";

const workspaceBody = z.object({ workspaceId: z.string().optional() });
const stateQuery = z.object({ workspaceId: z.string().optional() });

const openBody = z.object({
  workspaceId: z.string().optional(),
  url: z.string().optional(),
});

// The action verb decides which fields are required; a plain union would let
// click through without a selector and only fail inside Playwright.
const actionBody = z
  .object({
    workspaceId: z.string().optional(),
    action: z.enum(["click", "type", "navigate", "clickAt", "typeText"]),
    selector: z.string().optional(),
    text: z.string().optional(),
    url: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "click" && !value.selector?.trim()) {
      ctx.addIssue({ code: "custom", message: "action 'click' requires a non-empty selector", path: ["selector"] });
    }
    if (value.action === "type") {
      if (!value.selector?.trim()) {
        ctx.addIssue({ code: "custom", message: "action 'type' requires a non-empty selector", path: ["selector"] });
      }
      if (!value.text) {
        ctx.addIssue({ code: "custom", message: "action 'type' requires non-empty text", path: ["text"] });
      }
    }
    if (value.action === "navigate" && !value.url?.trim()) {
      ctx.addIssue({ code: "custom", message: "action 'navigate' requires a non-empty url", path: ["url"] });
    }
    // Panel coordinates arrive as viewport pixels: both must be finite and >= 0
    // or Playwright gets a click outside the page.
    if (value.action === "clickAt") {
      if (typeof value.x !== "number" || !Number.isFinite(value.x) || value.x < 0) {
        ctx.addIssue({ code: "custom", message: "action 'clickAt' requires x as a finite number >= 0", path: ["x"] });
      }
      if (typeof value.y !== "number" || !Number.isFinite(value.y) || value.y < 0) {
        ctx.addIssue({ code: "custom", message: "action 'clickAt' requires y as a finite number >= 0", path: ["y"] });
      }
    }
    if (value.action === "typeText" && !value.text) {
      ctx.addIssue({ code: "custom", message: "action 'typeText' requires non-empty text", path: ["text"] });
    }
  });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function browserRoutes(app: FastifyInstance) {
  // Local-first: loopback is the trust boundary; no role gates (single user).
  app.get("/api/browser/state", async (request, reply) => {
    const parsed = stateQuery.safeParse((request as any).query ?? {});
    if (!parsed.success) return reply.status(400).send({ ok: false, error: parsed.error.message });
    try {
      return await browserGate.state(parsed.data.workspaceId ?? "default");
    } catch (err) {
      return reply.status(400).send({ ok: false, error: errorMessage(err) });
    }
  });

  app.post("/api/browser/open", async (request, reply) => {
    const parsed = openBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ ok: false, error: parsed.error.message });
    const workspaceId = parsed.data.workspaceId ?? "default";
    const url = parsed.data.url?.trim();
    try {
      const result = url
        ? await browserGate.navigate(workspaceId, url)
        : await browserGate.open(workspaceId);
      return reply.send({ ok: true, url: result.url, title: result.title });
    } catch (err) {
      return reply.status(400).send({ ok: false, error: errorMessage(err) });
    }
  });

  app.post("/api/browser/action", async (request, reply) => {
    const parsed = actionBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ ok: false, error: parsed.error.message });
    const { workspaceId: rawWorkspaceId, action, selector, text, url, x, y } = parsed.data;
    const workspaceId = rawWorkspaceId ?? "default";
    try {
      const result =
        action === "click"
          ? await browserGate.click(workspaceId, selector!)
          : action === "type"
            ? await browserGate.type(workspaceId, selector!, text!)
            : action === "clickAt"
              ? await browserGate.clickAt(workspaceId, x!, y!)
              : action === "typeText"
                ? await browserGate.typeText(workspaceId, text!)
                : await browserGate.navigate(workspaceId, url!);
      return reply.send({ ok: true, url: result.url, title: result.title });
    } catch (err) {
      return reply.status(400).send({ ok: false, error: errorMessage(err) });
    }
  });

  app.post("/api/browser/close", async (request, reply) => {
    const parsed = workspaceBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ ok: false, error: parsed.error.message });
    // Best-effort: close is the operator's "stop watching" verb, not a probe.
    try {
      await browserGate.close(parsed.data.workspaceId ?? "default");
    } catch {}
    return reply.send({ ok: true });
  });
}
