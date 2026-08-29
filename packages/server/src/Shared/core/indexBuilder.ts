import { eq, and, gt, sql } from "drizzle-orm";
import { getDb } from "../config/database.js";
import { channelIndex, agents, channels, messages } from "../../db/schema.js";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import { LibrarianRuntime, deltaIndexEnabled } from "./librarianRuntime.js";

const librarianRuntime = new LibrarianRuntime();

const STALE_DRIFT_THRESHOLD = 10;

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
   * PERF-4: count of messages beyond the index cursor (pending delta), bounded
   * at the stale threshold so large channels cost a handful of rows to scan.
   */
  private static async pendingDeltaCount(channelId: string, lastSeq: number | null | undefined): Promise<number> {
    const db = getDb();
    const rows = await db.query.messages.findMany({
      where:
        lastSeq == null
          ? and(eq(messages.channelId, channelId), eq(messages.isInternalMonologue, false))
          : and(
              eq(messages.channelId, channelId),
              eq(messages.isInternalMonologue, false),
              gt(messages.sequenceNumber, lastSeq),
            ),
      limit: STALE_DRIFT_THRESHOLD,
    });
    return rows.length;
  }

  /**
   * Background task to reindex stale channels.
   * PERF-4 drift rule: pending-delta size (messages past last_seq) >= threshold,
   * plus degraded entries retry promptly (DB-3). DELTA_INDEX=false keeps the
   * legacy messageCountSinceIndex drift counter.
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

    const indices = await db.select().from(channelIndex);

    const staleIndices: typeof indices = [];
    if (deltaIndexEnabled()) {
      const checks = await Promise.all(
        indices.map(async (idx) => {
          if (idx.status === "degraded") return { idx, stale: true };
          const count = await this.pendingDeltaCount(idx.channelId, idx.lastSeq);
          return { idx, stale: count >= STALE_DRIFT_THRESHOLD };
        }),
      );
      for (const { idx, stale } of checks) if (stale) staleIndices.push(idx);
    } else {
      for (const idx of indices) {
        if (idx.status === "degraded" || idx.messageCountSinceIndex >= STALE_DRIFT_THRESHOLD) {
          staleIndices.push(idx);
        }
      }
    }

    if (staleIndices.length === 0) {
      console.log("[IndexBuilder] All channels index are up-to-date.");
      return;
    }

    const degradedCount = staleIndices.filter((idx) => idx.status === "degraded").length;
    console.log(`[IndexBuilder] Re-indexing ${staleIndices.length} stale channels (${degradedCount} degraded)...`);

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
