import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ResearchRuntime, dedupeEvidence, sortByFreshness } from "./ResearchRuntime.js"
import { searchProviderGate } from "../../SearchProviders/searchProviderGate.js"
import { artifactsGate } from "../../Artifacts/artifactsGate.js"
import { ProviderRegistry } from "../providers/ProviderRegistry.js"
import { EventBroker } from "../../EventBroker/eventBrokerGate.js"
import { estimateTokens } from "../kernel/contextBudget.js"
import type { ContextPacket } from "../types.js"
import type { SearchResult } from "../../SearchProviders/searchProviderGate.js"

const origEnv = { ...process.env }

function makePacket(overrides: Record<string, unknown> = {}): ContextPacket & { _modelConfig: any } {
  return {
    requestId: "req_test_research",
    agentId: "agent-1",
    agentName: "Researcher",
    authorityLevel: 1,
    channelId: "ch-1",
    workspaceId: "ws-1",
    userInput: "What is the effect of quantum computing on cryptography?",
    systemPrompt: "You are a research assistant.",
    history: [{ role: "user", content: "Hello", timestamp: new Date(), isSelf: false }],
    tools: [],
    policies: { maxTokenBudget: 8000, maxIterations: 5, allowToolCalls: true, allowSpawn: false, allowDelegation: false, loopDetection: true, streamOutput: false },
    metadata: { runtimeType: "research", provider: "google", modelName: "gemini-2.0-flash", modelModuleId: "mod-01", startedAt: new Date() },
    runId: null,
    _modelConfig: { provider: "google", modelName: "gemini-2.0-flash", temperature: 0.2, maxOutputTokens: 1200 },
    ...overrides,
  } as unknown as ContextPacket & { _modelConfig: any }
}

