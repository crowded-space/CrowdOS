export type SpawnFailurePolicy = "retry" | "escalate";
export type SpawnStatus = "pending" | "in_progress" | "completed" | "failed";
export type TaskPriority = "high" | "medium" | "low";

export interface SubtaskDefinition {
  id: string;
  title: string;
  instructions: string;
  priority: TaskPriority;
}

export interface SpawnRequest {
  id: string;
  requestedBy: string;
  channelId: string;
  workerTemplateId: string;
  supervisorTemplateId: string;
  subtasks: SubtaskDefinition[];
  failurePolicy: SpawnFailurePolicy;
  maxRetries: number;
  status: SpawnStatus;
  createdAt: Date;
}

export interface TaskFile {
  id: string;
  spawnRequestId: string;
  subtaskId: string;
  title: string;
  content: string;
  workerAgentId: string;
  supervisorAgentId: string;
  status: SpawnStatus;
  createdAt: Date;
}

export interface ScheduledTask {
  id: string;
  cronExpression: string;
  channelId: string;
  targetAgentId: string;
  taskPayload: Record<string, unknown>;
  isActive: boolean;
  nextRun?: Date;
  createdAt: Date;
}
