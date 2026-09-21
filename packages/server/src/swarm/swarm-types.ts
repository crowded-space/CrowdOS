export type SwarmTaskStatus = "pending" | "running" | "completed" | "failed" | "blocked";

export interface SwarmPlanTask {
  id: string;
  dependsOn: string[];
  assigneeTemplate: string;
  goal?: string;
  description?: string;
}

export interface SwarmPlan {
  tasks: SwarmPlanTask[];
  fallbackUsed?: boolean;
  rawPlanText?: string | null;
  fallbackReason?: string | null;
}

export interface SwarmTaskRow {
  id: string;
  runId: string;
  dependsOn: string[];
  assigneeTemplate: string;
  status: SwarmTaskStatus;
  outputRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SwarmWorkerResult {
  taskId: string;
  status: "completed" | "failed";
  output?: string | null;
  error?: string | null;
  durationMs?: number;
}

export interface SwarmAggregationResult {
  mergedContent: string;
  completedCount: number;
  totalCount: number;
  failedTasks: Array<{ id: string; reason: string }>;
  blockedTasks: Array<{ id: string; reason: string }>;
  dedupeNotes: string[];
  conflictNotes: string[];
  honestSummary: string;
  perTaskSections: Array<{ id: string; status: SwarmTaskStatus; output: string | null; error: string | null }>;
}

export interface SwarmVerificationResult {
  verdict: "pass" | "fail";
  reason: string;
  confidence?: number;
  rawContent?: string | null;
  /** Tokens spent producing this verdict (§23: budget must see real numbers). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface SwarmReport {
  plan: SwarmPlan;
  tasks: SwarmTaskRow[];
  aggregation: SwarmAggregationResult;
  verification: SwarmVerificationResult;
  finalStatus: "completed" | "failed";
  swarmRunId: string;
  honestSummary: string;
}

export function isSwarmV1Enabled(): boolean {
  return process.env.SWARM_V1 === "true";
}
