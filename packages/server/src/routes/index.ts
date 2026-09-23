import type { FastifyInstance } from "fastify";

import { agentRoutes } from "./agents.js";
import { healthRoutes } from "./health.js";
import { metricsRoutes } from "./metrics.js";
import { moduleRoutes } from "./modules.js";
import { providerRoutes } from "./providers.js";
import { workspaceRoutes } from "./workspace.js";
import { categoryRoutes } from "./categories.js";
import { channelRoutes } from "./channels.js";
import { channelMountRoutes } from "./channel-mounts.js";
import { messageRoutes } from "./messages.js";
import { filesystemRoutes } from "./filesystem.js";
import { skillRoutes } from "./skills.js";
import { toolRoutes } from "./tools.js";
import { mcpRoutes } from "./mcp.js";
import { studioRoutes } from "./studio.js";
import { eventRoutes } from "./events.js";
import { queueRoutes } from "./queue.js";
import { runsRoutes } from "./runs.js";
import { artifactsRoutes } from "./artifacts.js";
import { approvalsRoutes } from "./approvals.js";
import { searchRoutes } from "./search.js";
import { observabilityRoutes } from "./observability.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(agentRoutes);
  await app.register(moduleRoutes);
  await app.register(providerRoutes);
  await app.register(workspaceRoutes);
  await app.register(categoryRoutes);
  await app.register(channelRoutes);
  // ChannelMounts transport: mount get/set for channel/category/workspace,
  // the jailed host-filesystem browse, and the allowed-roots listing. Without
  // this registration every mount endpoint 404s in production while the
  // route-integration test (which wires its own app) still passes.
  await app.register(channelMountRoutes);
  await app.register(messageRoutes);
  await app.register(filesystemRoutes);
  await app.register(skillRoutes);
  await app.register(toolRoutes);
  await app.register(mcpRoutes);
  await app.register(studioRoutes);
  await app.register(eventRoutes);
  await app.register(queueRoutes);
  await app.register(runsRoutes);
  await app.register(artifactsRoutes);
  await app.register(approvalsRoutes);
  await app.register(searchRoutes);
  await app.register(observabilityRoutes);
}
