import { eq, sql } from "drizzle-orm";
import { getDb } from "../config/database.js";
import { channelIndex, agents, channels } from "../../db/schema.js";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { LibrarianRuntime } from "./librarianRuntime.js";

const librarianRuntime = new LibrarianRuntime();

export class IndexBuilder {
  /**
   * Increments the new message count for a channel.
   * If the index record doesn't exist, it creates one.
   */
  static async incrementMessageCount(channelId: string): Promise<void> {
    const db = getDb();
    
    // Validate that the channel exists to satisfy foreign key constraints
    const chan = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
    });
    if (!chan) return;

    const [existing] = await db.select().from(channelIndex).where(eq(channelIndex.channelId, channelId)).limit(1);

    if (existing) {
      await db.update(channelIndex)
        .set({
          messageCountSinceIndex: sql`${channelIndex.messageCountSinceIndex} + 1`
        })
        .where(eq(channelIndex.channelId, channelId));
    } else {
      let pathName = chan.name;
      await db.insert(channelIndex).values({
        channelId,
        channelPath: `#${pathName}`,
        topicSummary: "Empty channel. Not compiled yet.",
        lastIndexedAt: new Date(),
        messageCountSinceIndex: 1
      });
    }
  }

  /**
   * Background task to reindex stale channels where drift exceeds 10 messages.
   */
  static async reindexStaleChannels(broker: EventBroker): Promise<void> {
    const db = getDb();
    
    // Find Librarian Agent profile
    const librarianAgent = await db.query.agents.findFirst({
      where: eq(agents.id, "agent-librarian"),
    });
    if (!librarianAgent) {
      console.warn("[IndexBuilder] Swarm Librarian agent not found. Postponing re-indexing.");
      return;
    }

    // Find all stale channels
    const staleIndices = await db.select().from(channelIndex).where(
      sql`${channelIndex.messageCountSinceIndex} >= 10`
    );

    if (staleIndices.length === 0) {
      console.log("[IndexBuilder] All channels index are up-to-date.");
      return;
    }

    console.log(`[IndexBuilder] Re-indexing ${staleIndices.length} stale channels...`);

    const profile = {
      ...librarianAgent,
      species: librarianAgent.species ?? undefined,
      avatar: librarianAgent.avatar ?? undefined,
    } as any;

    for (const idx of staleIndices) {
      try {
        await librarianRuntime.indexChannel(broker, profile, idx.channelId);
        console.log(`[IndexBuilder] Successfully re-indexed stale channel: ${idx.channelPath}`);
      } catch (err) {
        console.error(`[IndexBuilder] Re-indexing failed for ${idx.channelPath}:`, err);
      }
    }
  }
}
