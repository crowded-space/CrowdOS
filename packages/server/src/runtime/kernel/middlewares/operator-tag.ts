/**
 * Advisory operator display tag for agent-context labels (bracket history
 * tags, roster lines). The tag rides on message `metadata.authorTag`
 * (persisted by the socket/thread transports, no schema change); rows
 * written before it existed carry no tag and fall back to "Stakeholder",
 * preserving the historic rendering. authorLevel is NEVER read here — it is
 * the authority model (§25), not a display string.
 */
export const OPERATOR_TAG_FALLBACK = "Stakeholder";
export const OPERATOR_TAG_MAX = 24;

export function userDisplayTag(m: unknown): string {
  const raw = (m as { metadata?: { authorTag?: unknown } } | null | undefined)?.metadata?.authorTag;
  const tag = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, OPERATOR_TAG_MAX) : OPERATOR_TAG_FALLBACK;
  return tag.replace(/[\[\]|]/g, "");
}
