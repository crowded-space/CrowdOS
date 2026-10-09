import {
  createThread,
  getThread,
  listThreads,
  updateThread,
  deleteThread,
  getThreadMessages,
  archiveExpiredThreads,
  incrementThreadMessageCount,
} from "./thread-service.js";
import { allocateThreadSequence } from "./thread-sequence-allocator.js";
import type { Thread, CreateThreadInput, UpdateThreadInput, threadCallContext } from "./thread-types.js";

export type { Thread, CreateThreadInput, UpdateThreadInput, threadCallContext };

export const threadGate = {
  create: createThread,
  get: getThread,
  list: listThreads,
  update: updateThread,
  delete: deleteThread,
  getMessages: getThreadMessages,
  archiveExpired: archiveExpiredThreads,
  incrementCount: incrementThreadMessageCount,
  // THR-016: thread_sequences has ONE owner — Threads. The Messages append
  // path calls this port with its tx instead of importing a shared allocator.
  allocateSequence: allocateThreadSequence,
};
