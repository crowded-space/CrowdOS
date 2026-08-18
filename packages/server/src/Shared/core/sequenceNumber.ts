import { eq } from "drizzle-orm";
import { getDb } from "../config/database.js";
import { messages } from "../../db/schema.js";

export async function getNextSequenceNumber(channelId: string): Promise<number> {
  const db = getDb();
  const lastMessage = await db.query.messages.findFirst({
    where: eq(messages.channelId, channelId),
    orderBy: (table, { desc }) => [desc(table.sequenceNumber)],
  });
  return lastMessage ? lastMessage.sequenceNumber + 1 : 1;
}
