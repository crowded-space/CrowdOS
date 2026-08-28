import { getDb, closeDatabaseConnection } from "../Shared/config/database.js";
import { workspaces } from "./schema.js";
import { LocalVFS } from "../vfs/vfsGate.js";
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
    console.log(`Workspace '${id}' already exists. Initializing VFS...`);
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

  const vfs = new LocalVFS({
    workspaceId: id,
    workspaceRoot: rootPath,
    actorId: "human_operator",
  });

  console.log("Initializing VFS sectors on disk and in database...");
  await vfs.initialize();
  console.log("VFS initialization completed successfully!");
}

run()
  .catch((err) => console.error("Error creating CrowdOS workspace:", err))
  .finally(() => closeDatabaseConnection());
