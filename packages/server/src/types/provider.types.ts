export type ProviderEngine = "google" | "openai" | "anthropic" | "ollama" | "custom";

export interface GenerationModelProfile {
  id: string;
  label: string;
  provider: ProviderEngine;
  modelName: string;
  apiKey?: string;
  endpointUrl?: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  stopSequences: string[];
  maxRecentMessages: number;
  enableCompression: boolean;
  compressionThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmbeddingModelProfile {
  id: string;
  label: string;
  provider: ProviderEngine;
  modelName: string;
  apiKey?: string;
  endpointUrl?: string;
  dimensions: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IndexingModelProfile {
  id: string;
  label: string;
  provider: ProviderEngine;
  modelName: string;
  apiKey?: string;
  endpointUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}
