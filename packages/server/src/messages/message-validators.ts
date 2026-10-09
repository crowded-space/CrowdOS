import { z } from "zod";

// MSG-013: single ceiling shared by the service clamp and the route validator.
// Lives here (not the service) so the schema can derive from it without a
// circular import; the service re-exports it for existing importers.
export const MAX_PAGE_LIMIT = 200;

export const getMessagesParamsSchema = z.object({
  channelId: z.string().min(1),
});

export const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  before: z.string().min(1).optional(),
});

export type GetMessagesParams = z.infer<typeof getMessagesParamsSchema>;
export type GetMessagesQuery = z.infer<typeof getMessagesQuerySchema>;

// MSG-012: gate-level input validation. The socket path destructured content
// without checking it, so undefined content wrote a local row with no content
// key and produced a permanently failing PG replica entry (NOT NULL violation).
// Identity fields must be non-empty strings; authorType is the closed author
// enum. `content` is TYPE-checked only (string) — the reported defect is
// undefined content, and rejecting empty strings would change runtime behavior
// (conversational/agentic runtimes legitimately persist empty LLM responses).
// Optional fields (mentions, metadata, toolCalls, isInternalMonologue,
// threadId, workspaceId, id) stay permissive — this schema only asserts the
// fields every writer must supply.
export const appendMessageInputSchema = z.object({
  channelId: z.string().trim().min(1),
  authorId: z.string().trim().min(1),
  authorName: z.string().trim().min(1),
  authorType: z.enum(["user", "agent", "system"]),
  content: z.string(),
});
