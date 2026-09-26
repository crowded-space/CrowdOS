import { describe, expect, it } from "vitest";

import { createAgentSchema, listAgentsQuerySchema } from "./agent-validators.js";

describe("listAgentsQuerySchema", () => {
  it('parses query-string booleans: only "true"/"1" are true', () => {
    expect(listAgentsQuerySchema.parse({ isTemplate: "true" }).isTemplate).toBe(true);
    expect(listAgentsQuerySchema.parse({ isTemplate: "1" }).isTemplate).toBe(true);
    expect(listAgentsQuerySchema.parse({ isTemplate: "false" }).isTemplate).toBe(false);
    expect(listAgentsQuerySchema.parse({ isTemplate: "0" }).isTemplate).toBe(false);
    expect(listAgentsQuerySchema.parse({ isTemplate: true }).isTemplate).toBe(true);
    expect(listAgentsQuerySchema.parse({}).isTemplate).toBeUndefined();
  });

  it("rejects non-boolean literals instead of flipping the filter", () => {
    // z.coerce.boolean() mapped Boolean("false") === true, silently
    // returning templates from the non-template roster.
    expect(() => listAgentsQuerySchema.parse({ isTemplate: "banana" })).toThrow();
    expect(() => listAgentsQuerySchema.parse({ isTemplate: "" })).toThrow();
  });
});

describe("createAgentSchema", () => {
  const base = {
    name: "scout",
    title: "Scout",
    authorityLevel: 1,
    instructionModuleId: "instr-1",
    memorySharingPolicy: "full",
  };

  it("accepts contextTokenCap", () => {
    expect(createAgentSchema.parse({ ...base, contextTokenCap: 8000 }).contextTokenCap).toBe(8000);
    expect(createAgentSchema.parse({ ...base, contextTokenCap: null }).contextTokenCap).toBeNull();
    expect(createAgentSchema.parse(base).contextTokenCap).toBeUndefined();
  });
});
