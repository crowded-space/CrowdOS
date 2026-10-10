// Scope agreement (server-model-fix): rows created under one scope stay
// readable/updatable/testable/deletable when a later call arrives unscoped
// or under the owning scope, while sibling scopes stay isolated.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";
import { moduleGate } from "./module-gate.js";
const prevUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-model-scope-"));
  setLocalStoreDirForTests(dir);
  return () => { setLocalStoreDirForTests(null); rmSync(dir, { recursive: true, force: true }); };
});
function modelRow(id: string) {
  return {
    id, label: id, provider: "custom", modelName: "m",
    apiKey: null, endpointUrl: "http://localhost:9/v1",
    temperature: 0.7, topP: 0.9, maxOutputTokens: 64,
    stopSequences: [], maxRecentMessages: 5,
    enableCompression: true, compressionThreshold: 10,
    createdAt: new Date(), updatedAt: new Date(),
  };
}
describe("module scope agreement (local tier)", () => {
  it("model get agrees with create across unscoped and owning reads", async () => {
    const created: any = await moduleGate.model.create(modelRow("mod-scope-get") as any, "ws-A");
    expect(created).toMatchObject({ id: "mod-scope-get", label: "mod-scope-get" });
    expect(await moduleGate.model.get("mod-scope-get", "ws-A")).toMatchObject({ id: "mod-scope-get" });
    expect(await moduleGate.model.get("mod-scope-get", null)).toMatchObject({ id: "mod-scope-get" });
    expect(await moduleGate.model.get("mod-scope-get", undefined)).toMatchObject({ id: "mod-scope-get" });
  });
  it("model update/test/delete agree with create when unscoped", async () => {
    await moduleGate.model.create(modelRow("mod-scope-mut") as any, "ws-A");
    const updated: any = await moduleGate.model.update("mod-scope-mut", { label: "renamed" } as any, null);
    expect(updated).toMatchObject({ id: "mod-scope-mut", label: "renamed" });
    expect(await moduleGate.model.get("mod-scope-mut", "ws-A")).toMatchObject({ label: "renamed" });
    expect(await moduleGate.model.test("mod-scope-mut", null)).toMatchObject({ success: true });
    const deleted: any[] = await moduleGate.model.remove("mod-scope-mut", null);
    expect(deleted).toHaveLength(1);
    expect(await moduleGate.model.get("mod-scope-mut", "ws-A")).toBeNull();
  });
  it("unscoped update writes back to the owner folder (no stranded copy)", async () => {
    await moduleGate.model.create(modelRow("mod-scope-owner") as any, "ws-A");
    await moduleGate.model.update("mod-scope-owner", { label: "v2" } as any, undefined);
    expect(await moduleGate.model.get("mod-scope-owner", "ws-A")).toMatchObject({ label: "v2" });
    expect(await moduleGate.model.get("mod-scope-owner", null)).toMatchObject({ label: "v2" });
  });
  it("sibling scopes stay isolated for model reads", async () => {
    await moduleGate.model.create(modelRow("mod-scope-iso") as any, "ws-A");
    expect(await moduleGate.model.get("mod-scope-iso", "ws-B")).toBeNull();
    expect(await moduleGate.model.update("mod-scope-iso", { label: "x" } as any, "ws-B")).toBeNull();
    expect(await moduleGate.model.remove("mod-scope-iso", "ws-B")).toEqual([]);
    expect(await moduleGate.model.get("mod-scope-iso", "ws-A")).toMatchObject({ id: "mod-scope-iso" });
  });
  it("other catalogs get agree with create when unscoped", async () => {
    const instr: any = await moduleGate.instruction.create({ label: "i", base: ["b"], runtimePatchable: false } as any, "ws-A");
    const tool: any = await moduleGate.toolkit.create({ label: "t", tools: [] } as any, "ws-A");
    const cons: any = await moduleGate.constraints.create({ label: "c", rules: [], disallowedActions: [] } as any, "ws-A");
    const caps: any = await moduleGate.capabilities.create({ label: "p", skills: [], functionSchemas: [] } as any, "ws-A");
    expect(await moduleGate.instruction.get(instr.id, null)).toMatchObject({ id: instr.id });
    expect(await moduleGate.toolkit.get(tool.id, null)).toMatchObject({ id: tool.id });
    expect(await moduleGate.constraints.get(cons.id, null)).toMatchObject({ id: cons.id });
    expect(await moduleGate.capabilities.get(caps.id, null)).toMatchObject({ id: caps.id });
  });
});
