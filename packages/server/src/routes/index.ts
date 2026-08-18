import type { FastifyInstance } from "fastify";

import { agentRoutes } from "./agents.js";
import { healthRoutes } from "./health.js";
import { moduleRoutes } from "./modules.js";
import { providerRoutes } from "./providers.js";
import { workspaceRoutes } from "./workspace.js";
import { categoryRoutes } from "./categories.js";
import { channelRoutes } from "./channels.js";
import { messageRoutes } from "./messages.js";
import { vfsRoutes } from "./vfs.js";
import { skillRoutes } from "./skills.js";
import { toolRoutes } from "./tools.js";
import { mcpRoutes } from "./mcp.js";
import { studioRoutes } from "./studio.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(agentRoutes);
  await app.register(moduleRoutes);
  await app.register(providerRoutes);
  await app.register(workspaceRoutes);
  await app.register(categoryRoutes);
  await app.register(channelRoutes);
  await app.register(messageRoutes);
  await app.register(vfsRoutes);
  await app.register(skillRoutes);
  await app.register(toolRoutes);
  await app.register(mcpRoutes);
  await app.register(studioRoutes);
}
