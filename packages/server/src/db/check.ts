import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";

import { closeDatabaseConnection, ensurePgVectorExtension, getDb } from "../shared/config/database.js";
import { agents, channels, instructionModules, modelModules, messages, workspaces } from "./schema.js";

type Db = ReturnType<typeof getDb>;

/**
 * DB-002: the roundtrip probe writes channel/message rows with workspaceId
 * "default", but nothing on a fresh DB provisions that workspaces row while
 * messages.workspace_id carries an FK to workspaces(id) (0016) — db:check
 * failed with a FK violation before its real verification ran. Insert-if-
 * missing (ON CONFLICT DO NOTHING) keeps the probe self-sufficient and
 * idempotent against DBs that already hold the row.
 */
export async function ensureDefaultWorkspaceRow(db: Db): Promise<void> {
  await db
    .insert(workspaces)
    .values({
      id: "default",
      name: "Default Workspace",
      ownerId: "system",
      status: "ACTIVE",
      rootPath: path.join(process.cwd(), "sandbox", "default").replace(/\\/g, "/"),
    })
    .onConflictDoNothing();
}

async function checkDatabaseRoundTrip(): Promise<{ messageId: string; channelId: string; agentId: string; modelModuleId: string; instructionModuleId: string }> {
  await ensurePgVectorExtension();

  const db = getDb();
  await ensureDefaultWorkspaceRow(db);
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
    workspaceId: "default",
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
    workspaceId: "default",
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
  return { messageId, channelId, agentId, modelModuleId, instructionModuleId };
}

let roundtripIds: { messageId: string; channelId: string; agentId: string; modelModuleId: string; instructionModuleId: string } | null = null;

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  checkDatabaseRoundTrip()
    .then((ids) => { roundtripIds = ids; })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Clean up roundtrip rows: leftover Level-2 non-omniscient agents break
      // seed-dependent tests (e.g. approval-flow's agent lookup).
      if (roundtripIds) {
        try {
          const db = getDb();
          await db.delete(messages).where(eq(messages.id, roundtripIds.messageId)).catch(() => {});
          await db.delete(channels).where(eq(channels.id, roundtripIds.channelId)).catch(() => {});
          await db.delete(agents).where(eq(agents.id, roundtripIds.agentId)).catch(() => {});
          await db.delete(modelModules).where(eq(modelModules.id, roundtripIds.modelModuleId)).catch(() => {});
          await db.delete(instructionModules).where(eq(instructionModules.id, roundtripIds.instructionModuleId)).catch(() => {});
        } catch {}
      }
      await closeDatabaseConnection();
    });
}
