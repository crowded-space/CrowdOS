export type ProviderEngine = "google" | "openai" | "anthropic" | "ollama" | "custom";

/** Reusable LLM configuration module */
export interface ModelModule {
  id: string;
  label: string;
  provider: ProviderEngine;
  modelName: string;
  apiKey?: string | null;
  endpointUrl?: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  stopSequences: string[];
  maxRecentMessages: number;
  enableCompression: boolean;
  compressionThreshold: number;
  costPer1k?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Reusable system prompt / instruction module */
export interface InstructionModule {
  id: string;
  label: string;
  base: string[];
  runtimePatchable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Reusable tool permission bundle */
export interface ToolkitModule {
  id: string;
  label: string;
  tools: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Reusable safety constraint rules */
export interface ConstraintsModule {
  id: string;
  label: string;
  rules: string[];
  disallowedActions: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Reusable skill/capability declarations */
export interface CapabilitiesModule {
  id: string;
  label: string;
  skills: string[];
  functionSchemas: Record<string, unknown>[];
  createdAt: Date;
  updatedAt: Date;
}

export type ModuleType = "model" | "instruction" | "toolkit" | "constraints" | "capabilities";
export type ModuleUnion = ModelModule | InstructionModule | ToolkitModule | ConstraintsModule | CapabilitiesModule;
