import {
  resolveAgentId,
  generateNoteId,
  createMemoryNote,
  readMemoryNote,
  listMemoryPreviews,
  updateMemoryNote,
  archiveMemoryNote,
  suppressMemoryNote,
} from "./agent-memory-store.js";
import { retrieveMemoryCandidates, buildMemoryPreviewBlock } from "./memory-retrieval.js";
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
  type MemoryWorkspaceOpts,
} from "./memory-lifecycle.js";
import { memorySessionDiscards } from "./memory-session-discards.js";
import { reflectionThrottle, jaccardSimilarity, normalizeHookTokens } from "./memory-reflection-throttle.js";
import { embedText, embedNote, embedNotesBatch, ensureEmbeddingsForAgent, searchByEmbedding, mockEmbed, cosineSimilarity } from "./embeddings.js";
import { mirrorMemoryNote, readLocalMemoryNotes, scoreLocalNote } from "./memory-local-store.js";

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
export { mirrorMemoryNote, readLocalMemoryNotes, scoreLocalNote };

export type {
  MemoryUpdateAction,
  MemoryUpdateLogInput,
  MemoryWorkspaceOpts,
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
} from "./agent-memory-store.js";
export type { MemoryCandidate, RetrievalInput } from "./memory-retrieval.js";

export const memoriesGate = {
  resolveAgentId,
  generateNoteId,
  createMemoryNote,
  readMemoryNote,
  listMemoryPreviews,
  updateMemoryNote,
  archiveMemoryNote,
  suppressMemoryNote,
  // MEM-004: logMemoryUpdate was flat-only; gate object carries it now.
  logMemoryUpdate,
  retrieveMemoryCandidates,
  buildMemoryPreviewBlock,
  mirrorMemoryNote,
  readLocalMemoryNotes,
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
