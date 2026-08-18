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
};
