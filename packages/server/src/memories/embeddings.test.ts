import { describe, it, expect, beforeEach } from "vitest";
import { mockEmbed, cosineSimilarity, hybridScore } from "./embeddings.js";
import { observabilityGate } from "../observability/observability-gate.js";

describe("SCL-2 semantic memory — embeddings", () => {
  beforeEach(() => {
    observabilityGate.clearTracesForTests();
  });

  it("mockEmbed is deterministic and normalized", async () => {
    const v1 = mockEmbed("hello world", 16);
    const v2 = mockEmbed("hello world", 16);
    expect(v1).toEqual(v2);
    const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("cosineSimilarity: identical vectors ~1, orthogonal ~0, opposite ~-1", async () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    const c = [0, 1, 0];
    const d = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 5);
    expect(cosineSimilarity(a, d)).toBeCloseTo(-1, 5);
  });

  it("hybridScore blends heuristic and semantic", async () => {
    const query = mockEmbed("auth middleware", 16);
    const noteA = mockEmbed("auth middleware handles tokens", 16);
    const noteB = mockEmbed("cooking recipes", 16);
    const candidates = [
      { id: "a", heuristicScore: 0.6, embedding: JSON.stringify(noteA) },
      { id: "b", heuristicScore: 0.6, embedding: JSON.stringify(noteB) },
    ];
    const scores = hybridScore({ queryEmbedding: query, candidates, weight: 0.5 });
    expect(scores.get("a")! > scores.get("b")!).toBe(true);
  });

  it("recall@10 beats heuristic-only on synthetic eval set", async () => {
    // Synthetic eval: 20 docs, 5 relevant to query "authentication"
    // Heuristic scores random, semantic scores correlated via mockEmbed
    const query = mockEmbed("authentication token validation", 32);
    const docs = Array.from({ length: 20 }, (_, i) => {
      const isRelevant = i < 5;
      const text = isRelevant ? `authentication token validation ${i}` : `cooking recipe ${i} pasta`;
      return {
        id: `doc-${i}`,
        heuristicScore: Math.random() * 0.4 + 0.3, // overlapping range
        embedding: JSON.stringify(mockEmbed(text, 32)),
        isRelevant,
      };
    });
    // Heuristic-only ranking
    const heuristicSorted = [...docs].sort((a, b) => b.heuristicScore - a.heuristicScore).slice(0, 10);
    const heuristicRecall = heuristicSorted.filter((d) => d.isRelevant).length / 5;

    // Hybrid ranking
    const hybridScores = hybridScore({
      queryEmbedding: query,
      candidates: docs.map((d) => ({ id: d.id, heuristicScore: d.heuristicScore, embedding: d.embedding })),
      weight: 0.5,
    });
    const hybridSorted = [...docs].sort((a, b) => hybridScores.get(b.id)! - hybridScores.get(a.id)!).slice(0, 10);
    const hybridRecall = hybridSorted.filter((d) => d.isRelevant).length / 5;

    // Hybrid should beat or equal heuristic on this synthetic set due to semantic signal
    expect(hybridRecall).toBeGreaterThanOrEqual(heuristicRecall);
    // And at least 0.6 recall (3/5) with semantic help
    expect(hybridRecall).toBeGreaterThanOrEqual(0.6);
  });
});
