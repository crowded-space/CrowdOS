import { wrapUntrusted } from "../../../shared/core/untrusted-wrapper.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";

/**
 * OperatorContextMiddleware — priority 22.
 *
 * Injects the human operator's advisory identity + preference (client user
 * profile) as a single low-precedence block, directly after identity (20) and
 * channel awareness (21). Null/empty preference pushes NOTHING — honest
 * empty, never a placeholder block. The preference is operator-authored but
 * still model-facing text, so it rides inside the untrusted wrapper like the
 * roster lines (second-order injection defense).
 */
export class OperatorContextMiddleware implements IContextMiddleware {
  readonly name = "OperatorContextMiddleware";
  readonly priority = 22;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const op = ctx.operatorContext;
    const preference = typeof op?.preference === "string" ? op.preference.trim().slice(0, 2000) : "";
    if (!preference) return;
    const name = typeof op?.name === "string" && op.name.trim() ? op.name.trim().slice(0, 80) : "operator";
    const tag = typeof op?.tag === "string" && op.tag.trim() ? op.tag.trim().slice(0, 24) : "Human";
    // Prevent user-injected fake history/author tags: escape "[From " at line start.
    const safePreference = preference.replace(/^\[From /gim, "[ From ");
    const content = `[OPERATOR CONTEXT — HUMAN PREFERENCE]\nOperator: @${name} (${tag})\nPreferences: ${wrapUntrusted("operator", safePreference)}`;
    packet.systemPromptBlocks.push({
      id: "operator_context",
      priority: 22,
      content,
    });
  }
}
