export type ArtifactType = "reasoning_trace" | "execution_log" | "analysis_report" | "generated_component" | "task_result" | "runtime_snapshot" | "file" | "diff" | "report" | "citations";

export interface CreateArtifactInput {
  runId?: string | null;
  workspaceId: string;
  producerAgent: string;
  type: ArtifactType;
  path?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  patch?: string | null;
  contentRef?: string | null;
  semanticTags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ArtifactRow {
  id: string;
  workspaceId: string;
  producerAgent: string;
  artifactType: ArtifactType;
  path: string | null;
  semanticTags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  runId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  patch: string | null;
  contentRef: string | null;
}
