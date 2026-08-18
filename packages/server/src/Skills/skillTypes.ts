export interface SkillPromptLayer {
  systemPromptAdditions: string[];
  executionGuidelines: string[];
  fewShotExamples?: Array<{
    scenario: string;
    thoughtProcess: string;
    actions: Array<{ tool: string; args: Record<string, unknown> }>;
    expectedOutcome: string;
  }>;
}

export type SkillWorkflowPattern = 'react' | 'plan_execute' | 'evaluator_optimizer';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  requiredToolIds: string[];
  optionalToolIds?: string[];
  promptLayer: SkillPromptLayer;
  recommendedModels?: string[];
  workflowPattern: SkillWorkflowPattern;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  category?: string;
  icon?: string;
  requiredToolIds?: string[];
  optionalToolIds?: string[];
  promptLayer?: Partial<SkillPromptLayer>;
  recommendedModels?: string[];
  workflowPattern?: SkillWorkflowPattern;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  requiredToolIds?: string[];
  optionalToolIds?: string[];
  promptLayer?: Partial<SkillPromptLayer>;
  recommendedModels?: string[];
  workflowPattern?: SkillWorkflowPattern;
}
