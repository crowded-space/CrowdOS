import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mocks = vi.hoisted(() => ({
  brave: vi.fn(),
  tavily: vi.fn(),
  serper: vi.fn(),
}))

vi.mock("./providers/brave.js", () => ({ braveProvider: { name: "brave", search: mocks.brave } }))
vi.mock("./providers/tavily.js", () => ({ tavilyProvider: { name: "tavily", search: mocks.tavily } }))
vi.mock("./providers/serper.js", () => ({ serperProvider: { name: "serper", search: mocks.serper } }))

import { searchProviders } from "./search-provider-service.js"
import { searchProviderGate } from "./search-provider-gate.js"
import type { SearchResult } from "./search-provider-types.js"

const row = (i: number, source: string): SearchResult => ({
  url: `https://example.com/p${i}-${source}`,
  title: `T${i}`,
  snippet: `s${i}`,
  source,
})

const warnCalls = (): unknown[][] => vi.mocked(console.warn).mock.calls

describe("searchProviders fan-out (mocked providers)", () => {
  let envBackup: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    envBackup = process.env.SEARCH_PROVIDER_PRIORITY
    process.env.SEARCH_PROVIDER_PRIORITY = "brave,tavily,serper"
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (envBackup === undefined) delete process.env.SEARCH_PROVIDER_PRIORITY
    else process.env.SEARCH_PROVIDER_PRIORITY = envBackup
  })

  it("first provider gets the full limit and early-exits before the rest run", async () => {
    mocks.brave.mockResolvedValue([0, 1, 2, 3, 4].map((i) => row(i, "brave")))
    const res = await searchProviders("query", { limit: 5 })
    expect(res.length).toBe(5)
    expect(mocks.brave).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 5 }))
    expect(mocks.tavily).not.toHaveBeenCalled()
    expect(mocks.serper).not.toHaveBeenCalled()
  })

  it("splits ceil(limit/providers) across the rest when the first comes up short", async () => {
    mocks.brave.mockResolvedValue([row(1, "brave"), row(2, "brave")])
    mocks.tavily.mockResolvedValue([row(3, "tavily")])
    mocks.serper.mockResolvedValue([row(4, "serper")])
    const res = await searchProviders("query", { limit: 5 })
    expect(mocks.brave).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 5 }))
    expect(mocks.tavily).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 2 }))
    expect(mocks.serper).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 2 }))
    expect(res.length).toBe(4)
    expect(res.length).toBeLessThanOrEqual(5)
  })

  it("dedupes the union across providers before applying the limit", async () => {
    mocks.brave.mockResolvedValue([{ ...row(1, "brave"), url: "https://example.com/a" }])
    mocks.tavily.mockResolvedValue([{ ...row(1, "tavily"), url: "http://example.com/a?utm_source=x" }])
    mocks.serper.mockResolvedValue([{ ...row(2, "serper"), url: "https://example.com/b" }])
    const res = await searchProviders("query", { limit: 5 })
    expect(res.length).toBe(2)
    expect(res[0].url).toBe("https://example.com/a")
  })

  it("limit 0 and negative limits return [] without calling any provider", async () => {
    expect(await searchProviders("query", { limit: 0 })).toEqual([])
    expect(await searchProviders("query", { limit: -3 })).toEqual([])
    expect(mocks.brave).not.toHaveBeenCalled()
    expect(mocks.tavily).not.toHaveBeenCalled()
    expect(mocks.serper).not.toHaveBeenCalled()
  })

  it("non-finite limit falls back to default behavior (no final cap, providers default)", async () => {
    mocks.brave.mockResolvedValue([row(1, "brave")])
    mocks.tavily.mockResolvedValue([row(2, "tavily")])
    mocks.serper.mockResolvedValue([row(3, "serper")])
    const res = await searchProviders("query", { limit: NaN })
    expect(res.length).toBe(3)
    expect(mocks.brave).toHaveBeenCalledWith("query", expect.objectContaining({ limit: undefined }))
  })

  it("truncates over-long queries to 512 chars and rejects non-string queries", async () => {
    await searchProviders("a".repeat(600))
    expect(mocks.brave).toHaveBeenCalledWith("a".repeat(512), expect.anything())
    vi.clearAllMocks()
    expect(await searchProviders(123 as unknown as string)).toEqual([])
    expect(mocks.brave).not.toHaveBeenCalled()
    expect(mocks.tavily).not.toHaveBeenCalled()
    expect(mocks.serper).not.toHaveBeenCalled()
  })

  it("warns once for unknown SEARCH_PROVIDER_PRIORITY names listing valid options", async () => {
    process.env.SEARCH_PROVIDER_PRIORITY = "brave,serper-typo"
    await searchProviders("query")
    expect(warnCalls().some((c) => String(c[0]).includes('unknown provider "serper-typo"') && String(c[0]).includes("brave, tavily, serper"))).toBe(true)
    // unknown name dropped, valid providers (plus appended defaults) still run
    expect(mocks.brave).toHaveBeenCalled()
    expect(mocks.tavily).toHaveBeenCalled()
    expect(mocks.serper).toHaveBeenCalled()
  })

  it("emits the loud aggregate warning when every attempted provider failed", async () => {
    mocks.brave.mockRejectedValue(new Error("HTTP 429 rate-limited, Retry-After: 12"))
    mocks.tavily.mockRejectedValue(new Error("HTTP 500"))
    mocks.serper.mockRejectedValue(new Error("fetch failed: ECONNREFUSED"))
    const res = await searchProviders("query", { limit: 5 })
    expect(res).toEqual([])
    expect(warnCalls().some((c) => String(c[0]).includes("ALL 3 attempted providers failed"))).toBe(true)
  })

  it("does NOT emit the all-failed aggregate on a genuine empty result", async () => {
    mocks.brave.mockResolvedValue([])
    mocks.tavily.mockResolvedValue([])
    mocks.serper.mockResolvedValue([])
    const res = await searchProviders("query")
    expect(res).toEqual([])
    expect(warnCalls().some((c) => String(c[0]).includes("ALL"))).toBe(false)
  })

  it("a failed first provider still lets the rest contribute (fail-open union)", async () => {
    mocks.brave.mockRejectedValue(new Error("HTTP 500"))
    mocks.tavily.mockResolvedValue([row(1, "tavily")])
    mocks.serper.mockResolvedValue([row(2, "serper")])
    const res = await searchProviders("query", { limit: 5 })
    expect(res.length).toBe(2)
    expect(warnCalls().some((c) => String(c[0]).includes("brave search failed"))).toBe(true)
    expect(warnCalls().some((c) => String(c[0]).includes("ALL"))).toBe(false)
  })

  it("gate.search fans out, splits limits, and dedupes through the gate facade", async () => {
    mocks.brave.mockResolvedValue([row(1, "brave"), row(2, "brave")])
    mocks.tavily.mockResolvedValue([{ ...row(1, "tavily"), url: "http://example.com/p1-brave?utm_source=x" }])
    mocks.serper.mockResolvedValue([row(3, "serper")])
    const res = await searchProviderGate.search("query", { limit: 5 })
    expect(mocks.brave).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 5 }))
    expect(mocks.tavily).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 2 }))
    expect(mocks.serper).toHaveBeenCalledWith("query", expect.objectContaining({ limit: 2 }))
    expect(res.length).toBe(3)
    expect(res.map((r) => r.source)).toEqual(["brave", "brave", "serper"])
  })
})
