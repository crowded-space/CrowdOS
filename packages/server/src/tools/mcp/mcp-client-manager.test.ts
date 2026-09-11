import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mcpClientManager, McpServerCrashedError } from "./mcp-client-manager.js";
import { toolRegistry } from "../tool-registry.js";
import type { McpServerConfig } from "./mcp-types.js";
import type { ToolDefinition, ToolExecutionContext } from "../tool-types.js";

const fixturePath = fileURLToPath(new URL("./__fixtures__/fakeMcpServer.mjs", import.meta.url));

let idCounter = 0;

function makeConfig(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  idCounter += 1;
  return {
    id: `fake-mcp-${idCounter}`,
    name: `Fake MCP ${idCounter}`,
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath],
    autoStart: true,
    ...extra,
  };
}

function getTool(serverId: string, toolName: string): ToolDefinition {
  const def = toolRegistry.get(`mcp_${serverId}_${toolName}`);
  if (!def) throw new Error(`tool mcp_${serverId}_${toolName} not registered`);
  return def;
}

const ctx = { agentId: "test", channelId: "test", workspaceId: "test" } as ToolExecutionContext;

describe("McpClientManager SEC-6 hygiene", () => {
  let activeIds: string[] = [];

  beforeEach(() => {
    activeIds = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of activeIds) {
      await mcpClientManager.disconnect(id);
    }
  });

  async function start(config: McpServerConfig) {
    await mcpClientManager.registerServer(config);
    activeIds.push(config.id);
    return config.id;
  }

  it("labels tools from the config default floor, ignoring server safety claims", async () => {
    const defaultId = await start(makeConfig());
    expect(getTool(defaultId, "nuke_workspace").dangerLevel).toBe("dangerous");
    expect(getTool(defaultId, "nuke_workspace").authLevelRequired).toBe(2);

    const moderateId = await start(makeConfig({ defaultDangerLevel: "moderate" }));
    expect(getTool(moderateId, "nuke_workspace").dangerLevel).toBe("moderate");
    expect(getTool(moderateId, "nuke_workspace").authLevelRequired).toBe(2);
  });

  it("ignores server safety claims: registered level comes from the config default", async () => {
    const id = await start(makeConfig());
    const nuke = getTool(id, "nuke_workspace");
    expect(nuke.dangerLevel).toBe("dangerous");
    expect(nuke.authLevelRequired).toBe(2);
    expect(nuke.description).toContain("rm -rf");
  });

  it("escalates destructiveHint tools above an explicit safe floor, never the reverse", async () => {
    const safeId = await start(makeConfig({ defaultDangerLevel: "safe" }));
    expect(getTool(safeId, "purge_backups").dangerLevel).toBe("dangerous");
    expect(getTool(safeId, "purge_backups").authLevelRequired).toBe(2);

    const trusted = getTool(safeId, "echo_env");
    expect(trusted.dangerLevel).toBe("safe");
    expect(trusted.authLevelRequired).toBe(3);
  });

  it("crash hygiene: killing a session with an in-flight call rejects it in under 100ms", async () => {
    const hangId = await start(makeConfig({ envVars: { FIXTURE_MODE: "hang" } }));
    const handler = getTool(hangId, "nuke_workspace").handler;

    const pending = expect(handler({ target: "workspace/" }, ctx)).rejects.toBeInstanceOf(
      McpServerCrashedError
    );
    const startedAt = performance.now();
    await mcpClientManager.disconnect(hangId);
    await pending;
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(100);
  });

  it("rejects pending calls with McpServerCrashedError when the server self-exits mid-call", async () => {
    const crashId = await start(makeConfig({ envVars: { FIXTURE_MODE: "crash" } }));
    const handler = getTool(crashId, "nuke_workspace").handler;

    const startedAt = performance.now();
    await expect(handler({ target: "workspace/" }, ctx)).rejects.toBeInstanceOf(McpServerCrashedError);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1000);

    expect(mcpClientManager.getStatus(crashId)?.status).toBe("disconnected");
  });

  it("forwards declared secret vars and loudly drops undeclared ones", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const envId = await start(
      makeConfig({
        envVars: {
          API_TOKEN: "tok-123",
          UNDECLARED_SECRET: "hush-value",
          PUBLIC_FLAG: "ping",
        },
        requiredEnvVars: ["API_TOKEN"],
      })
    );
    expect(warnSpy).toHaveBeenCalled();
    const warnPayload = warnSpy.mock.calls
      .map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
      .join("\n");
    expect(warnPayload).toContain("UNDECLARED_SECRET");
    expect(warnPayload).not.toContain("hush-value");

    const handler = getTool(envId, "echo_env").handler;
    const result = await handler({ names: ["API_TOKEN", "UNDECLARED_SECRET", "PUBLIC_FLAG"] }, ctx);
    const seen = JSON.parse(result.output) as Record<string, string | null>;
    expect(seen["API_TOKEN"]).toBe("tok-123");
    expect(seen["UNDECLARED_SECRET"]).toBeNull();
    expect(seen["PUBLIC_FLAG"]).toBe("ping");
  });

  it("speaks content-length framing when a server opts in", async () => {
    const clId = await start(
      makeConfig({
        framing: "content-length",
        envVars: { FIXTURE_FRAMING: "content-length" },
      })
    );
    const status = mcpClientManager.getStatus(clId);
    expect(status?.status).toBe("connected");
    expect(status?.toolCount).toBe(3);

    const result = await getTool(clId, "nuke_workspace").handler({ target: "tmp" }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("nuked tmp");
  });
});
