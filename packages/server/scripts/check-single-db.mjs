// SPEC 03 conformance: single shared Postgres DB + workspace_id scoping is current.
// Forbids reintroduction of per-workspace-BYODB remnants and the legacy DDL flag.
// Same dependency-free walker shape as check-redaction.mjs. Run via `npm run lint:gates`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = join(fileURLToPath(new URL(".", import.meta.url)));
const REPO = join(SCRIPTS_DIR, "..", "..", "..");

const FORBIDDEN = [
  /CROWDOS_WS_[A-Z0-9_]*_DATABASE_URL/,
  /BYODB/i,
  /\bgetWorkspaceDb\b/,
  /\bworkspaceDb\b/,
  /\brunWithDb\b/,
  /\bcreateWorkspaceDb\b/,
  /\bensureSchema\b/,
  /LEGACY_BOOTSTRAP/,
];

const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "_archive",
  "test-results",
  "playwright-report",
]);

// Self-exemptions (documented, not loopholes):
// - specs/: the program specs intentionally name every remnant being deleted.
// - this script: its FORBIDDEN source patterns would otherwise self-trigger.
// - *.bak*: SPEC 03 step-1 .env backup is deleted after the green run.
function isExempt(rel) {
  const norm = rel.replace(/\\/g, "/");
  if (norm === "packages/server/scripts/check-single-db.mjs") return true;
  if (norm === "specs/03-single-db.md" || norm.startsWith("specs/")) return true;
  if (/(^|\/)[^/]*\.bak[^/]*$/i.test(norm)) return true;
  return false;
}

const BANNER =
  "Historical: database-per-workspace was evaluated and rejected. Single shared DB + workspace_id scoping is current.";

// History docs keep their original prose (never rewritten); they pass only
// when carrying the one-line banner above.
const HISTORY = new Set(
  [
    "Workspace Flow Audit.md",
    "TO DO/AUDIT_REPORT.md",
    "AUDIT_REPORT_2026-08-26.md",
    "REMEDIATION_SPEC.md",
    "DEVELOPMENT_BOARD.md",
  ].map((p) => p.replace(/\\/g, "/")),
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

const violations = [];
const missingBanners = [];
const files = walk(REPO);

for (const file of files) {
  const rel = relative(REPO, file).replace(/\\/g, "/");
  if (isExempt(rel)) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // binary / unreadable: skip
  }
  if (content.includes("\0")) continue; // binary (e.g. *.zip): skip
  const hits = [];
  for (const re of FORBIDDEN) {
    re.lastIndex = 0;
    if (re.test(content)) hits.push(String(re));
  }
  if (hits.length === 0) continue;
  if (HISTORY.has(rel)) {
    if (content.includes(BANNER)) continue;
    missingBanners.push({ file: rel, hits });
    continue;
  }
  const lines = [];
  const rawLines = content.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    for (const re of FORBIDDEN) {
      re.lastIndex = 0;
      if (re.test(rawLines[i])) {
        lines.push(`${rel}:${i + 1}`);
        break;
      }
    }
    if (lines.length >= 5) break;
  }
  violations.push({ file: rel, hits, lines });
}

if (missingBanners.length > 0) {
  console.error("Single-DB history docs missing the required banner:");
  for (const b of missingBanners) {
    console.error(`  ${b.file} -> ${b.hits.join(", ")}`);
  }
  console.error(`Add this line to each file: > ${BANNER}`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error("Single-DB rule violations (per-workspace-BYODB remnant reintroduced):");
  for (const v of violations) {
    console.error(`  ${v.file} -> ${v.hits.join(", ")}`);
    for (const l of v.lines) console.error(`      ${l}`);
  }
  process.exit(1);
}

console.log(
  `Single-DB rule OK: scanned ${files.length} files, 0 violations.`,
);
