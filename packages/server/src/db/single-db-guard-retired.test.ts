// DB-009 regression: the unwired single-DB guard is intentionally retired.
//
// scripts/check-single-db.mjs (SPEC-03 era) was never wired into lint:gates or
// CI, and its FORBIDDEN list (getWorkspaceDb/runWithDb/workspaceDb/ensureSchema/
// LEGACY_BOOTSTRAP) bans the record-only workspace-DB routing that is the
// documented current architecture — running it today flags 150+ live files.
// The DB batch resolved the row by deleting the dead guard; wiring it would
// have required allowlisting the whole live surface, turning it into a no-op.
// This test pins the retirement so an accidental merge cannot silently
// resurrect the guard or a stale wiring.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_ROOT = new URL("../../", import.meta.url); // packages/server/
const REPO_ROOT = new URL("../../../../", import.meta.url); // repository root

function readIfExists(url: URL): string | null {
  const path = fileURLToPath(url);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("DB-009 · single-DB guard retirement", () => {
  it("does not resurrect scripts/check-single-db.mjs", () => {
    expect(existsSync(fileURLToPath(new URL("scripts/check-single-db.mjs", SERVER_ROOT)))).toBe(false);
  });

  it("keeps lint:gates on the three wired guards (no stale wiring)", () => {
    const pkg = JSON.parse(readIfExists(new URL("package.json", SERVER_ROOT))!) as {
      scripts: Record<string, string>;
    };
    const lintGates = pkg.scripts["lint:gates"]!;
    expect(lintGates).toContain("check-gates.mjs");
    expect(lintGates).toContain("check-redaction.mjs");
    expect(lintGates).toContain("check-events.mjs");
    expect(lintGates).not.toContain("check-single-db");
  });

  it("has no dangling references to check-single-db in wiring surfaces", () => {
    const surfaces: Array<string | null> = [
      readIfExists(new URL("package.json", REPO_ROOT)),
      readIfExists(new URL("package.json", SERVER_ROOT)),
    ];
    const workflowDir = fileURLToPath(new URL(".github/workflows", REPO_ROOT));
    if (existsSync(workflowDir)) {
      for (const name of readdirSync(workflowDir)) {
        if (name.endsWith(".yml") || name.endsWith(".yaml")) {
          surfaces.push(readIfExists(new URL(`.github/workflows/${name}`, REPO_ROOT)));
        }
      }
    }
    const hits = surfaces.filter((text) => text?.includes("check-single-db"));
    expect(hits).toEqual([]);
  });
});

