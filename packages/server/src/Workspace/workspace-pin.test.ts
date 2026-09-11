import { describe, expect, it } from "vitest";

import { hashScreenLockPin } from "../shared/auth/pin-gate.js";
import { isCurrentPinAccepted, sanitizeWorkspace } from "./workspace-pin.js";

describe("workspace-pin · sanitize (hash never leaves the server)", () => {
  it("strips screenLockPinHash and exposes screenLockEnabled", () => {
    const enabled = sanitizeWorkspace({
      id: "ws_1",
      name: "Demo",
      screenLockPinHash: hashScreenLockPin("some-pin"),
    });
    expect(enabled).toMatchObject({ id: "ws_1", name: "Demo", screenLockEnabled: true });
    expect("screenLockPinHash" in enabled).toBe(false);
    expect(JSON.stringify(enabled)).not.toContain("some-pin");

    const disabled = sanitizeWorkspace({ id: "ws_2", name: "Plain", screenLockPinHash: null });
    expect(disabled.screenLockEnabled).toBe(false);
    expect("screenLockPinHash" in disabled).toBe(false);
  });
});

describe("workspace-pin · current-PIN proof for change/disable", () => {
  const stored = hashScreenLockPin("workspace-pin-1");

  it("requires no proof when nothing is currently set", () => {
    expect(isCurrentPinAccepted(undefined, null)).toBe(true);
    expect(isCurrentPinAccepted("anything", null)).toBe(true);
  });

  it("accepts the stored workspace PIN, rejects wrong/blank", () => {
    expect(isCurrentPinAccepted("workspace-pin-1", stored)).toBe(true);
    expect(isCurrentPinAccepted("wrong", stored)).toBe(false);
    expect(isCurrentPinAccepted(undefined, stored)).toBe(false);
    expect(isCurrentPinAccepted("   ", stored)).toBe(false);
  });

  it("accepts the global LOCAL_PIN as operator override", () => {
    const saved = process.env.LOCAL_PIN;
    try {
      process.env.LOCAL_PIN = "global-override";
      expect(isCurrentPinAccepted("global-override", stored)).toBe(true);
      expect(isCurrentPinAccepted("nope", stored)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LOCAL_PIN;
      else process.env.LOCAL_PIN = saved;
    }
  });
});
