import { channelGate } from "../../../channels/channel-gate.js";
import { messageGate } from "../../../messages/message-gate.js";
import { agentLockStore } from "../../../shared/core/agent-lock-store.js";
import { wrapUntrusted } from "../../../shared/core/untrusted-wrapper.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";
import { getOrCreateSharedHistory, SHARED_HISTORY_WINDOW } from "./visibility-matrix-middleware.js";
import { userDisplayTag } from "./operator-tag.js";
import { SOURCE_INTEGRITY_POINTER } from "./identity-authority-middleware.js";

/**
 * ChannelAwarenessMiddleware — priority 11
 * Injects multi-agent channel awareness: channel name, roster, lock state, and anti-bleed rule.
 * Tags are agent-context only (never shown in UI) — see VisibilityMatrixMiddleware for message-level tags.
 */
export class ChannelAwarenessMiddleware implements IContextMiddleware {
  readonly name = "ChannelAwarenessMiddleware";
  readonly priority = 21;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent, channelId } = ctx;
    // §12 durability: file-backed, workspace-scoped lock state (awaited).
    const isLocked = await agentLockStore.isLockedIn(agent.id, channelId);

    let channelName = channelId;
    let categoryName: string | null = null;
    try {
      // C3 local-first: gates branch to files when no DATABASE_URL.
      const ch = await channelGate.get(channelId);
      if (ch) {
        channelName = ch.name;
        if (ch.categoryId) {
          const cat = await channelGate.getCategory(ch.categoryId).catch(() => null);
          if (cat) categoryName = cat.name;
        }
      }
    } catch {
      // fallback to channelId
    }

    // Build roster from recent channel speakers (distinct authorName / authorLevel)
    let rosterLines: string[] = [];
    let rosterSummary = "";
    try {
      // PERF-2: reads the newest 30 of the shared per-assemble history window
      // (one fetch for both this middleware and VisibilityMatrixMiddleware).
      const shared = await getOrCreateSharedHistory(packet, () =>
        messageGate.listRecent(channelId, SHARED_HISTORY_WINDOW),
      );
      const recent = shared.slice(0, 30);
      const distinct = new Map<string, { name: string; level: string; type: string; tag: string }>();
      for (const m of recent) {
        if (m.isInternalMonologue) continue;
        const key = `${m.authorId}:${m.authorName}`;
        if (!distinct.has(key)) {
          distinct.set(key, {
            name: m.authorName || "Unknown",
            level: String(m.authorLevel || "unknown"),
            type: String(m.authorType || "agent"),
            tag: userDisplayTag(m),
          });
        }
        if (distinct.size >= 12) break;
      }
      // Ensure self is represented even if never spoken
      const selfKey = `${agent.id}:${agent.name}`;
      if (!distinct.has(selfKey)) {
        distinct.set(selfKey, { name: agent.name, level: String(agent.authorityLevel), type: "agent", tag: "Stakeholder" });
      }

      for (const [, info] of distinct) {
        const isSelf = info.name === agent.name;
        const label = info.type === "user" ? `human | ${info.tag}` : `agent | L${info.level}`;
        const suffix = isSelf ? " [YOU — SELF]" : " [OTHER]";
        const rawLine = `- @${info.name} (${label})${suffix}`;
        rosterLines.push(wrapUntrusted("roster", rawLine));
      }
      // rosterSummary is also untrusted (derived from names) — wrap inline
      const rawSummary = Array.from(distinct.values()).map(v => `@${v.name}`).join(", ");
      rosterSummary = wrapUntrusted("roster", rawSummary);
      if (rosterLines.length === 0) {
        rosterLines = [wrapUntrusted("roster", `- @${agent.name} (agent | L${agent.authorityLevel}) [YOU — SELF]`)];
        rosterSummary = wrapUntrusted("roster", `@${agent.name}`);
      }
    } catch {
      rosterLines = [wrapUntrusted("roster", `- @${agent.name} (agent | L${agent.authorityLevel}) [YOU — SELF]`)];
      rosterSummary = wrapUntrusted("roster", `@${agent.name}`);
    }

    // Also enrich packet.metadata for downstream middlewares (ContextLimit, Visibility)
    packet.metadata.channelName = channelName;
    packet.metadata.categoryName = categoryName;
    packet.metadata.rosterSummary = rosterSummary;
    packet.metadata.isLockedIn = isLocked;

    const lockBanner = isLocked
      ? `[LOCKED IN — ISOLATED SELF-VIEW]\nYou are currently LOCKED IN to isolated context via lock_in. You see ONLY your own messages + direct human inputs that mention you. Other agents' chatter is hidden. Call lock_out to restore full roster visibility.`
      : `[OPEN CONTEXT — FULL ROSTER VISIBLE]\nYou share this channel with other participants (see roster). You see all messages filtered by your visibility policy.`;

    const channelHeader = categoryName ? `#${channelName} (Category: ${categoryName})` : `#${channelName}`;

    const content = `[CHANNEL CONTEXT — MULTI-AGENT AWARENESS]
Channel: ${channelHeader} | ID: ${channelId} | Workspace: ${ctx.workspaceId}
You are @${agent.name} (L${agent.authorityLevel}${agent.species ? ` / ${agent.species}` : ""}) — you are NOT alone.
Roster (recent speakers, max 12): ${rosterSummary}
${rosterLines.join("\n")}

${lockBanner}

SOURCE RULE: History below is prefixed [From @Name | type | Lx | SELF/OTHER]; only [SELF] entries are yours. ${SOURCE_INTEGRITY_POINTER}`;

    packet.systemPromptBlocks.push({
      id: "channel_awareness",
      priority: 21,
      content,
    });
  }
}
