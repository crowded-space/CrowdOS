import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLocalStoreDirForTests } from "../../shared/core/local-file.js";
import { localUpsertModelModule } from "../../modules/module-local-store.js";
import { ContextPipelineManager } from "./context-pipeline-manager.js";

const MODULE_ID = "model-routing-regression";
const WORKSPACE_A = "ws-routing-a";
const WORKSPACE_B = "ws-routing-b";
let testDir: string;
let previousModelRoute: string | undefined;

async function seedModule(workspaceId: string, provider: "custom" | "openai"): Promise<void> {
  const now = new Date().toISOString();
  await localUpsertModelModule(
    {
      id: MODULE_ID,
      label: "Workspace model",
      provider,
      modelName: provider === "custom" ? "oc/mimo-v2.6-flash-free" : "gpt-4o-mini",
      endpointUrl: "http://localhost:20128/v1",
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 2048,
      stopSequences: [],
      maxRecentMessages: 10,
      enableCompression: true,
      compressionThreshold: 15,
      createdAt: now,
      updatedAt: now,
    },
    workspaceId,
  );
}

async function assemble(workspaceId: string): Promise<string | undefined> {
  const pipeline = new ContextPipelineManager();
  const packet = await pipeline.assemble({
    agent: {
      id: `agent-${workspaceId}`,
      name: "RoutingBot",
      title: "Routing regression probe",
      authorityLevel: 1,
      status: "idle",
      memorySharingPolicy: "full",
      modelModuleId: MODULE_ID,
      instructionModuleId: null,
      constraintsModuleId: null,
    } as never,
    channelId: `channel-${workspaceId}`,
    workspaceId,
    userInput: "route this request",
    runtimeType: "agentic",
  });
  return packet._modelConfig.provider;
}

describe("model module workspace routing", () => {
  beforeAll(() => {
    previousModelRoute = process.env.MODEL_ROUTE;
    // Keep this regression focused on workspace-scoped provider resolution;
    // dynamic routing would otherwise query PG while the fixture is local-only.
    process.env.MODEL_ROUTE = "static";
    testDir = mkdtempSync(join(tmpdir(), "crowdos-model-routing-"));
    setLocalStoreDirForTests(testDir);
  });

  afterAll(() => {
    if (previousModelRoute === undefined) delete process.env.MODEL_ROUTE;
    else process.env.MODEL_ROUTE = previousModelRoute;
    setLocalStoreDirForTests(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves each workspace's provider instead of the google fallback", async () => {
    await seedModule(WORKSPACE_A, "custom");
    await seedModule(WORKSPACE_B, "openai");

    await expect(assemble(WORKSPACE_A)).resolves.toBe("custom");
    await expect(assemble(WORKSPACE_B)).resolves.toBe("openai");
  });
});
