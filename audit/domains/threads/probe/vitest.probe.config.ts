import { defineConfig } from "vitest/config";

// Read-only audit probe: lives under audit/ so production files stay untouched.
export default defineConfig({
  test: {
    root: ".",
    include: ["audit/domains/threads/probe/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "sandbox/**"],
  },
});
