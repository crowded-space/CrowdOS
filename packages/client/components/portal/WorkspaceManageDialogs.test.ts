import { describe, expect, it } from "vitest";

import { initialDatabaseState, resolveDatabaseUrl } from "./WorkspaceManageDialogs";

describe("resolveDatabaseUrl", () => {
  it("returns undefined when untouched", () => {
    expect(resolveDatabaseUrl(initialDatabaseState())).toBeUndefined();
  });

  it("returns the trimmed URL in set mode", () => {
    expect(
      resolveDatabaseUrl({ mode: "set", url: "  postgresql://u:p@h/db  ", provisioned: true }),
    ).toBe("postgresql://u:p@h/db");
  });

  it("returns undefined for blank input in set mode", () => {
    expect(resolveDatabaseUrl({ mode: "set", url: "   ", provisioned: false })).toBeUndefined();
  });

  it("returns null in clear mode", () => {
    expect(resolveDatabaseUrl({ mode: "clear", url: "", provisioned: false })).toBeNull();
  });
});
