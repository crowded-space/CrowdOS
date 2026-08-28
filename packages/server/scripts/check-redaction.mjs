// Dependency-free guard for SEC-4 log redaction: every console.log/warn/error
// call in src/** that references credential-shaped identifiers must route its
// payload through a shared redaction helper (redactSecrets / redactLogPayload /
// redactApiKeyFields / stripSensitiveHeaders). AST-lite scanner in the style of
// check-gates.mjs. Run via `npm run lint:gates`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

const CONSOLE_CALL_RE = /console\s*\.\s*(?:log|warn|error)\s*\(/g;

// No leading word-boundary: catches camelCase-composed names too
// (e.g. `leakedApiKey`). Trailing \b keeps prose words like "tokenize" clean.
const CREDENTIAL_IDENTIFIER_RE = /(?:api[_-]?key|apikey|envvars?|password|passwd|secret|tokens?|credentials?|keyhash)\b/i;

const REDACTOR_RE = /\b(?:redactSecrets|redactLogPayload|redactApiKeyFields|stripSensitiveHeaders)\s*\(/;

// Precise exemptions. Two shapes:
//   marker  — violation is skipped when the call text contains this exact string
//   block   — violations inside the function/block introduced by this declaration
//             (up to the next "\n}") are skipped
const ALLOWLIST = [
  {
    file: "Shared/auth/apiKeyService.ts",
    block: "export async function seedBootstrapAdminKey",
    reason: "SEC-1 one-time bootstrap admin key emission to stdout is intentionally raw",
  },
  {
    file: "runtime/RuntimeExecutor.ts",
    marker: "Failed to record token usage:",
    reason: "logs only an error object; message text mentions token usage bookkeeping",
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// Balanced-paren scanner aware of strings, template literals (incl. ${}
// interpolation), and comments. Returns index of the matching close paren.
function matchParen(code, openIdx) {
  const stack = [];
  let i = openIdx;
  let parenDepth = 0;
  while (i < code.length) {
    const ch = code[i];
    const mode = stack[stack.length - 1] ?? "code";
    if (mode === "line-comment") {
      if (ch === "\n") stack.pop();
      i++;
      continue;
    }
    if (mode === "block-comment") {
      if (ch === "*" && code[i + 1] === "/") { stack.pop(); i += 2; continue; }
      i++;
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      if (ch === "\\") { i += 2; continue; }
      if ((mode === "sq" && ch === "'") || (mode === "dq" && ch === '"')) stack.pop();
      i++;
      continue;
    }
    if (mode === "tpl") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { stack.pop(); i++; continue; }
      if (ch === "$" && code[i + 1] === "{") { stack.push("interp"); parenDepth++; i += 2; continue; }
      i++;
      continue;
    }
    if (mode === "interp") {
      if (ch === "'" || ch === '"' || ch === "`") { stack.push(ch === "'" ? "sq" : ch === '"' ? "dq" : "tpl"); i++; continue; }
      if (ch === "{") { parenDepth++; i++; continue; }
      if (ch === "}") { parenDepth--; if (parenDepth === 0) { stack.pop(); } i++; continue; }
      if (ch === "(") return -1; // nested call inside interpolation: bail conservatively
      i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") { stack.push("line-comment"); i += 2; continue; }
    if (ch === "/" && code[i + 1] === "*") { stack.push("block-comment"); i += 2; continue; }
    if (ch === "'") { stack.push("sq"); i++; continue; }
    if (ch === '"') { stack.push("dq"); i++; continue; }
    if (ch === "`") { stack.push("tpl"); i++; continue; }
    if (ch === "(") { parenDepth++; i++; continue; }
    if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

function lineOf(code, pos) {
  return code.slice(0, pos).split("\n").length;
}

const violations = [];
const files = walk(SRC);

for (const file of files) {
  const relFile = file.slice(SRC.length + 1).replace(/\\/g, "/");
  const content = readFileSync(file, "utf8");
  CONSOLE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = CONSOLE_CALL_RE.exec(content))) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchParen(content, openIdx);
    if (closeIdx === -1) continue;
    const text = content.slice(m.index, closeIdx + 1);
    if (!CREDENTIAL_IDENTIFIER_RE.test(text)) continue;
    if (REDACTOR_RE.test(text)) continue;

    const entry = ALLOWLIST.find((a) => a.file === relFile);
    if (entry) {
      if (entry.marker && text.includes(entry.marker)) continue;
      if (entry.block) {
        const declIdx = content.indexOf(entry.block);
        if (declIdx !== -1) {
          const blockEnd = content.indexOf("\n}", declIdx);
          if (m.index > declIdx && (blockEnd === -1 || m.index < blockEnd)) continue;
        }
      }
    }

    violations.push({ file: relFile, line: lineOf(content, m.index), snippet: text.replace(/\s+/g, " ").slice(0, 140) });
  }
}

if (violations.length > 0) {
  console.error("Redaction rule violations (raw console logging near credential identifiers):");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} -> ${v.snippet}`);
  }
  process.exit(1);
}

console.log(`Redaction rule OK: scanned ${files.length} files for unredacted console logging of credential data, 0 violations.`);
