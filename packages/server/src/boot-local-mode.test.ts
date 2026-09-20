// Boot-without-DB smoke: buildServer() builds with no DATABASE_URL.
// Guards the dual-boot invariant — HTTP wiring must never require PG at boot.
import { afterAll, describe, expect, it } from "vitest";

import { env } from "./shared/config/env.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;

afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

describe("boot without DATABASE_URL", () => {
  it("builds the server and exposes workspace routes", async () => {
    const { buildServer } = await import("./create-app.js");
    const built = await buildServer({ skipTimers: true, skipListen: true });
    try {
      const routes = built.app.printRoutes();
      // printRoutes renders a tree (splits "workspaces" across lines) — match fragments.
      expect(routes).toContain("workspace");
      expect(routes).toContain("db-sync");
    } finally {
      await built.stop();
    }
  }, 30_000);
});
