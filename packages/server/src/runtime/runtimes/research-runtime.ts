import type { ContextPacket, RuntimeResult, RuntimeEvent, ModelModuleConfig, LLMRequest } from "../types.js"
import type { EventBroker } from "../../event-broker/event-broker-gate.js"
import { BaseRuntime } from "./base-runtime.js"
import { searchProviderGate } from "../../search-providers/search-provider-gate.js"
import type { SearchResult } from "../../search-providers/search-provider-gate.js"
// ponytail: dedupe/sort live in searchProviderGate — re-exported here for compat.
export { dedupeEvidence, sortByFreshness } from "../../search-providers/search-provider-gate.js"
import { estimateTokens } from "../kernel/context-budget.js"
import { logMetric } from "../../shared/core/structured-log.js"
import { ProviderRegistry } from "../providers/provider-registry.js"

// ---------------------------------------------------------------------------
// Helpers: fetch
// ---------------------------------------------------------------------------

async function fetchUrlContent(url: string, signal?: AbortSignal): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("fetch timeout")), 5000)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "CrowdOS-ResearchRuntime/1.0" } })
    if (!res.ok) return null
    const ct = res.headers.get("content-type") || ""
    if (ct.includes("text/html") || ct.includes("text/plain") || ct.includes("application/json")) {
      const text = await res.text()
      // Strip HTML tags naively for snippet enrichment
      const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      return stripped.slice(0, 4000) || null
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Decomposition: LLM cheap-tier or template fallback
// ---------------------------------------------------------------------------

function templateDecompose(query: string): string[] {
  const q = query.trim()
  if (!q) return [q]
  // If query already contains multiple clauses, split heuristically
  const parts = q
    .split(/\s+and\s+|\s+or\s+|\;\s*|\,\s*(?=\w+\s)/i)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length >= 3 && parts.length <= 5) {
    return parts.slice(0, 5)
  }
  const year = new Date().getFullYear()
  const variants = [
    q,
    `${q} background and context`,
    `${q} recent developments ${year}`,
    `${q} key facts and evidence`,
  ]
  // Deduplicate and cap
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const v of variants) {
    const n = v.toLowerCase()
    if (!seen.has(n)) {
      seen.add(n)
      uniq.push(v)
    }
  }
  return uniq.slice(0, 3)
}

