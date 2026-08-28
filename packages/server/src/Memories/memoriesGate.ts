import {
  resolveAgentId,
  generateNoteId,
  createMemoryNote,
  readMemoryNote,
  listMemoryPreviews,
  updateMemoryNote,
  archiveMemoryNote,
  suppressMemoryNote,
} from "./agentMemoryStore.js";
import { retrieveMemoryCandidates, buildMemoryPreviewBlock } from "./memoryRetrieval.js";
import {
  logMemoryUpdate,
  runSuppressionSweep,
  enforceNoteCap,
  enforceCapsAllAgents,
  startMemorySweeper,
  softSuppressNote,
  discardNoteFromContext,
  getNoteCap,
  isSuppressionActive,
  type MemoryUpdateAction,
  type MemoryUpdateLogInput,
} from "./memoryLifecycle.js";
import { memorySessionDiscards } from "./memorySessionDiscards.js";
import { reflectionThrottle, jaccardSimilarity, normalizeHookTokens } from "./memoryReflectionThrottle.js";
import { embedText, embedNote, embedNotesBatch, ensureEmbeddingsForAgent, searchByEmbedding, mockEmbed, cosineSimilarity } from "./embeddings.js";

export {
  resolveAgentId,
  generateNoteId,
  createMemoryNote,
  readMemoryNote,
  listMemoryPreviews,
  updateMemoryNote,
  archiveMemoryNote,
  suppressMemoryNote,
};
export { retrieveMemoryCandidates, buildMemoryPreviewBlock };
export {
  runSuppressionSweep as runMemorySweep,
  enforceNoteCap,
  enforceCapsAllAgents,
  startMemorySweeper,
  softSuppressNote,
  discardNoteFromContext,
  getNoteCap,
  isSuppressionActive,
  logMemoryUpdate,
};
export { memorySessionDiscards };
export { reflectionThrottle, jaccardSimilarity, normalizeHookTokens };

export type {
  MemoryUpdateAction,
  MemoryUpdateLogInput,
};

export type {
  MemoryNoteType,
  MemoryConfidence,
  MemorySourceType,
  MemoryValence,
  MemoryLifecycleStatus,
  MemoryNotePreview,
  MemoryNoteFull,
  CreateMemoryNoteInput,
  UpdateMemoryNotePatch,
  MemoryListFilter,
  MemoryStoreError,
  MemoryStoreResult,
} from "./agentMemoryStore.js";
export type { MemoryCandidate, RetrievalInput } from "./memoryRetrieval.js";

export const memoriesGate = {
  resolveAgentId,
  generateNoteId,
  createMemoryNote,
  readMemoryNote,
  listMemoryPreviews,
  updateMemoryNote,
  archiveMemoryNote,
  suppressMemoryNote,
  retrieveMemoryCandidates,
  buildMemoryPreviewBlock,
  runMemorySweep: runSuppressionSweep,
  enforceNoteCap,
  enforceCapsAllAgents,
  startMemorySweeper,
  softSuppressNote,
  discardFromContext: discardNoteFromContext,
  getNoteCap,
  isSuppressionActive,
  sessionDiscards: memorySessionDiscards,
  reflectionThrottle,
  jaccardSimilarity,
  normalizeHookTokens,
  embedText,
  embedNote,
  embedNotesBatch,
  ensureEmbeddingsForAgent,
  searchByEmbedding,
  mockEmbed,
  cosineSimilarity,
};
