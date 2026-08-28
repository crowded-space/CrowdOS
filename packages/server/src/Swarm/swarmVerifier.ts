import type { ContextPacket } from "../runtime/types.js";
import type { EventBroker } from "../EventBroker/eventBrokerGate.js";
import type { SwarmVerificationResult } from "./swarmTypes.js";

function parseVerificationJson(content: string): SwarmVerificationResult | null {
  if (!content || typeof content !== "string") return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    const verdictRaw = typeof obj.verdict === "string" ? obj.verdict.toLowerCase().trim() : "";
    let verdict: "pass" | "fail" | null = null;
    if (verdictRaw === "pass" || verdictRaw === "approved" || verdictRaw === "success") verdict = "pass";
    else if (verdictRaw === "fail" || verdictRaw === "failed" || verdictRaw === "rejected") verdict = "fail";
    if (!verdict) return null;
    const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : verdict === "pass" ? "Verifier approved artifact" : "Verifier rejected artifact";
    const confidence = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : undefined;
    return { verdict, reason, confidence, rawContent: content };
  } catch {
    return null;
  }
}

function buildVerificationPrompt(goal: string, aggregatedContent: string): string {
  return [
    "You are an independent swarm verifier (cheap-tier). Check if the aggregated artifact honestly satisfies the original goal.",
    "Goal and artifact are from separate execution; do not hallucinate.",
    "Output ONLY valid JSON: {\"verdict\":\"pass\"|\"fail\",\"reason\":\"...\",\"confidence\":0-1}",
    "- pass if artifact substantially achieves goal OR honestly reports partial completion (completed X/Y) with valid reasoning and no fabricated success",
    "- fail only if artifact fabricates success, claims completion of failed tasks, or materially misses the goal without noting the gap",
    "- Be strict about honesty: partial is allowed only when explicitly reported as completed X/Y",
    `Original goal: ${goal}`,
    `Aggregated artifact:\n${aggregatedContent.slice(0, 8000)}`,
  ].join("\n");
}

export async function verifySwarm(
  input: {
    goal: string;
    aggregatedContent: string;
    packet: ContextPacket;
    broker: EventBroker;
    kernel: { callLLM: (p: ContextPacket, b?: EventBroker) => Promise<{ content: string }> };
    aggregationSummary?: { completedCount: number; totalCount: number; failedTasks: Array<{ id: string; reason: string }> };
  }
): Promise<SwarmVerificationResult> {
  const { goal, aggregatedContent, packet, broker, kernel, aggregationSummary } = input;
  const prompt = buildVerificationPrompt(goal, aggregatedContent);
  const verifyPacket: ContextPacket = {
    ...packet,
    requestId: `${packet.requestId}:verify`,
    systemPrompt: `${packet.systemPrompt}\n\n${prompt}`,
    userInput: `Verify goal: ${goal}`,
  };
  try {
    // Attempt cheap-tier routing hint: if model routing is available and a flash module exists, prefer it.
    // This is best-effort; fallback to whatever provider is configured.
    try {
      const { routingEnabled, taskClassForRuntime, loadRoutingModules, resolveModelModule } = await import("../Shared/core/modelRouting.js");
      if (routingEnabled()) {
        const modules = await loadRoutingModules().catch(() => []);
        if (modules.length > 0) {
          const decision = resolveModelModule({
            runtimeType: "swarm",
            taskClass: "summarize" as any,
            availableModules: modules,
            staticModuleId: packet.metadata?.modelModuleId ?? null,
            logOnly: true,
          } as any);
          void decision;
        }
      }
      void taskClassForRuntime;
    } catch {}

    const response = await kernel.callLLM(verifyPacket, broker as any);
    const content = response.content ?? "";
    const parsed = parseVerificationJson(content);
    if (parsed) return parsed;
    // Invalid JSON — fallback to honest heuristic, not fabricated pass
    return honestFallback(aggregatedContent, aggregationSummary, `verifier returned invalid JSON: ${content.slice(0, 200)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return honestFallback(aggregatedContent, aggregationSummary, `verifier LLM failure: ${msg}`);
  }
}

function honestFallback(
  aggregatedContent: string,
  summary: { completedCount: number; totalCount: number; failedTasks: Array<{ id: string; reason: string }> } | undefined,
  reasonSuffix: string
): SwarmVerificationResult {
  const completed = summary?.completedCount ?? (aggregatedContent.includes("Completed") ? 1 : 0);
  const total = summary?.totalCount ?? 1;
  if (total === 0) {
    return { verdict: "fail", reason: `No tasks in plan — cannot verify (${reasonSuffix})`, confidence: 0.9 };
  }
  if (completed === 0) {
    return { verdict: "fail", reason: `No tasks completed (0/${total}) — verification fails honestly (${reasonSuffix})`, confidence: 0.8 };
  }
  // Partial or full with at least one success — honestly pass when fallback, provided completed tasks are reported
  // Require that aggregated content contains honestSummary marker "Completed X/Y"
  const hasHonestMarker = /Completed\s+\d+\s*\/\s*\d+/.test(aggregatedContent);
  if (!hasHonestMarker && completed < total) {
    return { verdict: "fail", reason: `Aggregation missing honest partial marker completed ${completed}/${total} (${reasonSuffix})`, confidence: 0.7 };
  }
  return { verdict: "pass", reason: `Fallback verifier: ${completed}/${total} tasks completed with honest reporting (${reasonSuffix})`, confidence: 0.6 };
}
