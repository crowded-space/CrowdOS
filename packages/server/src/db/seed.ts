import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { closeDatabaseConnection, ensurePgVectorExtension, getDb } from "../Shared/config/database.js";
import {
  agents,
  channels,
  modelModules,
  instructionModules,
  toolkitModules,
  workspaceSettings,
  categories,
} from "./schema.js";

async function seed(): Promise<void> {
  await ensurePgVectorExtension();

  const db = getDb();

  // â”€â”€â”€ Default Model Module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const existingModelModule = await db.query.modelModules.findFirst({
    where: eq(modelModules.label, "Default Gemini Model"),
  });

  let modelModuleId: string;
  if (!existingModelModule) {
    modelModuleId = randomUUID();
    await db.insert(modelModules).values({
      id: modelModuleId,
      label: "Default Gemini Model",
      provider: "google",
      modelName: "gemini-2.0-flash",
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 8192,
      stopSequences: [],
      maxRecentMessages: 50,
      enableCompression: true,
      compressionThreshold: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("Seeded default model module.");
  } else {
    modelModuleId = existingModelModule.id;
    console.log("Default model module already exists.");
  }

  // ─── Default Instruction Module ─────────────────────────────────────
  const existingInstructionModule = await db.query.instructionModules.findFirst({
    where: eq(instructionModules.label, "Default Assistant Instruction"),
  });

  let instructionModuleId: string;
  if (!existingInstructionModule) {
    instructionModuleId = randomUUID();
    await db.insert(instructionModules).values({
      id: instructionModuleId,
      label: "Default Assistant Instruction",
      base: [
        "You are a helpful AI assistant in a multi-agent workspace.",
        "You communicate through text messages in channels.",
        "Be concise, clear, and professional in your responses.",
        "When you don't know something, say so honestly.",
      ],
      runtimePatchable: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("Seeded default instruction module.");
  } else {
    instructionModuleId = existingInstructionModule.id;
    console.log("Default instruction module already exists.");
  }

  // Seed Librarian Instruction Module
  const existingLibInstruction = await db.query.instructionModules.findFirst({
    where: eq(instructionModules.label, "Librarian Core Instructions"),
  });

  let librarianInstructionId: string;
  if (!existingLibInstruction) {
    librarianInstructionId = randomUUID();
    await db.insert(instructionModules).values({
      id: librarianInstructionId,
      label: "Librarian Core Instructions",
      base: [
        "You are the Swarm Librarian indexer.",
        "Your purpose is to compile high-fidelity topic summaries of other channels and help Level 0/Level 1 agents locate knowledge.",
        "When mentioned with an indexing command (e.g. '@Librarian index #channel-name' or '@Librarian index all' or '@Librarian refresh index'), you will access standard channel message histories, formulate clean markdown summaries capturing main discussion topics, decisions, action items, and store them in the search registry index.",
        "Your response to mentions should confirm the target channels being indexed, and output the compiled summaries directly to the channel in a professional and clear format."
      ],
      runtimePatchable: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("Seeded Librarian instruction module.");
  } else {
    librarianInstructionId = existingLibInstruction.id;
    console.log("Librarian instruction module already exists.");
  }

  // ─── Default Toolkit Module ──────────────────────────────────────────
  const existingToolkitModule = await db.query.toolkitModules.findFirst({
    where: eq(toolkitModules.label, "Default Toolkit"),
  });

  let toolkitModuleId: string;
  if (!existingToolkitModule) {
    toolkitModuleId = randomUUID();
    await db.insert(toolkitModules).values({
      id: toolkitModuleId,
      label: "Default Toolkit",
      tools: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("Seeded default toolkit module.");
  } else {
    toolkitModuleId = existingToolkitModule.id;
    console.log("Default toolkit module already exists.");
  }

  // ─── Default Agent ──────────────────────────────────────────────────
  const existingAgent = await db.query.agents.findFirst({
    where: eq(agents.name, "default-assistant"),
  });

  if (!existingAgent) {
    await db.insert(agents).values({
      id: randomUUID(),
      name: "default-assistant",
      title: "Default Assistant",
      species: "AI Assistant",
      authorityLevel: 1,
      modelModuleId,
      instructionModuleId,
      toolkitModuleId,
      memorySharingPolicy: "none",
      isOmniscient: false,
      status: "idle",
      isTemplate: false,
      permissions: {
        spawnAgents: false,
        patchRuntime: false,
        accessAllChannels: false,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("Seeded default assistant agent.");
  } else {
    console.log("Default assistant agent already exists.");
  }

  // Seed Librarian Agent
  const existingLibrarian = await db.query.agents.findFirst({
    where: eq(agents.name, "Librarian"),
  });

  if (!existingLibrarian) {
    await db.insert(agents).values({
      id: "agent-librarian",
      name: "Librarian",
      title: "Swarm Librarian Specialist",
      species: "Owl",
      authorityLevel: 2,
      modelModuleId,
      instructionModuleId: librarianInstructionId,
      toolkitModuleId,
      memorySharingPolicy: "none",
      isOmniscient: true,
      status: "idle",
      isTemplate: false,
      permissions: {
        spawnAgents: false,
        patchRuntime: false,
        accessAllChannels: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("Seeded Librarian agent.");
  } else {
    console.log("Librarian agent already exists.");
  }

  // â”€â”€â”€ Workspace Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const existingSettings = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, "default")).execute();
  if (existingSettings.length === 0) {
    await db.insert(workspaceSettings).values({
      id: "default",
      globalSoftCap: 1000000,
      perProviderBudget: {},
      updatedAt: new Date(),
    });
    console.log("Seeded default workspace settings.");
  } else {
    console.log("Default workspace settings already exist.");
  }

  // â”€â”€â”€ #general Channel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const existingGeneralChannel = await db.query.channels.findFirst({
    where: and(eq(channels.name, "general"), isNull(channels.categoryId)),
  });

  if (!existingGeneralChannel) {
    await db.insert(channels).values({
      id: randomUUID(),
      categoryId: null,
      name: "general",
      type: "standard",
      createdBy: "user",
      position: 0,
      createdAt: new Date(),
      archivedAt: null,
    });
    console.log("Seeded top-level #general channel.");
  } else {
    console.log("Top-level #general channel already exists.");
  }

  // â”€â”€â”€ Default Categories & Channels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const seedCategory = async (name: string, position: number, channelsToSeed: { name: string; position: number }[]) => {
    let cat = await db.query.categories.findFirst({
      where: eq(categories.name, name),
    });

    let catId: string;
    if (!cat) {
      catId = randomUUID();
      await db.insert(categories).values({
        id: catId,
        name,
        createdBy: "user",
        position,
        createdAt: new Date(),
      });
      console.log(`Seeded category ${name}.`);
    } else {
      catId = cat.id;
      console.log(`Category ${name} already exists.`);
    }

    for (const chan of channelsToSeed) {
      const existingChan = await db.query.channels.findFirst({
        where: and(eq(channels.name, chan.name), eq(channels.categoryId, catId)),
      });

      if (!existingChan) {
        await db.insert(channels).values({
          id: randomUUID(),
          categoryId: catId,
          name: chan.name,
          type: "standard",
          createdBy: "user",
          position: chan.position,
          createdAt: new Date(),
          archivedAt: null,
        });
        console.log(`Seeded channel #${chan.name} under ${name}.`);
      }
    }
  };

  await seedCategory("GOVERNANCE & AUDIT", 1, [
    { name: "ops-bulletins", position: 0 },
    { name: "swarm-governance", position: 1 },
  ]);

  await seedCategory("ENGINEERING DEPT", 2, [
    { name: "general-chat", position: 0 },
    { name: "arch-design", position: 1 },
    { name: "execution-logs", position: 2 },
  ]);
}

seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnection();
  });