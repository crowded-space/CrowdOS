import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { braveProvider, __testMapBraveJson } from "./brave.js"
import { serperProvider, __testMapSerperJson } from "./serper.js"
import { tavilyProvider, __testMapTavilyJson } from "./tavily.js"

function fetchResponse(overrides: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({}),
    ...overrides,
  } as unknown as Response
}

describe("provider mappers (__testMap*Json)", () => {
  let warn: { mock: { calls: unknown[][] } }

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("brave maps url|link, title/snippet fallbacks, truncation, ISO age, drops unparsable dates", () => {
    const out = __testMapBraveJson({
      web: {
        results: [
          { url: "https://a.com/x", title: "T".repeat(400), description: "D", age: "2024-01-01" },
          { link: "https://b.com/y", title: "T2" },
          { title: "no url at all" },
          { url: "https://c.com/z", age: "3 days ago" },
        ],
      },
    })
    expect(out.length).toBe(3)
    expect(out[0].title.length).toBe(300)
    expect(out[0].timestamp).toBe(new Date("2024-01-01").toISOString())
    expect(out[1].url).toBe("https://b.com/y")
    expect(out[1].snippet).toBe("")
    expect(out[1].timestamp).toBeUndefined()
    // relative date is garbage — dropped, never stored raw
    expect(out[2].timestamp).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unparseable"))
  })

  it("serper maps organic link/title/snippet/date and drops unparsable dates", () => {
    const out = __testMapSerperJson({
      organic: [
        { link: "https://a.com", title: "A", snippet: "S", date: "2024-02-03" },
        { url: "https://b.com", title: "B", publishedDate: "yesterday" },
      ],
    })
    expect(out.length).toBe(2)
    expect(out[0].timestamp).toBe(new Date("2024-02-03").toISOString())
    expect(out[1].url).toBe("https://b.com")
    expect(out[1].timestamp).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unparseable"))
  })

  it("tavily maps results url/title/content/published_date", () => {
    const out = __testMapTavilyJson({
      results: [
        { url: "https://a.com", title: "A", content: "C", published_date: "2024-03-04" },
        { url: "https://b.com", title: "B", content: "C2" },
      ],
    })
    expect(out.length).toBe(2)
    expect(out[0].timestamp).toBe(new Date("2024-03-04").toISOString())
    expect(out[1].timestamp).toBeUndefined()
  })
})

describe("provider failure paths (fetch mocked)", () => {
  const KEY_ENV: Array<[string, string]> = [
    ["BRAVE_API_KEY", "brave"],
    ["SERPER_API_KEY", "serper"],
    ["TAVILY_API_KEY", "tavily"],
  ]
  const backup: Record<string, string | undefined> = {}
  let warn: { mock: { calls: unknown[][] } }

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const [k] of KEY_ENV) {
      backup[k] = process.env[k]
      process.env[k] = "test-key"
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const [k] of KEY_ENV) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]!
    }
  })

  it("brave 429 warns rate-limit + Retry-After and throws (no silent [])", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      fetchResponse({
        ok: false,
        status: 429,
        headers: { get: (h: string) => (h === "Retry-After" ? "12" : null) },
        text: async () => "slow down",
      })
    ))
    await expect(braveProvider.search("q")).rejects.toThrow(/429 rate-limited/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("429 rate-limited"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Retry-After: 12"))
  })

  it("brave HTTP 500 warns status + body and throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      fetchResponse({ ok: false, status: 500, text: async () => "boom" })
    ))
    await expect(braveProvider.search("q")).rejects.toThrow(/HTTP 500/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"))
  })

  it("brave HTTP 200 + unparseable JSON warns instead of silent []", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      fetchResponse({ json: async () => { throw new Error("bad json") } })
    ))
    await expect(braveProvider.search("q")).rejects.toThrow(/unparseable JSON/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unparseable JSON"))
  })

  it("serper and tavily follow the same throw + warn contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ ok: false, status: 429, headers: { get: () => "7" }, text: async () => "" })))
    await expect(serperProvider.search("q")).rejects.toThrow(/429 rate-limited/)
    await expect(tavilyProvider.search("q")).rejects.toThrow(/429 rate-limited/)
    const rate = warn.mock.calls.filter((c) => String(c[0]).includes("rate-limited"))
    expect(rate.length).toBeGreaterThanOrEqual(2)
  })

  it("missing key returns [] and warns only once per provider", async () => {
    delete process.env.BRAVE_API_KEY
    delete process.env.TAVILY_API_KEY
    delete process.env.SERPER_API_KEY
    await expect(braveProvider.search("q1")).resolves.toEqual([])
    await expect(braveProvider.search("q2")).resolves.toEqual([])
    await expect(tavilyProvider.search("q1")).resolves.toEqual([])
    await expect(tavilyProvider.search("q2")).resolves.toEqual([])
    await expect(serperProvider.search("q1")).resolves.toEqual([])
    await expect(serperProvider.search("q2")).resolves.toEqual([])
    const noKey = warn.mock.calls.filter((c) => String(c[0]).includes("unavailable"))
    expect(noKey.length).toBe(3)
  })

  it("brave happy path maps a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      fetchResponse({ json: async () => ({ results: [{ url: "https://a.com", title: "A", description: "D" }] }) })
    ))
    const res = await braveProvider.search("q", { limit: 5 })
    expect(res.length).toBe(1)
    expect(res[0].url).toBe("https://a.com")
  })
})
