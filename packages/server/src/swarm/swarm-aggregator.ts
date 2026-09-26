import type { SwarmTaskRow, SwarmTaskStatus, SwarmWorkerResult, SwarmAggregationResult } from "./swarm-types.js";

const TASK_STATUSES = new Set<string>(["pending", "running", "completed", "failed", "blocked"]);

function isSwarmTaskStatus(value: string): value is SwarmTaskStatus {
  return TASK_STATUSES.has(value);
}

function dedupeAndConflicts(outputs: string[]): { dedupedLines: string[]; dedupeNotes: string[]; conflictNotes: string[] } {
  const allLines: string[] = [];
  for (const out of outputs) {
    if (!out) continue;
    allLines.push(...out.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  let dupCount = 0;
  for (const line of allLines) {
    if (seen.has(line)) {
      dupCount++;
      continue;
    }
    seen.add(line);
    deduped.push(line);
  }
  const dedupeNotes: string[] = [];
  if (dupCount > 0) dedupeNotes.push(`Deduped ${dupCount} duplicate line(s) from worker outputs.`);
  const conflictNotes: string[] = [];
  if (outputs.length > 1) {
    // Conflict heuristic on real overlap: a line present in two or more distinct
    // outputs. Counting duplicate lines instead (deduped.length < allLines.length)
    // reported "diverged" for outputs that only repeated lines within themselves.
    const distinct = [...new Set(outputs.map((o) => (o ?? "").trim()).filter(Boolean))];
    if (distinct.length > 1) {
      const lineCounts = new Map<string, number>();
      for (const out of distinct) {
        const seenInOutput = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
        for (const line of seenInOutput) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
      }
      const sharedLines = [...lineCounts.values()].filter((c) => c > 1).length;
      if (sharedLines === 0) {
        conflictNotes.push("Worker outputs diverged with no overlapping lines — manual review advised for consistency.");
      } else {
        conflictNotes.push(`Multiple worker outputs merged — ${sharedLines} line(s) shared across distinct outputs; no contradictions fabricated.`);
      }
    }
  }
  return { dedupedLines: deduped, dedupeNotes, conflictNotes };
}

export function aggregateSwarmOutputs(
  tasks: SwarmTaskRow[] | Array<{ id: string; status: string }>,
  results: Map<string, SwarmWorkerResult>
): SwarmAggregationResult {
  const totalCount = tasks.length;
  let completedCount = 0;
  const failedTasks: Array<{ id: string; reason: string }> = [];
  const blockedTasks: Array<{ id: string; reason: string }> = [];
  const perTaskSections: SwarmAggregationResult["perTaskSections"] = [];
  const successfulOutputs: string[] = [];

  for (const task of tasks) {
    const id = (task as { id: string }).id;
    const res = results.get(id);
    const rawStatus = (task as { status?: string }).status;
    const rowStatus: SwarmTaskStatus = (rawStatus && isSwarmTaskStatus(rawStatus) ? rawStatus : res?.status === "completed" ? "completed" : res?.status === "failed" ? "failed" : "pending");
    if (!res) {
      // No result — treat as failed if row says failed/blocked else pending
      const reason = (task as SwarmTaskRow).outputRef ?? "no worker result (task not dispatched)";
      // Blocked is its own bucket: pushing it into failedTasks as well made the
      // honest summary report the same task twice.
      if (rowStatus === "blocked") {
        blockedTasks.push({ id, reason });
      } else {
        failedTasks.push({ id, reason: rowStatus === "failed" ? reason : "missing worker result — treated as failed (no fabricated success)" });
      }
      perTaskSections.push({ id, status: rowStatus, output: null, error: reason });
      continue;
    }
    if (res.status === "completed") {
      completedCount++;
      const out = res.output ?? "";
      successfulOutputs.push(out);
      perTaskSections.push({ id, status: "completed", output: out, error: null });
    } else {
      const reason = res.error ?? (task as SwarmTaskRow).outputRef ?? "worker failed";
      // Blocked tasks carry a "blocked:" reason prefix (dispatcher marks them
      // failed in the result map); prefix-match, not substring — a worker output
      // mentioning the word "blocked" must not count.
      if (rowStatus === "blocked" || /^blocked:/i.test(reason.trim())) {
        blockedTasks.push({ id, reason });
        perTaskSections.push({ id, status: "blocked", output: res.output ?? null, error: reason });
      } else {
        failedTasks.push({ id, reason });
        perTaskSections.push({ id, status: "failed", output: res.output ?? null, error: reason });
      }
    }
  }

  const { dedupeNotes, conflictNotes } = dedupeAndConflicts(successfulOutputs);

  const honestSummary = `Completed ${completedCount}/${totalCount} tasks${failedTasks.length ? `; failed: ${failedTasks.map((f) => `${f.id} (${f.reason.slice(0, 80)})`).join(", ")}` : ""}${blockedTasks.length ? `; blocked: ${blockedTasks.length}` : ""}`;

  // Build mergedContent honestly: header + per-task sections, no fabricated success for failed tasks
  const header = [
    "# Swarm Aggregation",
    honestSummary,
    dedupeNotes.length ? `Dedupe: ${dedupeNotes.join(" ")}` : "",
    conflictNotes.length ? `Conflicts: ${conflictNotes.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const sections: string[] = [header, ""];
  for (const sec of perTaskSections) {
    if (sec.status === "completed") {
      sections.push(`## ${sec.id} — completed`);
      sections.push((sec.output ?? "").trim() || "(empty worker output — honestly reported)");
      sections.push("");
    } else {
      sections.push(`## ${sec.id} — failed`);
      sections.push(`Error: ${(sec.error ?? "unknown failure").trim()}`);
      if (sec.output) {
        sections.push(`Partial output: ${String(sec.output).slice(0, 1000)}`);
      }
      sections.push("");
    }
  }
  // Append consolidated deduped view if we have successful outputs
  if (successfulOutputs.length > 0) {
    const dedup = dedupeAndConflicts(successfulOutputs).dedupedLines.join("\n");
    if (dedup) {
      sections.push("---");
      sections.push("Consolidated successful outputs (deduped):");
      sections.push(dedup);
    }
  }

  const mergedContent = sections.join("\n").trim();

  return {
    mergedContent,
    completedCount,
    totalCount,
    failedTasks,
    blockedTasks,
    dedupeNotes,
    conflictNotes,
    honestSummary,
    perTaskSections,
  };
}
