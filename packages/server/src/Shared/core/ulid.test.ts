import { describe, expect, it } from "vitest";

import { decodeTime, monotonicUlid, ulid } from "./ulid.js";

describe("ulid", () => {
  it("encodes to 26 uppercase Crockford base32 characters", () => {
    for (let i = 0; i < 500; i++) {
      const id = ulid();
      expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
      expect(id).not.toMatch(/[ILOU]/);
    }
  });

  it("round-trips the 48-bit millisecond timestamp", () => {
    expect(decodeTime(ulid(0))).toBe(0);
    expect(decodeTime(ulid(1756160000000))).toBe(1756160000000);
    expect(decodeTime(ulid(2 ** 48 - 1))).toBe(2 ** 48 - 1);
  });

  it("rejects malformed ids and out-of-range timestamps", () => {
    expect(() => decodeTime("short")).toThrow();
    expect(() => decodeTime("!".repeat(26))).toThrow();
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });

  it("is strictly monotonic within one millisecond", () => {
    const fixed = 1756160000000;
    const ids = Array.from({ length: 1000 }, () => monotonicUlid(fixed));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
    expect(new Set(ids).size).toBe(1000);
    expect(decodeTime(ids[ids.length - 1]!)).toBe(fixed);
  });

  it("orders lexicographically by creation time across milliseconds", () => {
    const earlier = monotonicUlid(1_800_000_000_001);
    const later = monotonicUlid(1_800_000_000_002);
    expect(later > earlier).toBe(true);
    expect(decodeTime(later)).toBe(1_800_000_000_002);
  });

  it("survives clock regression without breaking sort order", () => {
    const before = monotonicUlid(1_850_000_000_000);
    const during = monotonicUlid(1_849_999_999_999);
    const after = monotonicUlid(1_850_000_000_000);
    expect(during > before).toBe(true);
    expect(after > during).toBe(true);
  });
});
