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

  it("stale exit from a previous connection's child does not tear down a reconnect", async () => {
    const id = await start(makeConfig());
    expect(mcpClientManager.getStatus(id)?.status).toBe("connected");

    type TestSession = {
      process?: { emit: (event: string, code: number | null, signal: null) => boolean } | undefined;
    };
    const sessions = (mcpClientManager as unknown as { sessions: Map<string, TestSession> })
      .sessions;
    const session = sessions.get(id)!;
    const oldChild = session.process!;
    expect(oldChild).toBeTruthy();

    await mcpClientManager.disconnect(id);
    expect(mcpClientManager.getStatus(id)?.status).toBe("disconnected");

    const status = await mcpClientManager.connect(id);
    expect(status.status).toBe("connected");
    const newChild = session.process;
    expect(newChild).toBeTruthy();
    expect(newChild).not.toBe(oldChild);

    // Late event from the dead child (the reconnect race window).
    oldChild.emit("exit", 0, null);

    expect(mcpClientManager.getStatus(id)?.status).toBe("connected");
    expect(session.process).toBe(newChild);

    const result = await getTool(id, "echo_env").handler({ names: [] }, ctx);
    expect(result.success).toBe(true);
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

  it("TOLS-03: a tripped circuit breaker refuses calls instead of sending them", async () => {
    const id = await start(makeConfig());
    const handler = getTool(id, "echo_env").handler;

    // The public trigger paths (30s request timeout, 10MB stdout cap) each kill
    // the child on first occurrence, so the threshold is driven here directly:
    // five consecutive failures on a live session, exactly what recordFailure
    // counts in production.
    type TestSession = { consecutiveFailures: number; status: string; lastError?: string };
    const session = (mcpClientManager as unknown as { sessions: Map<string, TestSession> })
      .sessions.get(id)!;
    const trip = mcpClientManager as unknown as {
      recordFailure: (s: TestSession, reason: string) => void;
    };
    for (let i = 0; i < 5; i += 1) trip.recordFailure(session, "test-induced failure");
    expect(session.status).toBe("error");

    // Pre-fix the call was still written to stdin and the normal-mode fixture
    // would have answered it successfully. The refusal below is the breaker
    // gate: it must reject with the disabled reason and never reach the server.
    const startedAt = performance.now();
    await expect(handler({ names: [] }, ctx)).rejects.toThrow(/circuit breaker|disabled/);
    await expect(handler({ names: [] }, ctx)).rejects.toBeInstanceOf(McpServerCrashedError);
    expect(performance.now() - startedAt).toBeLessThan(100);

    // Gate is a refusal, not a teardown: status stays tripped and tools stay
    // registered (cleanup/unregister is a separate, larger change).
    expect(mcpClientManager.getStatus(id)?.status).toBe("error");
  });

  it("TOLS-06: disconnect during an in-flight connect aborts without dead tools or an error status", async () => {
    const id = await start(makeConfig({ autoStart: false }));
    expect(mcpClientManager.getStatus(id)?.status).toBe("disconnected");

    // Deterministically hold the handshake right after tools/list: the fixture
    // has answered, but the response is withheld until disconnect() has landed
    // mid-connect — the exact race the row describes.
    type SendJsonRpc = (...args: any[]) => Promise<any>;
    const mgr = mcpClientManager as unknown as { sendJsonRpc: SendJsonRpc };
    const originalSend = mgr.sendJsonRpc;
    let listSent = 0;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    (mcpClientManager as unknown as Record<string, unknown>).sendJsonRpc = (...args: any[]) => {
      const [session, method, params] = args;
      const call = originalSend.call(mcpClientManager, session, method, params);
      if (method !== "tools/list") return call;
      listSent += 1;
      return call.then(async (res: unknown) => { await listGate; return res; });
    };

    try {
      const connectPromise = mcpClientManager.connect(id);
      const deadline = Date.now() + 5000;
      while (listSent === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(listSent).toBe(1);

      await mcpClientManager.disconnect(id);
      releaseList();

      // The in-flight tools/list is rejected by disconnect's failPending (or,
      // if it had already resolved, by the epoch check) — either way the
      // connect must reject instead of resolving to a resurrected session.
      await expect(connectPromise).rejects.toThrow(/disconnected/);
    } finally {
      delete (mcpClientManager as unknown as Record<string, unknown>).sendJsonRpc;
    }

    // TOLS-06: pre-fix the connect catch overwrote 'disconnected' with 'error'
    // and the resumed task could register tools for the killed child.
    expect(mcpClientManager.getStatus(id)?.status).toBe("disconnected");
    expect(mcpClientManager.getStatus(id)?.toolCount).toBe(0);
    expect(toolRegistry.has(`mcp_${id}_nuke_workspace`)).toBe(false);
    expect(toolRegistry.has(`mcp_${id}_echo_env`)).toBe(false);
  });
});
