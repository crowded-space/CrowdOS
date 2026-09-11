import type { ContextPacket, ExecutionMetadata, HistoryMessage, LLMToolDefinition } from "../types.js";

/**
 * PERF-3 per-iteration context budget.
 *
 * ContextLimitMiddleware enforces the agent-context cap once, at assembly time.
 * Agentic loops then append monologue + tool-result turns every iteration and
 * re-call the LLM with the accumulated history — historically with no re-check,
 * so prompts grew past the cap (O(n²) prompt growth). This module provides the
 * shared accounting/trim helpers so EVERY LLM call can be re-checked against
 * the same cap the assembler used.
 */

export const CHARS_PER_TOKEN = 4;

/** Floor: don't enforce below 1000 tokens (prevents destroying reasoning). */
export const MIN_EFFECTIVE_CAP_TOKENS = 1000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tool JSON schemas ride along on every call but were never counted. */
export function estimateToolSchemaTokens(tools?: LLMToolDefinition[] | null): number {
  if (!tools || tools.length === 0) return 0;
  try {
    return estimateTokens(JSON.stringify(tools));
  } catch {
    return 0;
  }
}

export interface ContextCapInput {
  agentContextTokenCap?: unknown;
  customContextTokenCap?: unknown;
  maxTokenBudget?: number;
}

/**
 * Single source of truth for cap resolution, shared by ContextLimitMiddleware
 * (assembly time) and the per-iteration re-check (via policies.maxTokenBudget,
 * which ContextLimit clamps to the resolved effective cap).
 * Precedence: agent.contextTokenCap > customOverrides.contextTokenCap > packet.policies.maxTokenBudget.
 */
export function resolveEffectiveContextCap(input: ContextCapInput): number | null {
  const candidates = [input.agentContextTokenCap, input.customContextTokenCap];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && candidate > 0) {
      return Math.max(candidate, MIN_EFFECTIVE_CAP_TOKENS);
    }
  }
  if (typeof input.maxTokenBudget === "number" && input.maxTokenBudget > 0) {
    return Math.max(input.maxTokenBudget, MIN_EFFECTIVE_CAP_TOKENS);
  }
  return null;
}

/**
 * Runtime-side view of the same cap: after assembly, ContextLimitMiddleware has
 * clamped policies.maxTokenBudget down to the effective cap, so agentic loops
 * can read the cap from the packet without access to the build context.
 */
export function resolvePacketContextCap(packet: ContextPacket): number | null {
  const budget = packet.policies?.maxTokenBudget;
  if (typeof budget !== "number" || budget <= 0) return null;
  return Math.max(budget, MIN_EFFECTIVE_CAP_TOKENS);
}

export interface PromptTokenAccount {
  systemPromptTokens: number;
  /** Per-history-entry token estimates, index-aligned with the input history. */
  historyTokens: number[];
  /** userPrompt tokens including the memory-preview prefix when present. */
  userPromptTokens: number;
  toolSchemaTokens: number;
  totalTokens: number;
}

/**
 * Estimate the token footprint of an assembled prompt exactly as the provider
 * adapter will receive it: systemPrompt + (preview-prefixed userPrompt) +
 * every history entry + serialized tool schemas.
 */
export function accountPromptTokens(input: {
  systemPrompt: string;
  history: ReadonlyArray<Pick<HistoryMessage, "content">>;
  userPrompt: string;
  memoryPreviewBlock?: string;
  tools?: LLMToolDefinition[] | null;
}): PromptTokenAccount {
  // Mirrors RuntimeKernel.buildUserPrompt: `${preview}\n\n${base}`.
  const userChars = input.memoryPreviewBlock
    ? input.memoryPreviewBlock.length + 2 + input.userPrompt.length
    : input.userPrompt.length;
  const historyTokens = input.history.map((h) => estimateTokens(h.content));
  const systemPromptTokens = estimateTokens(input.systemPrompt);
  const userPromptTokens = Math.ceil(userChars / CHARS_PER_TOKEN);
  const toolSchemaTokens = estimateToolSchemaTokens(input.tools);
  const historyTotal = historyTokens.reduce((sum, t) => sum + t, 0);
  return {
    systemPromptTokens,
    historyTokens,
    userPromptTokens,
    toolSchemaTokens,
    totalTokens: systemPromptTokens + userPromptTokens + toolSchemaTokens + historyTotal,
  };
}

