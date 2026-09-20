import type { InteractionMode, InterpreterOutput } from "./types.js";

// §24 keyword sets — deliberately lexical, never semantic. The Interpreter
// stabilizes (targets/mode/hints); it never plans, picks tools, or reads memory.
const CODING_RE =
  /\b(code|coding|debug|refactor|implement|bugfix|stack trace|traceback|compile|function|class|repo|pull request|\bdiff\b)\b/i;
const RESEARCH_RE =
  /\b(research|survey|literature|paper|compare|analysis|investigate|evidence|sources|cite)\b/i;
const LOCK_RE = /\block[\s_-]?in\b/i;
const MENTION_RE = /@([A-Za-z0-9_][A-Za-z0-9_\-.]{0,63})/g;

const MODES: ReadonlySet<string> = new Set(["chat", "agentic", "coding", "research"]);

function normalizeMode(explicit?: string): InteractionMode | "auto" {
  const raw = (explicit ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  // Composer 'conversational' is the UI name for chat mode (§6).
  const mapped = raw === "conversational" ? "chat" : raw;
  if (MODES.has(mapped)) return mapped as InteractionMode;
  return "auto";
}

export function interpret(input: {
  content: string;
  explicitRuntime?: string;
}): InterpreterOutput {
  const content = input?.content ?? "";

  // Interaction targets: raw @-tokens only. Resolution (typo-fix, role,
  // id/name match) stays in MentionParser/dispatch — never here.
  const targets: string[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(content)) !== null) {
    const token = m[1];
    if (token && !targets.includes(token)) targets.push(token);
  }

  // Communication mode: an explicit runtime is stabilized, not decided.
  // Otherwise fall back to lexical hints; 'auto' means "router decides".
  let mode = normalizeMode(input?.explicitRuntime);
  if (mode === "auto") {
    if (CODING_RE.test(content)) mode = "coding";
    else if (RESEARCH_RE.test(content)) mode = "research";
  }

  const executionHints: string[] = [];
  if (targets.length > 1) executionHints.push("multi-target");
  if (LOCK_RE.test(content)) executionHints.push("lock_in-requested");
  if (/```/.test(content) || CODING_RE.test(content)) executionHints.push("code-context");

  const ambiguous = targets.length === 0 && mode === "auto";
  const assumptions: string[] = [];
  if (ambiguous) {
    // Refused assumption, listed — never silently made (§24).
    assumptions.push("no explicit target or mode; defer to channel default agent and Auto routing");
  }

  return { targets, mode, executionHints, ambiguous, assumptions };
}
