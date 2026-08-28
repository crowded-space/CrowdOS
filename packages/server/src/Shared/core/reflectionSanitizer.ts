/**
 * CTX-2 reflection sanitization — strips control/zero-width/blocklike patterns
 * from self_reflection notes before persistence, and tags provenance.
 */

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060\u180E\u00AD\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Blocklike / instruction-mimicking patterns that could be injected via
// user content and later re-injected as trusted context via memory retrieval.
const BLOCKLIKE_PATTERNS: Array<[RegExp, string]> = [
  // Bracket instruction headers
  [/\[(?:SOURCE INTEGRITY|AUTHORITY LEVEL|SAFETY INVARIANTS|OPERATING INSTRUCTIONS|CHANNEL CONTEXT|IDENTITY|PERSONA GROUNDING|ACTIVE RUNTIME|From\s+@)[^\]]*\]/gi, "[blocked]"],
  // XML-like tags that could mimic our delimiters
  [/<\/?untrusted[^>]*>/gi, "[blocked untrusted tag]"],
  [/<\/?memory_previews[^>]*>/gi, "[blocked]"],
  [/<\/?current_message[^>]*>/gi, "[blocked]"],
  [/<\/?system[^>]*>/gi, "[blocked]"],
  // Code fences that could hide instruction blocks
  [/```/g, "[blocked code fence]"],
  // Lone instruction-like prefixes at line start (System:/Assistant:/User:)
  [/^\s*(System|Assistant|User)\s*:\s*/gim, "[blocked] "],
  // Attempts to close our wrapper: encoded already handled by wrapper, but strip raw
  [/\{\{.*?\}\}/g, "[blocked]"],
];

export function stripReflectionInjection(input: string): string {
  if (!input) return input;
  let out = String(input);
  out = out.replace(ZERO_WIDTH_RE, "");
  out = out.replace(CONTROL_RE, "");
  for (const [re, replacement] of BLOCKLIKE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  // Collapse excessive blocked markers
  out = out.replace(/(\[blocked[^\]]*\]\s*){3,}/g, "[blocked] ");
  return out.trim();
}

export function tagProvenance(text: string, provenance: string = "self_reflection"): string {
  const prefix = `[provenance: ${provenance}] `;
  if (text.startsWith(prefix)) return text;
  // Avoid double-tagging if already contains provenance marker
  if (text.includes("[provenance:")) return text;
  return prefix + text;
}

/**
 * Full reflection sanitization pipeline: strip + tag.
 * Used for self_reflection note fields before DB persistence.
 */
export function sanitizeReflectionField(input: string, provenance: string = "self_reflection"): string {
  const stripped = stripReflectionInjection(input);
  return tagProvenance(stripped, provenance);
}
