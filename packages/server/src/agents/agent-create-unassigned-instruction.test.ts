import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests } from "../shared/core/local-file.js";
import { agentGate } from "./agent-gate.js";

// Audit §2.7 regression: the Assemble Mind default configuration ("No
// instructions (unassigned)", "No model (unassigned)") posts
// instructionModuleId: null. The create schema used to reject it with a
// bare "Validation failed", so the form's own default could never succeed.

let dir: string;

const WS = "ws-unassigned-instructions";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-agent-unassigned-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("local-tier agent create with an unassigned instruction stack", () => {
  afterEach(() => {
    agentGate.invalidateRosterCache();
  });

  it("resolves instructionModuleId null to the canon default instead of rejecting", async () => {
    const created = await agentGate.create({
      workspaceId: WS,
      name: "qa_probe",
      title: "QA probe",
      species: "Crow",
      authorityLevel: 1,
      modelModuleId: null,
      instructionModuleId: null,
      memorySharingPolicy: "full",
      permissions: { spawnAgents: true, patchRuntime: true, accessAllChannels: true },
    });

    expect(created.instructionModuleId).toBe("instr-default");
    expect(created.modelModuleId).toBeNull();
  });
});
