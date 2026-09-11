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
import type { Thread, CreateThreadInput, UpdateThreadInput } from "./thread-types.js";

export type { Thread, CreateThreadInput, UpdateThreadInput };

export const threadGate = {
  create: createThread,
  get: getThread,
  list: listThreads,
  update: updateThread,
  delete: deleteThread,
  getMessages: getThreadMessages,
  archiveExpired: archiveExpiredThreads,
  incrementCount: incrementThreadMessageCount,
};