export interface TrimmedHistory<M> {
  history: M[];
  trimmed: boolean;
  removedCount: number;
  removedTokens: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
}

/**
 * Trim policy (PERF-3): fit fixed pieces + history under capTokens by dropping
 * history only — never the system prompt, user input, preview, or tool schemas.
 *
 * Pass 1: oldest non-self ([OTHER]/tool-result) entries first.
 * Pass 2: oldest self entries if still over — but the LAST self/monologue turn
 *         is always preserved, even when the cap cannot be met without it.
 * Returns the identical array reference untouched when already within budget.
 */
export function trimHistoryToCap<M extends HistoryMessage>(
  history: M[],
  opts: { capTokens: number; fixedTokens: number }
): TrimmedHistory<M> {
  const tokens = history.map((h) => estimateTokens(h.content));
  const totalBefore = opts.fixedTokens + tokens.reduce((sum, t) => sum + t, 0);

  let excess = totalBefore - opts.capTokens;
  if (excess <= 0) {
    return { history, trimmed: false, removedCount: 0, removedTokens: 0, totalTokensBefore: totalBefore, totalTokensAfter: totalBefore };
  }

  const removedFlags = new Array<boolean>(history.length).fill(false);
  let lastSelfIndex = -1;
  for (let i = 0; i < history.length; i++) {
    if (history[i].isSelf) lastSelfIndex = i;
  }

  // Pass 1: oldest non-self first
  for (let i = 0; i < history.length && excess > 0; i++) {
    if (history[i].isSelf) continue;
    removedFlags[i] = true;
    excess -= tokens[i];
  }
  // Pass 2: oldest self next, protecting the newest self turn
  for (let i = 0; i < history.length && excess > 0; i++) {
    if (!history[i].isSelf || i === lastSelfIndex) continue;
    removedFlags[i] = true;
    excess -= tokens[i];
  }

  const kept: M[] = [];
  let removedCount = 0;
  let removedTokens = 0;
  for (let i = 0; i < history.length; i++) {
    if (removedFlags[i]) {
      removedCount++;
      removedTokens += tokens[i];
    } else {
      kept.push(history[i]);
    }
  }

  if (removedCount === 0) {
    return { history, trimmed: false, removedCount: 0, removedTokens: 0, totalTokensBefore: totalBefore, totalTokensAfter: totalBefore };
  }

  const totalAfter = totalBefore - removedTokens;
  return { history: kept, trimmed: true, removedCount, removedTokens, totalTokensBefore: totalBefore, totalTokensAfter: totalAfter };
}

export interface PerIterationBudgetOptions {
  /** Drop the memory preview for iterations > 1 (it is already in history context). */
  dropMemoryPreview?: boolean;
  iterationIndex?: number;
}

/**
 * Re-check one LLM call's assembled prompt against the assembler's cap and
 * trim history if needed. Returns the identical packet reference when nothing
 * changes (under-cap runs stay byte-identical).
 */
export function enforcePerIterationBudget(
  packet: ContextPacket,
  opts: PerIterationBudgetOptions = {}
): ContextPacket {
  let source = packet;
  if (opts.dropMemoryPreview && source.memoryPreviewBlock !== undefined) {
    source = { ...source, memoryPreviewBlock: undefined };
  }

  const cap = resolvePacketContextCap(source);
  if (!cap) return source;

  const account = accountPromptTokens({
    systemPrompt: source.systemPrompt,
    history: source.history,
    userPrompt: source.userInput,
    memoryPreviewBlock: source.memoryPreviewBlock,
    tools: source.tools,
  });
  const historyTotal = account.historyTokens.reduce((sum, t) => sum + t, 0);
  const result = trimHistoryToCap(source.history, { capTokens: cap, fixedTokens: account.totalTokens - historyTotal });

  if (!result.trimmed && source === packet) return packet;

  const metadata: ExecutionMetadata = { ...source.metadata };
  (metadata as unknown as Record<string, unknown>).perIterationBudget = {
    iterationIndex: opts.iterationIndex,
    capTokens: cap,
    totalTokensBefore: result.totalTokensBefore,
    totalTokensAfter: result.totalTokensAfter,
    removedCount: result.removedCount,
    removedTokens: result.removedTokens,
    memoryPreviewDropped: source !== packet,
  };
  return { ...source, history: result.history, metadata };
}