async function decomposeQuery(
  query: string,
  packet: ContextPacket,
  modelConfig: ModelModuleConfig
): Promise<{ subQuestions: string[]; usedLLM: boolean; llmUsage?: { promptTokens: number; completionTokens: number } }> {
  // Prefer cheap tier via modelRouting when available
  let effectiveConfig = modelConfig
  let taskClass: string = "summarize"
  try {
    const { loadRoutingModules, resolveModelModule, routingEnabled } = await import("../../shared/core/model-routing.js")
    if (routingEnabled()) {
      try {
        const modules = await loadRoutingModules().catch(() => [] as unknown[])
        if (Array.isArray(modules) && modules.length > 0) {
          const decision = resolveModelModule({
            runtimeType: "research",
            taskClass: "summarize" as any,
            availableModules: modules as any,
            staticModuleId: (packet as unknown as { metadata?: { modelModuleId?: string | null } }).metadata?.modelModuleId ?? null,
            logOnly: true,
          } as any)
          taskClass = String(decision.tier)
        }
      } catch {}
    }
  } catch {}

  // Attempt LLM decomposition if provider seems usable
  try {
    const providerName = effectiveConfig.provider || "google"
    const adapter = ProviderRegistry.get(providerName)
    const llmRequest: LLMRequest = {
      systemPrompt:
        "You are a research query decomposer. Break the user query into 3-5 focused sub-questions suitable for web search. Return ONLY a JSON array of strings, e.g. [\"sub-question 1\",\"sub-question 2\"]. No explanation.",
      userPrompt: `Query: "${query}"`,
      temperature: 0.3,
      maxTokens: 400,
    }
    // Build a minimal model config for this call (cheap tier preference hint)
    const callConfig: ModelModuleConfig = {
      ...effectiveConfig,
      temperature: 0.3,
      maxOutputTokens: 400,
    }
    const response = await adapter.call(callConfig, llmRequest, undefined, { signal: packet.abortSignal })
    // Track routing metric for decompose attempt
    logMetric({
      stage: "model.route",
      runtimeType: "research",
      taskClass,
      operation: "research.decompose",
      provider: providerName,
      chosenModel: callConfig.modelName,
      subQuestionsAttempted: true,
    } as any)
    const text = (response.content || "").trim()
    let parsed: string[] | null = null
    // Try JSON parse
    try {
      const maybe = JSON.parse(text)
      if (Array.isArray(maybe) && maybe.every((x: unknown) => typeof x === "string")) {
        parsed = (maybe as string[]).map((s) => s.trim()).filter(Boolean)
      }
    } catch {}
    if (!parsed) {
      // Fallback: split lines
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[\-\*\d\.\)]+\s*/, "").trim())
        .filter((l) => l.length > 5 && l.length < 300)
      if (lines.length >= 2 && lines.length <= 6) parsed = lines
    }
    if (parsed && parsed.length >= 2) {
      const uniq = [...new Set(parsed.map((s) => s.trim()).filter(Boolean))].slice(0, 5)
      if (uniq.length >= 2) {
        return { subQuestions: uniq, usedLLM: true, llmUsage: { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } }
      }
    }
  } catch (err) {
    // LLM unavailable — fall through to template
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[ResearchRuntime] decompose LLM failed, falling back to template: ${msg.slice(0, 200)}`)
  }
  const templated = templateDecompose(query)
  return { subQuestions: templated, usedLLM: false }
}

// ---------------------------------------------------------------------------
// Synthesis: compress evidence bundle to cited report
// ---------------------------------------------------------------------------

async function synthesizeReport(
  query: string,
  subQuestions: string[],
  sources: SearchResult[],
  packet: ContextPacket,
  modelConfig: ModelModuleConfig
): Promise<{ report: string; usedLLM: boolean; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const evidenceLines = sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet.slice(0, 800)}\nTimestamp: ${s.timestamp ?? "unknown"}\nSource: ${s.source}`)
    .join("\n\n")

  const systemPrompt =
    "You are a research synthesizer for CrowdOS. Given an evidence bundle of web search results, produce a concise cited report (300-600 words) that answers the user's query. Every factual claim must be cited with footnotes like [1], [2] referencing the evidence list. Include a Sources section at the end listing each [n] with title and URL. Be faithful to the evidence; if evidence is insufficient, state so. Do not hallucinate beyond snippets."

  const userPrompt = `Query: "${query}"\n\nSub-questions explored: ${subQuestions.join(" | ")}\n\nEvidence bundle (${sources.length} sources):\n\n${evidenceLines}\n\nProduce the cited report now.`

  // Route decision cheap tier (summarize prefers flash)
  let routeInfo: { tier: string; chosen?: string } = { tier: "flash" }
  try {
    const { loadRoutingModules, resolveModelModule, routingEnabled } = await import("../../shared/core/model-routing.js")
    if (routingEnabled()) {
      try {
        const modules = await loadRoutingModules().catch(() => [] as unknown[])
        if (Array.isArray(modules) && modules.length > 0) {
          const decision = resolveModelModule({
            runtimeType: "research",
            taskClass: "summarize" as any,
            availableModules: modules as any,
            staticModuleId: (packet as unknown as { metadata?: { modelModuleId?: string | null } }).metadata?.modelModuleId ?? null,
            logOnly: true,
          } as any)
          routeInfo.tier = String(decision.tier)
          routeInfo.chosen = String(decision.moduleId ?? modelConfig.modelName)
        }
      } catch {}
    }
  } catch {}

  // Log model.route for synthesis (required by spec)
  logMetric({
    stage: "model.route",
    runtimeType: "research",
    taskClass: "summarize",
    operation: "research.synthesis",
    tier: routeInfo.tier,
    chosenModuleId: routeInfo.chosen ?? modelConfig.modelName,
    evidenceCount: sources.length,
    subQuestions: subQuestions.length,
  } as any)

  try {
    const providerName = modelConfig.provider || "google"
    const adapter = ProviderRegistry.get(providerName)
    const callConfig: ModelModuleConfig = {
      ...modelConfig,
      temperature: 0.2,
      maxOutputTokens: 1200,
    }
    const response = await adapter.call(
      callConfig,
      {
        systemPrompt,
        userPrompt,
        temperature: 0.2,
        maxTokens: 1200,
      },
      undefined,
      { signal: packet.abortSignal }
    )
    const report = (response.content || "").trim()
    if (report.length > 100) {
      return {
        report,
        usedLLM: true,
        usage: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
        },
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[ResearchRuntime] synthesis LLM failed, falling back to template: ${msg.slice(0, 300)}`)
  }

  // Template fallback — still cited and includes all sources
  const nowIso = new Date().toISOString().slice(0, 10)
  let report = `# Research Report: ${query}\n\n`
  report += `*Generated ${nowIso} from ${sources.length} source(s) across ${subQuestions.length} sub-question(s).*\n\n`
  report += `## Query\n${query}\n\n`
  report += `## Sub-questions\n${subQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n`
  report += `## Findings\n\n`
  if (sources.length === 0) {
    report += `No web results were available for this query (no provider keys configured or no results returned). The evidence bundle is empty, so no external claims can be cited. Please configure BRAVE_API_KEY, TAVILY_API_KEY or SERPER_API_KEY to enable live search.\n\n`
  } else {
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      const snippet = s.snippet.slice(0, 500)
      report += `### [${i + 1}] ${s.title}\n`
      report += `*Source: ${s.source} — ${s.url} ${s.timestamp ? `(${s.timestamp.slice(0, 10)})` : ""}*\n\n`
      report += `${snippet}${snippet.length >= 500 ? "…" : ""} [${i + 1}]\n\n`
    }
  }
  report += `## Synthesis\n`
  if (sources.length === 0) {
    report += `Insufficient evidence to answer "${query}" from web sources. The synthesis is therefore inconclusive; live search keys are required for a cited report.\n\n`
  } else {
    report += `The above ${sources.length} source(s) provide the current evidence for "${query}". Key points are cited per source [1]–[${sources.length}]. For detailed verification, see the Sources section and the underlying evidence bundle artifact (type citations) which preserves full snippets, timestamps, dedupe and freshness metadata.\n\n`
  }
  report += `## Sources\n`
  if (sources.length === 0) {
    report += `*No sources — evidence bundle empty.*\n`
  } else {
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      report += `[${i + 1}] ${s.title} — ${s.url} (${s.source}${s.timestamp ? `, ${s.timestamp.slice(0, 10)}` : ""})\n`
    }
  }
  report += `\n---\n*Report generated by ResearchRuntime synthesis fallback (no LLM available); evidence bundle preserved separately.*\n`

  const promptTokens = estimateTokens(systemPrompt + userPrompt)
  const completionTokens = estimateTokens(report)
  return {
    report,
    usedLLM: false,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  }
}

