// ─── Instruction tools ──────────────────────────────────────────────────
// The Tools domain owns the agent-facing verbs; the instruction modules and
// the agent's stack belong to the Modules/Agents domains and are reached
// through their gates.
//
// Mounting is DELIBERATE and agent-driven. CrowdOS hosts many agents with
// distinct roles, so a brief is never auto-injected: an agent mounts a
// markdown file as its own operating instructions, and only for itself. The
// agent's identity (name, title, tier persona) comes from a different
// context block and is never touched here.

import fs from "node:fs/promises";
import path from "node:path";
import { Guard } from "./safety/guard.js";
import { resolveToolRoot } from "./tool-root.js";
import type { ToolRegistry } from "./tool-registry.js";

/** Instruction text becomes prompt content: cap it like a page read. */
const MAX_INSTRUCTION_CHARS = 20000;
/** Read ceiling for the source file before it is truncated to the char cap. */
const MAX_SOURCE_BYTES = 1_048_576;

/**
 * The instruction modules and the agent's stack live in the Modules/Agents
 * domains. Their gates are loaded lazily: the registry is imported by every
 * process that boots the server, and the agents+modules graph must not be
 * dragged into that import.
 */
async function loadInstructionGates() {
  const { agentGate } = await import("../agents/agent-gate.js");
  const { moduleGate } = await import("../modules/module-gate.js");
  return { agentGate, moduleGate };
}

/**
 * Label for a mounted file: `<repo>/<relative path>`. The repo folder keeps
 * two mounted repositories from colliding on the same relative filename, and
 * the label stays readable in the Agent Studio.
 */
function mountLabel(root: string, requested: string): string {
  const rel = path.relative(root, requested).split(path.sep).join("/");
  const repo = path.basename(root);
  return rel ? `${repo}/${rel}` : repo;
}

/** The agent's current instruction stack, as labels. */
async function currentStack(agentId: string, workspaceId?: string | null): Promise<string[]> {
  const { agentGate, moduleGate } = await loadInstructionGates();
  const links = (await agentGate
    .getInstructionStack(agentId, undefined, workspaceId)
    .catch(() => [] as any[])) as Array<{ instructionModuleId: string }>;
  const labels: string[] = [];
  for (const link of links) {
    const mod = await moduleGate.instruction.get(link.instructionModuleId, workspaceId).catch(() => null);
    labels.push(mod?.label ?? link.instructionModuleId);
  }
  return labels;
}

export function registerInstructionTools(registry: ToolRegistry): void {
  registry.register({
    id: "mount_instructions",
    name: "mount_instructions",
    displayName: "Mount Instructions",
    description:
      "Mount a markdown file from the mounted repository as YOUR OWN operating instructions, replacing the " +
      "instruction modules you currently run with. The file becomes the agent's instruction stack; the " +
      "agent's identity and role are unaffected. Use it when the operator asks you to adopt a brief or a " +
      "protocol file. Effective from your next turn - the mounted text is returned so you can act on it now. " +
      "Pair it with discard_instructions to go back to your profile instructions.",
    category: "system",
    sourceType: "native",
    effectClass: "side-effect",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Markdown file to mount, relative to the mounted repository root (e.g. 'AGENT.md').",
        },
      },
      required: ["path"],
    },
    dangerLevel: "moderate",
    // L0/L1/L2 may mount. L3 workers are stateless - a worker must not
    // durably rewrite the instructions it runs under.
    authLevelRequired: 2,
    handler: async (args, ctx) => {
      try {
        const requested = typeof args?.path === "string" ? args.path.trim() : "";
        if (!requested) {
          return { success: false, output: "", error: "mount_instructions requires a non-empty path." };
        }
        const root = await resolveToolRoot(ctx);
        const resolved = await Guard.validatePath(requested, root);
        const st = await fs.stat(resolved).catch(() => null);
        if (!st || !st.isFile()) {
          return { success: false, output: "", error: `Not a readable file: ${requested}` };
        }
        if (st.size > MAX_SOURCE_BYTES) {
          return {
            success: false,
            output: "",
            error: `File is ${st.size} bytes, over the ${MAX_SOURCE_BYTES}-byte read cap: ${requested}`,
          };
        }
        const raw = await fs.readFile(resolved, "utf8");
        const truncated = raw.length > MAX_INSTRUCTION_CHARS;
        const base = [truncated ? raw.slice(0, MAX_INSTRUCTION_CHARS) : raw];

        const label = mountLabel(root, resolved);
        const workspaceId = ctx.workspaceId ?? null;
        const { agentGate, moduleGate } = await loadInstructionGates();
        const existing = (await moduleGate.instruction.list({ workspaceId })).find((m) => m.label === label);
        const module = existing
          ? await moduleGate.instruction.update(existing.id, { label, base }, workspaceId)
          : await moduleGate.instruction.create({ label, base }, workspaceId);
        if (!module) {
          return { success: false, output: "", error: `Could not create instruction module for ${label}.` };
        }

        // Mounting REPLACES the instruction modules this agent runs under. The
        // agent's profile module is remembered on the agent row, so
        // discard_instructions can restore it.
        await agentGate.replaceInstructionStack(ctx.agentId, [module.id], undefined, workspaceId);

        return {
          success: true,
          output: JSON.stringify({
            mounted: label,
            moduleId: module.id,
            chars: base[0].length,
            truncated,
            stack: await currentStack(ctx.agentId, workspaceId),
            effectiveFrom: "next turn",
            content: base[0],
          }),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });

  registry.register({
    id: "discard_instructions",
    name: "discard_instructions",
    displayName: "Discard Instructions",
    description:
      "Discard the operating instructions you mounted and go back to the instructions on your agent profile. " +
      "The agent's identity and role are unaffected. Use it when a brief no longer applies.",
    category: "system",
    sourceType: "native",
    effectClass: "side-effect",
    parameters: {
      type: "object",
      properties: {},
    },
    dangerLevel: "moderate",
    authLevelRequired: 2,
    handler: async (_args, ctx) => {
      try {
        const workspaceId = ctx.workspaceId ?? null;
        const { agentGate } = await loadInstructionGates();
        const agent = await agentGate.getById(ctx.agentId, undefined, workspaceId).catch(() => null);
        const profileModuleId = agent?.instructionModuleId ?? null;
        await agentGate.replaceInstructionStack(ctx.agentId, profileModuleId ? [profileModuleId] : [], undefined, workspaceId);
        return {
          success: true,
          output: JSON.stringify({
            restored: profileModuleId ? "profile" : "none",
            stack: await currentStack(ctx.agentId, workspaceId),
            effectiveFrom: "next turn",
          }),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err?.message || String(err) };
      }
    },
  });
}
