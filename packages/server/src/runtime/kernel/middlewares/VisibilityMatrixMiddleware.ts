import { eq, desc } from "drizzle-orm";
import { getDb } from "../../../Shared/config/database.js";
import { messages } from "../../../db/schema.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext, HistoryMessage } from "../contextTypes.js";

export class VisibilityMatrixMiddleware implements IContextMiddleware {
  readonly name = "VisibilityMatrixMiddleware";
  readonly priority = 70;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const db = getDb();
    const { agent, channelId } = ctx;
    const limit = 30;

    const rawMessages = await db.query.messages.findMany({
      where: eq(messages.channelId, channelId),
      orderBy: [desc(messages.timestamp)],
      limit: limit * 2,
    });

    const policy = agent.memorySharingPolicy || "full";
    const agentNameLower = agent.name.toLowerCase();

    const filtered = rawMessages.filter((m) => {
      if (m.isInternalMonologue) return false;
      if (m.authorType === "user") return true;
      if (m.authorId === agent.id) return true;

      // Policy checks
      if (policy === "full") return true;

      const contentLower = m.content.toLowerCase();
      const mentionsMe = contentLower.includes(`@${agentNameLower}`);
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

    // Sort ascending for chronological history
    filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const sliced = filtered.slice(-limit);

    packet.history = sliced.map((m): HistoryMessage => ({
      role: m.authorType === "user" ? "user" : "assistant",
      content: m.content,
      authorName: m.authorName || "User",
      timestamp: m.timestamp,
      isInternalMonologue: m.isInternalMonologue,
    }));
  }
}
