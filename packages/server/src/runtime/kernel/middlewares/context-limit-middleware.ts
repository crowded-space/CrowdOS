import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";
import { accountPromptTokens, resolveEffectiveContextCap, trimHistoryToCap } from "../context-budget.js";

/**
 * ContextLimitMiddleware — priority 85
 * Enforces per-agent input context token cap (agent-context only).
 * Trims oldest [OTHER] history turns first; the newest [SELF] turn is preserved.
 * Respects agents.contextTokenCap (if set) else falls back to packet.policies.maxTokenBudget.
 *
 * Runs LAST (after VisibilityMatrix 70 and HistoryCompression 80) so the token
 * accounting includes the compressed-summary prompt block — otherwise compaction
 * itself can re-overflow the cap.
 *
 * PERF-3: accounting now includes tool JSON schemas, and the resolved effective
 * cap is clamped into packet.policies.maxTokenBudget even when nothing needed
 * trimming — agentic loops re-check that same value every iteration.
 */
export class ContextLimitMiddleware implements IContextMiddleware {
  readonly name = "ContextLimitMiddleware";
  readonly priority = 85;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const effectiveCap = resolveEffectiveContextCap({
      agentContextTokenCap: (ctx.agent as unknown as { contextTokenCap?: number }).contextTokenCap,
      customContextTokenCap: ctx.customOverrides?.contextTokenCap,
      maxTokenBudget: packet.policies.maxTokenBudget,
    });
    if (!effectiveCap) return;

    const account = accountPromptTokens({
      systemPrompt: packet.systemPromptBlocks.map(b => b.content).join("\n\n"),
      history: packet.history,
      userPrompt: packet.userPrompt,
      memoryPreviewBlock: packet.memoryPreviewBlock,
      tools: packet.tools,
    });

    // Clamp the policy budget so downstream consumers (per-iteration budget
    // re-checks in agentic loops) share this exact cap.
    if (
      typeof packet.policies.maxTokenBudget !== "number" ||
      packet.policies.maxTokenBudget <= 0 ||
      packet.policies.maxTokenBudget > effectiveCap
    ) {
      packet.policies.maxTokenBudget = effectiveCap;
    }

    if (account.totalTokens <= effectiveCap) return;

    const historyTokensTotal = account.historyTokens.reduce((sum, t) => sum + t, 0);
    const originalLen = packet.history.length;
    const result = trimHistoryToCap(packet.history, {
      capTokens: effectiveCap,
      fixedTokens: account.totalTokens - historyTokensTotal,
    });
    if (!result.trimmed) return;

    packet.history = result.history;

    // Metadata for observability
    packet.metadata.contextLimitTrimmed = {
      originalHistoryLen: originalLen,
      trimmedCount: result.removedCount,
      newHistoryLen: packet.history.length,
      cap: effectiveCap,
      originalTotalTokens: account.totalTokens,
    };

    // Inject diagnostic block (low priority, visible to agent)
    packet.systemPromptBlocks.push({
      id: "context_limit_notice",
      priority: 74,
      content: `[CONTEXT LIMIT ENFORCED — agent-context only]\nPer-agent input cap: ${effectiveCap} tokens. Trimmed ${result.removedCount} oldest turns (from ${originalLen} to ${packet.history.length}) to fit budget. Roster and recent turns preserved.`,
    });

    console.log(`[ContextLimitMiddleware] @${ctx.agent.name} locked?=${packet.metadata.isLockedIn} trimmed ${result.removedCount}/${originalLen} turns to fit cap ${effectiveCap} (was ~${account.totalTokens} tokens)`);
  }
}
