import { beforeEach, describe, expect, it } from "vitest";
import {
  OPERATOR_DEFAULT_NAME,
  OPERATOR_DEFAULT_TAG,
  loadOperatorProfile,
  saveOperatorProfile,
} from "./operator-profile-model";

function installMemoryStorage(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  return store;
}

beforeEach(() => {
  installMemoryStorage();
});

describe("operator-profile-model", () => {
  it("returns name/tag defaults with null preference when nothing is stored", () => {
    expect(loadOperatorProfile()).toEqual({
      name: OPERATOR_DEFAULT_NAME,
      tag: OPERATOR_DEFAULT_TAG,
      preference: null,
    });
  });

  it("migrates the legacy {name,email} shape and drops email", () => {
    installMemoryStorage({
      crowdos_operator: JSON.stringify({ name: "Shine", email: "shine@example.com" }),
    });
    const profile = loadOperatorProfile();
    expect(profile.name).toBe("Shine");
    expect(profile.tag).toBe(OPERATOR_DEFAULT_TAG);
    expect(profile.preference).toBeNull();
    expect(profile).not.toHaveProperty("email");
  });

  it("round-trips name, tag and preference through save/load", () => {
    saveOperatorProfile({ name: "Shine", tag: "Captain", preference: "Prefer concise answers." });
    expect(loadOperatorProfile()).toEqual({
      name: "Shine",
      tag: "Captain",
      preference: "Prefer concise answers.",
    });
  });

  it("normalises a blank preference to null (inject nothing)", () => {
    saveOperatorProfile({ name: "Shine", tag: "Human", preference: "   " });
    expect(loadOperatorProfile().preference).toBeNull();
  });

  it("falls back to defaults on blank name/tag", () => {
    saveOperatorProfile({ name: "  ", tag: "", preference: null });
    expect(loadOperatorProfile()).toEqual({
      name: OPERATOR_DEFAULT_NAME,
      tag: OPERATOR_DEFAULT_TAG,
      preference: null,
    });
  });
});
