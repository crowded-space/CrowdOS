import { getDb, closeDatabaseConnection } from "../shared/config/database.js";
import { workspaces } from "./schema.js";
import { LocalFilesystem } from "../Filesystem/filesystem-gate.js";
import * as path from "node:path";
import { eq } from "drizzle-orm";

async function run() {
  const db = getDb();
  const id = "crowdos";
  const rootPath = path.join(process.cwd(), "sandbox", id).replace(/\\/g, "/");

  console.log(`Checking if workspace '${id}' already exists in database...`);
  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
  });

  if (existing) {
    console.log(`Workspace '${id}' already exists. Initializing filesystem...`);
  } else {
    console.log(`Inserting workspace '${id}' into workspaces table...`);
    const now = new Date();
    await db.insert(workspaces).values({
      id,
      name: "CrowdOS",
      ownerId: "human_operator",
      status: "ACTIVE",
      rootPath,
      permissions: {
        network: true,
        shell: true,
        maxAgents: 8,
      },
      constraints: {
        networkAccess: true,
        shellExecution: true,
        memoryLimitMb: 512,
        cpuLimit: 1,
      },
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Workspace '${id}' inserted successfully.`);
  }

  const filesystem = new LocalFilesystem({
    workspaceId: id,
    workspaceRoot: rootPath,
    actorId: "human_operator",
  });

  console.log("Initializing filesystem sectors on disk and in database...");
  await filesystem.initialize();
  console.log("Filesystem initialization completed successfully!");
}

run()
  .catch((err) => console.error("Error creating CrowdOS workspace:", err))
  .finally(() => closeDatabaseConnection());