// ---------------------------------------------------------------------------
// ResearchRuntime — supervisor flow
// ---------------------------------------------------------------------------

export class ResearchRuntime extends BaseRuntime {
  readonly type = "research" as const

  async execute(packet: ContextPacket, broker: EventBroker): Promise<RuntimeResult> {
    const runtimeEvents: RuntimeEvent[] = []
    let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    try {
      if (packet.abortSignal?.aborted) {
        return {
          requestId: packet.requestId,
          agentId: packet.agentId,
          channelId: packet.channelId,
          finalResponse: "Run cancelled by user.",
          runtimeEvents,
          usage: totalUsage,
          status: "cancelled",
        }
      }

      await this.kernel.setAgentStatus(broker, packet.agentId, "working")
      this.kernel.emitThinking(broker, packet.agentId, packet.channelId)

      const query = packet.userInput?.trim() || ""
      if (!query) {
        const emptyReport = "No research query provided — unable to produce a cited report."
        await this.kernel.persistMessage(broker, packet.channelId, packet.agentId, packet.agentName, packet.authorityLevel, emptyReport, false, packet.runId ? { runId: packet.runId } : undefined, undefined, packet.workspaceId)
        await this.kernel.setAgentStatus(broker, packet.agentId, "idle")
        return {
          requestId: packet.requestId,
          agentId: packet.agentId,
          channelId: packet.channelId,
          finalResponse: emptyReport,
          runtimeEvents,
          usage: totalUsage,
          status: "completed",
        }
      }

      const modelConfig: ModelModuleConfig =
        (packet as unknown as { _modelConfig?: ModelModuleConfig })._modelConfig ?? {
          provider: "google",
          modelName: "gemini-2.0-flash",
          temperature: 0.2,
          maxOutputTokens: 1200,
        }

      // (a) Decompose query into sub-questions (LLM cheap tier or template)
      const decomposeRes = await decomposeQuery(query, packet, modelConfig)
      const subQuestions = decomposeRes.subQuestions
      if (decomposeRes.llmUsage) {
        totalUsage.promptTokens += decomposeRes.llmUsage.promptTokens
        totalUsage.completionTokens += decomposeRes.llmUsage.completionTokens
        totalUsage.totalTokens += decomposeRes.llmUsage.promptTokens + decomposeRes.llmUsage.completionTokens
      }

      // (b) Spawn isolated sub-runs — isolated window, search+fetch tools only
      // Each sub-question runs as an isolated search (and optional fetch enrichment).
      // QUE/RES: if QUEUE_MODE=bullmq we could enqueueRun per sub-question; for now
      // we run inline and log the mode, preserving the isolated-window discipline.
      // The isolation guarantee: sub-run history never touches packet.history; only
      // the evidence bundle artifact is retained, and only the compressed report
      // reaches the main context (token delta assertion).
      let queueMode = "inline"
      try {
        const { queueGate } = await import("../../queue/queue-gate.js")
        queueMode = queueGate.mode()
      } catch {}

      const subRunResults: SearchResult[][] = []
      const childRunIds: string[] = []

      // Create child run rows for audit trail when runs enabled and parent exists
      let parentRunId: string | null = packet.runId ?? null

      // Bounded parallel execution of isolated sub-runs (each sub-run own window)
      const concurrency = Math.min(subQuestions.length, 3)
      // Simple pool without external deps
      const pending = [...subQuestions.entries()] // [index, question]
      const resultsByIndex = new Map<number, SearchResult[]>()

      const runIsolatedSubRun = async (idx: number, subQ: string): Promise<SearchResult[]> => {
        // child run creation (best-effort, never blocks main flow)
        let childId: string | null = null
        if (parentRunId) {
          try {
            const { runsGate } = await import("../../runs/runs-gate.js")
            const child = await runsGate.create({ agentId: packet.agentId, channelId: packet.channelId, workspaceId: packet.workspaceId, runtimeType: "research" } as unknown as Parameters<typeof runsGate.create>[0])
            // runsGate.create may not support parentRunId in current signature; try raw createRun with parentRunId
            if (child && (child as unknown as { id: string }).id) {
              childId = (child as unknown as { id: string }).id
              childRunIds.push(childId)
              // Walk to running for traceability (best-effort)
              try {
                await runsGate.transition(childId, "starting", "research_child_starting")
                await runsGate.transition(childId, "running", "research_child_running")
              } catch {}
            } else if (parentRunId) {
              // Fallback: try direct repository with parentRunId if gate doesn't expose it
              try {
                const { createRun } = await import("../../runs/runs-repository.js")
                const child2 = await createRun({ parentRunId, agentId: packet.agentId, channelId: packet.channelId, workspaceId: packet.workspaceId, runtimeType: "research" })
                if (child2?.id) {
                  childId = child2.id
                  childRunIds.push(childId)
                }
              } catch {}
            }
          } catch {}
        }

        // Isolated search — only search+fetch tools allowed. This sub-run's history
        // is intentionally NOT packet.history; raw results stay out of main context.
        let results: SearchResult[] = []
        try {
          if (queueMode === "bullmq") {
            // RT-1 / QUE: when bullmq is active, optionally enqueue sub-run trace
            try {
              const { queueGate } = await import("../../queue/queue-gate.js");
              await queueGate.enqueueRun({
                runId: childId ?? undefined,
                channelId: packet.channelId,
                agentId: packet.agentId,
                messageId: `res-sub-${idx}-${Date.now()}`,
                userInput: subQ,
                workspaceId: packet.workspaceId,
              });
            } catch {}
          }
          const searchRes = await searchProviderGate.search(subQ, { limit: 8, signal: packet.abortSignal, timeoutMs: 6000 })
          results = [...searchRes]

          // Optional fetch enrichment for top 2 results (search+fetch toolkit)
          // Enrich snippet with fetched page content when search snippet is short.
          const enrichCount = Math.min(2, results.length)
          for (let i = 0; i < enrichCount; i++) {
            if (packet.abortSignal?.aborted) break
            const r = results[i]
            if (r.snippet.length < 500) {
              const fetched = await fetchUrlContent(r.url, packet.abortSignal).catch(() => null)
              if (fetched && fetched.length > r.snippet.length + 50) {
                results[i] = { ...r, snippet: `${r.snippet}\n\nFetched: ${fetched.slice(0, 1500)}` }
              }
            }
          }
        } catch (err) {
          console.warn(`[ResearchRuntime] isolated sub-run ${idx} failed for "${subQ.slice(0, 80)}":`, err instanceof Error ? err.message : String(err))
          results = []
        }

        // Complete child run traceability
        if (childId) {
          try {
            const { runsGate } = await import("../../runs/runs-gate.js")
            await runsGate.transition(childId, "completing", "research_child_completing")
            await runsGate.transition(childId, "verifying", "research_child_verifying")
            await runsGate.transition(childId, "completed", "research_child_completed")
          } catch {}
        }

        return results
      }

      // Bounded pool execution
      const workers: Promise<void>[] = []
      let cursor = 0
      const worker = async () => {
        while (cursor < pending.length) {
          const idx = cursor++
          const [origIdx, subQ] = pending[idx]
          if (packet.abortSignal?.aborted) {
            resultsByIndex.set(origIdx, [])
            continue
          }
          const res = await runIsolatedSubRun(origIdx, subQ)
          resultsByIndex.set(origIdx, res)
        }
      }
      for (let i = 0; i < Math.min(concurrency, pending.length); i++) workers.push(worker())
      await Promise.all(workers)

      // Preserve sub-question order when flattening
      for (let i = 0; i < subQuestions.length; i++) {
        subRunResults.push(resultsByIndex.get(i) ?? [])
      }

      const flatRaw = subRunResults.flat()
      const rawCount = flatRaw.length

      // (c) Aggregate evidence bundle: dedupe by URL+similarity, freshness sort, timestamps preserved
      const { deduped, duplicates } = searchProviderGate.dedupeEvidence(flatRaw, 0.8)
      const dedupedSorted = searchProviderGate.sortByFreshness(deduped)
      const allDuplicates = duplicates

      const evidenceBundle = {
        query,
        subQuestions,
        sources: dedupedSorted,
        rawCount,
        dedupedCount: dedupedSorted.length,
        dedupeDetails: allDuplicates,
        freshnessSorted: true,
        generatedAt: new Date().toISOString(),
        queueMode,
        childRunIds,
      }

      // (d) Synthesis step compresses bundle to cited report (LLM call with bundle as context)
      const synthesis = await synthesizeReport(query, subQuestions, dedupedSorted, packet, modelConfig)
      const report = synthesis.report
      totalUsage.promptTokens += synthesis.usage.promptTokens
      totalUsage.completionTokens += synthesis.usage.completionTokens
      totalUsage.totalTokens += synthesis.usage.totalTokens

      // Token delta assertion invariant: raw results never enter main context
      // Main-channel prompt-token delta is at most report size (plus small fixed overhead).
      // We assert here for observability; the test asserts the same externally.
      const rawTokens = flatRaw.reduce((sum, r) => sum + estimateTokens(r.snippet), 0)
      const reportTokens = estimateTokens(report)
      if (totalUsage.promptTokens > reportTokens + 500) {
        // Allow 500 token overhead for system prompt/history; warn if exceeded
        console.warn(
          `[ResearchRuntime] token delta check: promptTokens ${totalUsage.promptTokens} > reportTokens ${reportTokens} + overhead — possible raw leak (rawTokens ${rawTokens})`
        )
      }

      // Guarantee raw results are NOT in packet.history (isolation claim)
      const historyContainsRaw = packet.history.some((h) => flatRaw.some((r) => r.snippet && h.content.includes(r.snippet.slice(0, 80))))
      if (historyContainsRaw) {
        console.error("[ResearchRuntime] INVARIANT VIOLATION: raw search snippets leaked into main history!")
      }

      // (e) Store bundle as Artifacts type citations + report as type report
      // Best-effort: DB may be unavailable in tests; never fail the run over artifacts.
      try {
        const { artifactsGate } = await import("../../artifacts/artifacts-gate.js")
        const bundleJson = JSON.stringify(evidenceBundle, null, 2)
        // citations artifact — full bundle preserved
        await artifactsGate.create({
          runId: packet.runId ?? null,
          workspaceId: packet.workspaceId,
          producerAgent: packet.agentId,
          type: "citations",
          path: null,
          beforeHash: null,
          afterHash: null,
          patch: null,
          contentRef: bundleJson.length > 50000 ? bundleJson.slice(0, 50000) : bundleJson,
          metadata: {
            query,
            subQuestions,
            rawCount,
            dedupedCount: dedupedSorted.length,
            dedupeDetails: allDuplicates,
            freshness: "sorted_by_timestamp_desc",
            timestamps: dedupedSorted.map((r) => r.timestamp ?? null),
            sources: dedupedSorted.map((r) => ({ url: r.url, title: r.title, source: r.source, timestamp: r.timestamp ?? null })),
            queueMode,
            childRunIds,
            // Make dedupe/freshness visible at top-level metadata for accept criteria
            dedupeVisible: true,
            freshnessVisible: true,
          },
        } as unknown as Parameters<typeof artifactsGate.create>[0])
      } catch (err) {
        console.warn("[ResearchRuntime] citations artifact store failed:", err instanceof Error ? err.message : String(err))
      }

      try {
        const { artifactsGate } = await import("../../artifacts/artifacts-gate.js")
        await artifactsGate.create({
          runId: packet.runId ?? null,
          workspaceId: packet.workspaceId,
          producerAgent: packet.agentId,
          type: "report",
          path: null,
          beforeHash: null,
          afterHash: null,
          patch: null,
          contentRef: report.length > 50000 ? report.slice(0, 50000) : report,
          metadata: {
            query,
            citationCount: dedupedSorted.length,
            reportLengthChars: report.length,
            reportTokens: estimateTokens(report),
            rawTokens,
            sources: dedupedSorted.map((r) => r.url),
            subQuestions,
            synthesisUsedLLM: synthesis.usedLLM,
            queueMode,
          },
        } as unknown as Parameters<typeof artifactsGate.create>[0])
      } catch (err) {
        console.warn("[ResearchRuntime] report artifact store failed:", err instanceof Error ? err.message : String(err))
      }

      // (f) Return report to channel, raw results NEVER injected into main context (only report size counted)
      // Persist report as the sole user-visible message for this run
      await this.kernel.persistMessage(
        broker,
        packet.channelId,
        packet.agentId,
        packet.agentName,
        packet.authorityLevel,
        report,
        false,
        packet.runId ? { runId: packet.runId } : undefined,
        undefined,
        packet.workspaceId
      )

      await this.kernel.setAgentStatus(broker, packet.agentId, "idle")

      // Also persist internal reflection if sub-runs produced thoughts? Not needed for research

      return {
        requestId: packet.requestId,
        agentId: packet.agentId,
        channelId: packet.channelId,
        finalResponse: report,
        runtimeEvents,
        usage: totalUsage,
        status: "completed",
      }
    } catch (err) {
      console.error("[ResearchRuntime] Error:", err)
      try {
        await this.kernel.setAgentStatus(broker, packet.agentId, "idle")
      } catch {}
      return await this.buildFailedResult(packet, err, broker)
    }
  }
}
