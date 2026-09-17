import { messageGate } from "../../../messages/message-gate.js";
import { agentLockStore } from "../../../shared/core/agent-lock-store.js";
import { wrapUntrusted } from "../../../shared/core/untrusted-wrapper.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext, HistoryMessage } from "../context-types.js";

/**
 * VisibilityMatrixMiddleware — priority 70
 * Enforces memory sharing policy + lock_in isolation + bracket source tagging (agent-context only).
 * Fixes context bleed: only self messages become 'assistant'; all others become 'user' with [From @Name | type | Lx | SELF/OTHER] prefix.
 * Tags are NEVER shown in UI — only in LLM history content.
 */

function escapeBracketContent(content: string): string {
  // Prevent user-injected fake tags: escape "[From " at line start
  return content.replace(/\[From @/g, "[From\u200B @");
}

/**
 * PERF-2: per-assemble shared history memo. VisibilityMatrix (60) and
 * ChannelAwareness (30) both need recent channel messages; whoever runs first
 * starts ONE fetch of the larger window on the packet and the other awaits it.
 */
const SHARED_HISTORY_KEY = "__sharedHistoryFetch";

interface SharedHistoryMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string | null;
  authorLevel: string | null;
  authorType: string;
  content: string;
  mentions: unknown;
  isInternalMonologue: boolean;
  timestamp: Date | string;
}

interface SharedHistoryMemo {
  promise: Promise<SharedHistoryMessage[]>;
}

export const SHARED_HISTORY_WINDOW = 60;

export function getOrCreateSharedHistory(
  packet: MutableContextPacket,
  fetchWindow: () => Promise<SharedHistoryMessage[]>,
): Promise<SharedHistoryMessage[]> {
  const memo = packet.metadata as Record<string, unknown>;
  let shared = memo[SHARED_HISTORY_KEY] as SharedHistoryMemo | undefined;
  if (!shared) {
    shared = { promise: fetchWindow() };
    memo[SHARED_HISTORY_KEY] = shared;
  }
  return shared.promise;
}

function formatBracketTag(m: any, isSelf: boolean, agentName: string): string {
  const type = m.authorType || "agent";
  const level = type === "user" ? "Stakeholder" : `L${m.authorLevel ?? "?"}`;
  const selfTag = isSelf ? "SELF" : "OTHER";
  // Use authorName as handle; human placeholder future UserProfile will flow via authorName
  const safeName = (m.authorName || "User").replace(/[\[\]|]/g, "");
  const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : "";
  return `[From @${safeName} | ${type} | ${level} | ${selfTag}${ts ? ` | ${ts}` : ""}]`;
}

export class VisibilityMatrixMiddleware implements IContextMiddleware {
  readonly name = "VisibilityMatrixMiddleware";
  readonly priority = 70;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent, channelId } = ctx;
    const limit = 30;

    // C3 local-first: messageGate branches to files when no DATABASE_URL.
    const rawMessages = await getOrCreateSharedHistory(packet, () =>
      messageGate.listRecent(channelId, SHARED_HISTORY_WINDOW),
    );

    const isLockedIn = agentLockStore.isLockedIn(agent.id, channelId);

    // Lock-aware filtering: when locked_in, only self + human messages that mention self are visible
    let filtered: typeof rawMessages;
    if (isLockedIn) {
      const agentNameLower = agent.name.toLowerCase();
      filtered = rawMessages.filter((m) => {
        if (m.isInternalMonologue) return false;
        if (m.authorId === agent.id) return true;
        if (m.authorType === "user") {
          // Only human messages that mention this agent (bracket-tagged mention or fallback)
          const contentLower = m.content.toLowerCase();
          const mentionsMe =
            (Array.isArray((m as any).mentions) && (m as any).mentions.some((x: any) => String(x.targetName || "").toLowerCase() === agentNameLower || String(x.targetName || "").toLowerCase() === `@${agentNameLower}`)) ||
            contentLower.includes(`@${agentNameLower}`);
          // In lock mode keep only mentioned human turns to avoid noise
          return mentionsMe;
        }
        return false; // hide all other agents
      });
    } else {
      const policy = agent.memorySharingPolicy || "full";
      const agentNameLower = agent.name.toLowerCase();

      filtered = rawMessages.filter((m) => {
        if (m.isInternalMonologue) return false;
        if (m.authorType === "user") return true;
        if (m.authorId === agent.id) return true;

        // Policy checks
        if (policy === "full") return true;

        const contentLower = m.content.toLowerCase();
        const mentionsMe =
          (Array.isArray((m as any).mentions) && (m as any).mentions.some((x: any) => String(x.targetName || "").toLowerCase() === agentNameLower || String(x.targetName || "").toLowerCase() === `@${agentNameLower}`)) ||
          contentLower.includes(`@${agentNameLower}`);
        if (mentionsMe) return true;

        if (policy === "none") {
          return false;
        }

        const authorLevel = Number(m.authorLevel || 3);

        if (policy === "horizontal") {
          return authorLevel === agent.authorityLevel;
        }

        if (policy === "vertical") {
          return Math.abs(authorLevel - agent.authorityLevel) <= 1;
        }

        return true;
      });
    }

    // Sort ascending for chronological history
    filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const sliced = filtered.slice(-limit);

    // Bracket-tagged history: self → assistant (SELF), others → user (OTHER). Agent-context only.
    // CTX-2: untrusted history content is wrapped with attribution + escaping.
    packet.history = sliced.map((m): HistoryMessage => {
      const isSelf = m.authorId === agent.id;
      const role = isSelf ? "assistant" : "user";
      const tag = formatBracketTag(m, isSelf, agent.name);
      const safeContent = escapeBracketContent(m.content);
      const wrapped = wrapUntrusted("history", safeContent);
      const taggedContent = `${tag} ${wrapped}`;
      return {
        role,
        content: taggedContent,
        authorName: m.authorName || "User",
        authorId: m.authorId,
        authorType: m.authorType as any,
        authorLevel: String(m.authorLevel ?? ""),
        isSelf,
        mentions: (m as any).mentions,
        timestamp: new Date(m.timestamp),
        isInternalMonologue: m.isInternalMonologue,
      };
    });
  }
}
