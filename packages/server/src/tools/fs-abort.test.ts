// ─── TOLS-02 regression: FS mutation handlers are abort-aware ────────────────
// The executor's Promise.race can settle timeout/abort while an FS handler is
// still mid-flight. Before this fix the loser kept running and a "failed"
// mutation could still land on disk. These probes pin the handler contract:
// an aborted ctx.abortSignal refuses before touching disk, and a live signal
// is forwarded into fs.writeFile so an abort mid-write rejects the op.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { toolRegistry } from "./tool-registry.js";
import type { ToolExecutionContext } from "./tool-types.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "tools-fs-abort-"));
const WS = "ws-abort";
const WS_ROOT = join(TEST_ROOT, WS);
const savedWorkspaceDir = process.env.WORKSPACE_DIR;

function ctxWith(signal?: AbortSignal): ToolExecutionContext {
  return { agentId: "t", channelId: "c", workspaceId: WS, abortSignal: signal } as ToolExecutionContext;
}

function abortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort(new Error("caller aborted"));
  return c.signal;
}

describe("TOLS-02 · FS mutation handlers honour ctx.abortSignal", () => {
  beforeEach(() => {
    process.env.WORKSPACE_DIR = TEST_ROOT;
    rmSync(WS_ROOT, { recursive: true, force: true });
    mkdirSync(WS_ROOT, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (savedWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = savedWorkspaceDir;
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("write_file refuses after abort — nothing lands on disk", async () => {
    const handler = toolRegistry.get("write_file")!.handler;
    const res = await handler({ path: "abort-me.txt", content: "should-not-land" }, ctxWith(abortedSignal()));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/abort/i);
    expect(existsSync(join(WS_ROOT, "abort-me.txt"))).toBe(false);
  });

  it("edit_file refuses after abort — original content untouched", async () => {
    writeFileSync(join(WS_ROOT, "target.txt"), "original", "utf8");
    const handler = toolRegistry.get("edit_file")!.handler;
    const res = await handler(
      { path: "target.txt", targetContent: "original", replacementContent: "mutated" },
      ctxWith(abortedSignal()),
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/abort/i);
    expect(readFileSync(join(WS_ROOT, "target.txt"), "utf8")).toBe("original");
  });

  it("delete_file refuses after abort — file still present", async () => {
    writeFileSync(join(WS_ROOT, "keep.txt"), "keep", "utf8");
    const handler = toolRegistry.get("delete_file")!.handler;
    const res = await handler({ path: "keep.txt" }, ctxWith(abortedSignal()));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/abort/i);
    expect(existsSync(join(WS_ROOT, "keep.txt"))).toBe(true);
  });

  it("write_file forwards the live caller signal into fs.writeFile", async () => {
    const spy = vi.spyOn(fs, "writeFile");
    const ctrl = new AbortController();
    const handler = toolRegistry.get("write_file")!.handler;
    const res = await handler({ path: "sig.txt", content: "x" }, ctxWith(ctrl.signal));
    expect(res.success).toBe(true);
    // Positive control: the write actually landed under the test workspace root,
    // so the refusal probes above are not vacuous (wrong-root resolution).
    expect(existsSync(join(WS_ROOT, "sig.txt"))).toBe(true);
    const call = spy.mock.calls[spy.mock.calls.length - 1];
    const opts = call?.[2] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBe(ctrl.signal);
  });
});
