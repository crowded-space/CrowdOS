import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { closeDatabaseConnection, ensurePgVectorExtension, getDb } from "../shared/config/database.js";
import { agents, channels, instructionModules, modelModules, messages } from "./schema.js";

async function checkDatabaseRoundTrip(): Promise<void> {
  await ensurePgVectorExtension();

  const db = getDb();
  const now = new Date();
  const modelModuleId = randomUUID();
  const instructionModuleId = randomUUID();
  const agentId = randomUUID();
  const channelId = randomUUID();
  const messageId = randomUUID();

  await db.insert(modelModules).values({
    id: modelModuleId,
    label: "Roundtrip Model Module",
    provider: "openai",
    modelName: "roundtrip-test",
    apiKey: null,
    endpointUrl: null,
    temperature: 1,
    topP: 1,
    maxOutputTokens: 256,
    stopSequences: [],
    maxRecentMessages: 30,
    enableCompression: true,
    compressionThreshold: 50,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(instructionModules).values({
    id: instructionModuleId,
    label: "Roundtrip Instruction Module",
    base: ["Roundtrip instruction"],
    runtimePatchable: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agents).values({
    id: agentId,
    name: `roundtrip-${agentId.slice(0, 8)}`,
    title: "Roundtrip Agent",
    avatar: null,
    authorityLevel: 2,
    l3Subtype: null,
    modelModuleId,
    instructionModuleId,
    memorySharingPolicy: "vertical",
    isOmniscient: false,
    fallbackAgentId: null,
    categoryPermissions: [],
    permissions: { spawnAgents: false, patchRuntime: false, accessAllChannels: false },
    status: "idle",
    isTemplate: false,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(channels).values({
    id: channelId,
    categoryId: null,
    name: `roundtrip-${channelId.slice(0, 8)}`,
    type: "standard",
    createdBy: "user",
    position: 999,
    createdAt: now,
    archivedAt: null,
  });

  await db.insert(messages).values({
    id: messageId,
    channelId,
    authorId: agentId,
    authorName: "Roundtrip Agent",
    authorLevel: "2",
    authorType: "agent",
    content: "roundtrip check",
    mentions: [],
    isInternalMonologue: false,
    sequenceNumber: 1,
    timestamp: now,
  });

  const agentRow = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });
  const messageRow = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  });

  if (!agentRow || !messageRow) {
    throw new Error("Roundtrip verification failed.");
  }

  console.log("Database roundtrip succeeded.");
}

checkDatabaseRoundTrip()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnection();
  });