describe("ResearchRuntime helpers", () => {
  it("dedupeEvidence by URL+similarity and freshness sort preserve timestamps", () => {
    const results: SearchResult[] = [
      { url: "https://example.com/a", title: "A", snippet: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi", timestamp: "2024-01-20T00:00:00.000Z", source: "brave" },
      { url: "https://example.com/a/", title: "A dup slash", snippet: "different snippet but same url", timestamp: "2024-01-19T00:00:00.000Z", source: "tavily" },
      { url: "https://example.com/b", title: "B", snippet: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi", timestamp: "2024-01-10T00:00:00.000Z", source: "serper" }, // near dup snippet with A
      { url: "https://example.com/c", title: "C", snippet: "completely different content about cryptography and quantum keys omicron pi rho", timestamp: "2024-01-15T00:00:00.000Z", source: "brave" },
      { url: "https://example.com/d", title: "D", snippet: "another unique snippet sigma tau upsilon phi chi psi omega", timestamp: undefined, source: "tavily" },
    ]
    const { deduped, duplicates } = dedupeEvidence(results, 0.8)
    // Expect url dup for a/ removes second, snippet dup removes b (near duplicate with A)
    expect(deduped.length).toBe(3)
    // Should keep A, C, D (B removed as near dup, A slash dup removed)
    const urls = deduped.map((r) => r.url)
    expect(urls).toContain("https://example.com/a")
    expect(urls).toContain("https://example.com/c")
    expect(urls).toContain("https://example.com/d")
    expect(duplicates.length).toBe(2)
    expect(duplicates.some((d) => d.reason === "duplicate_url")).toBe(true)
    expect(duplicates.some((d) => d.reason === "near_duplicate_snippet")).toBe(true)

    const sorted = sortByFreshness(deduped)
    // Freshness: A (2024-01-20) > C (2024-01-15) > D (no ts = oldest)
    expect(sorted[0].url).toBe("https://example.com/a")
    expect(sorted[1].url).toBe("https://example.com/c")
    expect(sorted[2].url).toBe("https://example.com/d")
    // timestamps preserved
    expect(sorted[0].timestamp).toBe("2024-01-20T00:00:00.000Z")
    expect(sorted[2].timestamp).toBeUndefined()
  })
})

describe("ResearchRuntime evidence bundle + synthesis (RT-1)", () => {
  let capturedArtifacts: Array<Record<string, unknown>>
  let persistedMessages: Array<{ content: string }>
  let mockSearchResults: SearchResult[]

  beforeEach(() => {
    process.env.RESEARCH_V1 = "true"
    capturedArtifacts = []
    persistedMessages = []
    // Stub global fetch to avoid real network during enrichment (fetchUrlContent)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => "" } as any)))
    // Mock artifactsGate.create to capture without DB
    vi.spyOn(artifactsGate, "create").mockImplementation(async (input: any) => {
      capturedArtifacts.push(input as Record<string, unknown>)
      return {
        id: `art_${capturedArtifacts.length}`,
        workspaceId: input.workspaceId,
        producerAgent: input.producerAgent,
        artifactType: input.type,
        path: input.path ?? null,
        semanticTags: [],
        metadata: input.metadata ?? {},
        createdAt: new Date(),
        runId: input.runId ?? null,
        beforeHash: null,
        afterHash: null,
        patch: null,
        contentRef: input.contentRef ?? null,
      } as unknown as ReturnType<typeof artifactsGate.create> extends Promise<infer T> ? T : never
    })

    // Mock search results with dedupe and freshness challenge
    // Snippets are >500 chars to skip fetch enrichment (avoids real network in test)
    const filler = " ".repeat(10) + "lorem ipsum ".repeat(60)
    mockSearchResults = [
      // Will be returned per sub-question; we make gate return overlapping set per call
      { url: "https://example.com/quantum-a", title: "Quantum A", snippet: "Quantum computing threatens RSA encryption via Shor algorithm alpha beta gamma delta epsilon" + filler, timestamp: "2024-03-01T00:00:00.000Z", source: "brave" },
      { url: "https://example.com/quantum-a/", title: "Quantum A dup", snippet: "Duplicate URL with tracking" + filler, timestamp: "2024-03-01T00:00:00.000Z", source: "tavily" },
      { url: "https://example.com/quantum-b", title: "Quantum B", snippet: "Quantum computing threatens RSA encryption via Shor algorithm alpha beta gamma delta epsilon" + filler, timestamp: "2024-02-15T00:00:00.000Z", source: "serper" }, // near dup snippet
      { url: "https://example.com/quantum-c", title: "Quantum C", snippet: "Post-quantum cryptography lattice-based schemes are being standardized by NIST" + filler, timestamp: "2024-02-20T00:00:00.000Z", source: "brave" },
      { url: "https://example.com/quantum-d", title: "Quantum D no ts", snippet: "Unique content about quantum key distribution QKD omega psi chi" + filler, timestamp: undefined, source: "tavily" },
    ]

    vi.spyOn(searchProviderGate, "search").mockImplementation(async (_query: string) => {
      // Return full mock per sub-question to trigger dedupe (URL+similarity) and freshness
      return mockSearchResults
    })

    // Mock provider for decompose/synthesis: intercept google provider
    const mockProvider: any = {
      provider: "google",
      supportsStreaming: false,
      supportsTools: false,
      async call(_config: any, req: any) {
        const sys = String(req.systemPrompt || "")
        const user = String(req.userPrompt || "")
        if (sys.includes("decomposer") || user.includes("Decompose") || user.includes("sub-questions")) {
          return {
            content: JSON.stringify(["What is quantum computing?", "How does Shor algorithm break RSA?", "What is post-quantum cryptography?"]),
            thoughts: undefined,
            toolCalls: [],
            usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
            finishReason: "stop" as const,
          }
        }
        if (sys.includes("research synthesizer") || user.includes("Evidence bundle")) {
          return {
            content: "# Research Report: Quantum Computing Effects\n\nBased on evidence [1] Shor algorithm threatens RSA [1], lattice-based PQC is standardized [2], and QKD offers alternative [3].\n\n## Sources\n[1] Quantum A — https://example.com/quantum-a\n[2] Quantum C — https://example.com/quantum-c\n[3] Quantum D no ts — https://example.com/quantum-d\n",
            thoughts: undefined,
            toolCalls: [],
            usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
            finishReason: "stop" as const,
          }
        }
        return {
          content: "fallback",
          thoughts: undefined,
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          finishReason: "stop" as const,
        }
      },
    }
    // Ensure registry has mock (overwrite if exists)
    try { ProviderRegistry.register(mockProvider) } catch {}
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // Restore env without leaking RESEARCH_V1
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete (process.env as Record<string, string | undefined>)[k]
    }
    Object.assign(process.env, origEnv)
    // Clean provider registry? Keep mock but not necessary; tests isolate by re-registering
  })

  it("yields citation + report artifacts, token delta ≤ report size, raw not in main history, dedupe/freshness visible", async () => {
    const runtime = new ResearchRuntime()
    // Stub kernel DB-touching methods to avoid real DB
    const broker = new EventBroker()
    // Spy kernel methods
    const kernel: any = (runtime as any).kernel
    vi.spyOn(kernel, "setAgentStatus").mockResolvedValue(undefined)
    vi.spyOn(kernel, "emitThinking").mockImplementation(() => {})
    vi.spyOn(kernel, "persistMessage").mockImplementation(async (...args: any[]) => {
      const content = args[5] as string
      persistedMessages.push({ content })
      return 42
    })

    const packet = makePacket({
      userInput: "What is the effect of quantum computing on cryptography?",
      history: [{ role: "user", content: "Hello prior history", timestamp: new Date(), isSelf: false }],
      _modelConfig: { provider: "google", modelName: "gemini-2.0-flash", temperature: 0.2, maxOutputTokens: 1200 },
    } as any)

    const snapshotHistoryContent = packet.history.map((h) => h.content).join("|")
    const result = await runtime.execute(packet as unknown as ContextPacket, broker)

    expect(result.status).toBe("completed")
    expect(result.finalResponse).toContain("Research Report")
    expect(result.finalResponse).toContain("[1]")
    // Persisted only report (plus maybe thinking?), but ensure raw snippets not persisted as separate messages
    // The report should contain source URLs, but raw snippet full text shouldn't leak except via report
    const allPersisted = persistedMessages.map((m) => m.content).join("\n")
    // Report is persisted
    expect(allPersisted).toContain("Research Report")
    // Raw results should NOT have been added to packet.history (isolation)
    expect(packet.history.map((h) => h.content).join("|")).toBe(snapshotHistoryContent)
    expect(packet.history.length).toBe(1)
    // Ensure raw snippets not in history history
    for (const raw of mockSearchResults) {
      const snippetHead = raw.snippet.slice(0, 60)
      // packet.history should not contain raw snippet head
      expect(packet.history.some((h) => h.content.includes(snippetHead))).toBe(false)
    }

    // Artifact assertions: both citations and report created
    expect(capturedArtifacts.length).toBeGreaterThanOrEqual(2)
    const citationsArt = capturedArtifacts.find((a) => a.type === "citations" || (a as any).artifactType === "citations")
    const reportArt = capturedArtifacts.find((a) => a.type === "report" || (a as any).artifactType === "report")
    expect(citationsArt).toBeDefined()
    expect(reportArt).toBeDefined()

    // Dedupe/freshness visible in citations artifact metadata
    const citeMeta = (citationsArt as any).metadata as Record<string, unknown>
    expect(citeMeta.dedupeDetails).toBeDefined()
    expect(Array.isArray(citeMeta.dedupeDetails)).toBe(true)
    // Should have at least one duplicate due to URL and one due to snippet similarity
    const dds = citeMeta.dedupeDetails as Array<{ reason: string }>
    expect(dds.some((d) => d.reason === "duplicate_url")).toBe(true)
    expect(dds.some((d) => d.reason === "near_duplicate_snippet")).toBe(true)
    // Freshness visible
    expect(citeMeta.freshness).toBe("sorted_by_timestamp_desc")
    expect(citeMeta.timestamps).toBeDefined()
    const timestamps = citeMeta.timestamps as Array<string | null>
    // First timestamp should be newest (2024-03-01)
    expect(String(timestamps[0])).toContain("2024-03-01")
    // Deduped count visible
    expect(typeof citeMeta.dedupedCount).toBe("number")
    expect(citeMeta.dedupedCount as number).toBeLessThan(mockSearchResults.length * 3) // deduped < raw*subQs
    // Sources/snippets preserved
    expect(citeMeta.sources).toBeDefined()
    expect((citeMeta.sources as unknown[]).length).toBe(citeMeta.dedupedCount)

    // Report artifact also has citations
    const reportMeta = (reportArt as any).metadata as Record<string, unknown>
    expect(reportMeta.citationCount).toBeDefined()
    expect(reportMeta.reportTokens).toBeDefined()

    // Token delta assert: main-channel prompt-token delta ≤ report size
    // totalUsage.promptTokens should be <= reportTokens + overhead (500)
    const reportTokens = estimateTokens(result.finalResponse)
    expect(result.usage.promptTokens).toBeGreaterThan(0)
    expect(result.usage.promptTokens).toBeLessThanOrEqual(reportTokens + 500)
    // Also completionTokens positive
    expect(result.usage.completionTokens).toBeGreaterThan(0)
    // Raw tokens should be larger than report delta if raw leaked, but we assert delta <= report
    const rawTokens = mockSearchResults.reduce((sum, r) => sum + estimateTokens(r.snippet), 0) * 3 // approx raw across subQs
    // Raw tokens should be > report delta (otherwise test not meaningful), but our dedupe ensures report is smaller
    // At least ensure report tokens not huge vs raw
    expect(reportTokens).toBeLessThan(rawTokens + 500) // trivial but ensures compression

    // Ensure runtimeEvents captured? not required
    expect(result.runtimeEvents).toBeDefined()
  }, 10000)

  it("handles missing provider keys gracefully (fallback report still produced)", async () => {
    // Force search to return [] (no keys) by mocking to return []
    vi.spyOn(searchProviderGate, "search").mockResolvedValue([])
    const runtime = new ResearchRuntime()
    const broker = new EventBroker()
    const kernel: any = (runtime as any).kernel
    vi.spyOn(kernel, "setAgentStatus").mockResolvedValue(undefined)
    vi.spyOn(kernel, "emitThinking").mockImplementation(() => {})
    vi.spyOn(kernel, "persistMessage").mockResolvedValue(1)
    const packet = makePacket()
    const res = await runtime.execute(packet as unknown as ContextPacket, broker)
    expect(res.status).toBe("completed")
    expect(res.finalResponse.length).toBeGreaterThan(50)
    // Still creates artifacts (even if empty bundle)
    expect(capturedArtifacts.length).toBeGreaterThanOrEqual(2)
    const cite = capturedArtifacts.find((a) => (a as any).type === "citations")
    expect((cite as any).metadata.rawCount).toBe(0)
  })
})

describe("ResearchRuntime rollback flag", () => {
  it("RuntimeRouter pins research->agentic when RESEARCH_V1=false", async () => {
    process.env.RESEARCH_V1 = "false"
    const { RuntimeRouter } = await import("../RuntimeRouter.js")
    const router = new RuntimeRouter()
    const agent: any = { id: "a1", name: "test", authorityLevel: 0 }
    const chosen = router.route({ agent, channelTags: ["research"] })
    expect(chosen).toBe("agentic")
    // explicit research also pinned
    const chosen2 = router.route({ agent, explicitRuntime: "research" as any })
    expect(chosen2).toBe("agentic")
    process.env.RESEARCH_V1 = "true"
    const router2 = new RuntimeRouter()
    const chosen3 = router2.route({ agent, channelTags: ["research"] })
    expect(chosen3).toBe("research")
  })

  it("RuntimeExecutor pins research->agentic when RESEARCH_V1=false", async () => {
    process.env.RESEARCH_V1 = "false"
    const { RuntimeExecutor } = await import("../RuntimeExecutor.js")
    const exec = new RuntimeExecutor()
    const map: any = (exec as any).getRuntimeMap()
    // research should be same instance as agentic when disabled
    expect(map.research).toBe(map.agentic)
    process.env.RESEARCH_V1 = "true"
    const exec2 = new RuntimeExecutor()
    const map2: any = (exec2 as any).getRuntimeMap()
    expect(map2.research).not.toBe(map2.agentic)
    // Check instance type
    expect(map2.research.type).toBe("research")
  })
})
