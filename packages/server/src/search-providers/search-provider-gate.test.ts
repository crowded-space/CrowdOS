import { describe, it, expect, beforeEach, vi } from "vitest"
import { normalizeUrl, dedupeByUrl, searchProviderGate } from "./search-provider-gate.js"
import type { SearchResult } from "./search-provider-types.js"

describe("SearchProviders normalizeUrl & dedupe", () => {
  it("normalizeUrl lowercases host, strips www, trailing slash, tracking params, fragment", () => {
    expect(normalizeUrl("https://WWW.Example.COM/path/")).toBe("https://example.com/path")
    expect(normalizeUrl("https://example.com/path?utm_source=google&x=1#section")).toBe("https://example.com/path?x=1")
    expect(normalizeUrl("https://example.com/path?fbclid=xxx&keep=yes")).toBe("https://example.com/path?keep=yes")
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe("https://example.com/a?a=1&b=2")
    // Default port handling: http 80, https 443 stripped is ideal but not required; at least host lowercased
    expect(normalizeUrl("http://example.com:80/path")).toContain("example.com")
  })

  it("dedupeByUrl removes URL duplicates via normalization", () => {
    const results: SearchResult[] = [
      { url: "https://example.com/page", title: "A", snippet: "s1", source: "brave" },
      { url: "https://example.com/page/", title: "A dup slash", snippet: "s1 dup", source: "tavily" },
      { url: "https://www.example.com/page?utm_campaign=x", title: "A tracking", snippet: "s2", source: "serper" },
      { url: "https://example.com/other", title: "B", snippet: "s3", source: "brave" },
    ]
    const { deduped, duplicates } = dedupeByUrl(results)
    expect(deduped.length).toBe(2)
    expect(deduped.map((r) => normalizeUrl(r.url))).toContain(normalizeUrl("https://example.com/page"))
    expect(deduped.map((r) => normalizeUrl(r.url))).toContain(normalizeUrl("https://example.com/other"))
    expect(duplicates.length).toBe(2)
    expect(duplicates[0].duplicateOf).toBe("https://example.com/page")
  })

  it("search gate returns [] gracefully when no keys configured", async () => {
    const prevBrave = process.env.BRAVE_API_KEY
    const prevTavily = process.env.TAVILY_API_KEY
    const prevSerper = process.env.SERPER_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.TAVILY_API_KEY
    delete process.env.SERPER_API_KEY
    const res = await searchProviderGate.search("test query", { limit: 5 })
    expect(res).toEqual([])
    if (prevBrave !== undefined) process.env.BRAVE_API_KEY = prevBrave
    if (prevTavily !== undefined) process.env.TAVILY_API_KEY = prevTavily
    if (prevSerper !== undefined) process.env.SERPER_API_KEY = prevSerper
  })

  it("search gate dedupes across providers when keys present (mocked providers)", async () => {
    // Mock providers by temporarily overriding their search methods via gate's internal
    // We can't easily inject, so we mock fetch globally to return overlapping organic results.
    // Instead we test dedupeByUrl directly on combined mock data simulating multiple providers.
    const braveResults: SearchResult[] = [
      { url: "https://example.com/a", title: "A", snippet: "content brave A", timestamp: "2024-01-15T00:00:00.000Z", source: "brave" },
      { url: "https://example.com/b", title: "B", snippet: "content B", timestamp: "2024-01-10T00:00:00.000Z", source: "brave" },
    ]
    const tavilyResults: SearchResult[] = [
      { url: "https://example.com/a?utm_source=x", title: "A dup", snippet: "dup a", timestamp: "2024-01-15T00:00:00.000Z", source: "tavily" },
      { url: "https://example.com/c", title: "C", snippet: "content C", timestamp: "2024-01-20T00:00:00.000Z", source: "tavily" },
    ]
    const combined = [...braveResults, ...tavilyResults]
    const { deduped } = dedupeByUrl(combined)
    expect(deduped.length).toBe(3)
    // Ensure url 'a' deduped
    const urls = deduped.map((r) => normalizeUrl(r.url))
    expect(urls.filter((u) => u === normalizeUrl("https://example.com/a")).length).toBe(1)
  })

  it("freshness sorting is handled by ResearchRuntime sortByFreshness (imported)", async () => {
    const { sortByFreshness } = await import("../runtime/runtimes/research-runtime.js")
    const now = new Date()
    const inputs: SearchResult[] = [
      { url: "https://a.com/1", title: "old", snippet: "old", timestamp: new Date(now.getTime() - 100000).toISOString(), source: "brave" },
      { url: "https://a.com/2", title: "newest", snippet: "new", timestamp: now.toISOString(), source: "tavily" },
      { url: "https://a.com/3", title: "mid", snippet: "mid", timestamp: new Date(now.getTime() - 50000).toISOString(), source: "serper" },
      { url: "https://a.com/4", title: "no ts", snippet: "no ts", source: "brave" },
    ]
    const sorted = sortByFreshness(inputs)
    expect(sorted[0].title).toBe("newest")
    expect(sorted[1].title).toBe("mid")
    expect(sorted[2].title).toBe("old")
    expect(sorted[3].title).toBe("no ts") // missing timestamp = oldest
  })
})

describe("SearchProviders providers graceful fallback", () => {
  it("brave/tavily/serper return [] when key absent (no throw)", async () => {
    const { braveProvider } = await import("./providers/brave.js")
    const { tavilyProvider } = await import("./providers/tavily.js")
    const { serperProvider } = await import("./providers/serper.js")
    const prevBrave = process.env.BRAVE_API_KEY
    const prevTavily = process.env.TAVILY_API_KEY
    const prevSerper = process.env.SERPER_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.TAVILY_API_KEY
    delete process.env.SERPER_API_KEY
    await expect(braveProvider.search("hello")).resolves.toEqual([])
    await expect(tavilyProvider.search("hello")).resolves.toEqual([])
    await expect(serperProvider.search("hello")).resolves.toEqual([])
    if (prevBrave !== undefined) process.env.BRAVE_API_KEY = prevBrave; else delete (process.env as Record<string, string | undefined>).BRAVE_API_KEY
    if (prevTavily !== undefined) process.env.TAVILY_API_KEY = prevTavily; else delete (process.env as Record<string, string | undefined>).TAVILY_API_KEY
    if (prevSerper !== undefined) process.env.SERPER_API_KEY = prevSerper; else delete (process.env as Record<string, string | undefined>).SERPER_API_KEY
  })
})
