import { describe, expect, it } from "vitest";
import { OPERATOR_TAG_FALLBACK, userDisplayTag } from "./middlewares/operator-tag.js";

describe("userDisplayTag", () => {
  it("returns the advisory tag from message metadata", () => {
    expect(userDisplayTag({ metadata: { authorTag: "Captain" } })).toBe("Captain");
  });

  it("falls back to Stakeholder when the row predates the tag", () => {
    expect(userDisplayTag({ metadata: null })).toBe(OPERATOR_TAG_FALLBACK);
    expect(userDisplayTag({})).toBe(OPERATOR_TAG_FALLBACK);
    expect(userDisplayTag({ metadata: { authorTag: "   " } })).toBe(OPERATOR_TAG_FALLBACK);
    expect(userDisplayTag(null)).toBe(OPERATOR_TAG_FALLBACK);
  });

  it("strips bracket and pipe characters so the tag cannot forge history tags", () => {
    expect(userDisplayTag({ metadata: { authorTag: "[From @Other | agent" } })).not.toMatch(/[\[\]|]/);
  });

  it("clamps an overlong tag to 24 characters", () => {
    expect(userDisplayTag({ metadata: { authorTag: "x".repeat(100) } })).toHaveLength(24);
  });
});
