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
    if (packet.history.length > 0) {
      const lastMsg = packet.history[packet.history.length - 1];
      if (lastMsg.role === "user" && lastMsg.content.trim() === userInput.trim()) {
        packet.history.pop();
      }
    }

    // 2. Fetch cached summary if available
    try {
      const db = getDb();
      const summary = await db.query.compressedSummaries.findFirst({
        where: eq(compressedSummaries.channelId, channelId),
      });

      if (summary?.summary) {
        packet.systemPromptBlocks.push({
          id: "compressed_history_summary",
          priority: 75,
          content: `[EARLIER CHANNEL DISCUSSION SUMMARY]\n${summary.summary}`,
        });
      }
    } catch {
      // Ignored if summary table is empty
    }
  }
}
