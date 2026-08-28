import { eq } from "drizzle-orm";
import { getDb } from "../../../Shared/config/database.js";
import { compressedSummaries } from "../../../db/schema.js";
import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../contextTypes.js";

export class HistoryCompressionMiddleware implements IContextMiddleware {
  readonly name = "HistoryCompressionMiddleware";
  readonly priority = 80;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { channelId, userInput } = ctx;

    // 1. Avoid duplicate prompt if last message in history matches current userInput
    // History content is bracket-tagged [From @Name | ...] raw — strip tag before compare (agent-context only)
    if (packet.history.length > 0) {
      const lastMsg = packet.history[packet.history.length - 1];
      if (lastMsg.role === "user") {
        const stripped = lastMsg.content.replace(/^\[From @[^\]]+\]\s*/, "").trim();
        if (stripped === userInput.trim()) {
          packet.history.pop();
        }
      }
    }

    // 2. Fetch cached summary if available — ordered latest row (RT-4 stale-summary fix)
    try {
      const db = getDb();
      const summary = await db.query.compressedSummaries.findFirst({
        where: eq(compressedSummaries.channelId, channelId),
        orderBy: (table, { desc }) => [desc(table.coversUpToSeq), desc(table.createdAt)],
      });

      if (summary?.summary) {
        // Include roster summary if available from ChannelAwarenessMiddleware
        const roster = (packet.metadata.rosterSummary as string) || "";
        const channelName = (packet.metadata.channelName as string) || channelId;
        const header = roster
          ? `[EARLIER CHANNEL DISCUSSION SUMMARY | Channel: #${channelName} | Participants: ${roster} | Covers seq <= ${summary.coversUpToSeq}]`
          : `[EARLIER CHANNEL DISCUSSION SUMMARY | Channel: #${channelName} | Covers seq <= ${summary.coversUpToSeq}]`;
        packet.systemPromptBlocks.push({
          id: "compressed_history_summary",
          priority: 76,
          content: `${header}\n${summary.summary}`,
        });
      }
    } catch {
      // Ignored if summary table is empty
    }
  }
}
