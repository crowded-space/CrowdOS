// Dependency-free guard that enforces the Domain Facade Standard:
// "Nothing outside ./[Domain]/ may import from any file in that folder
// except [domain]Gate.ts." Run via `npm run lint:gates`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";

const SRC = join(process.cwd(), "src");

// AGENTS.md §1 names gate files kebab-case + "-gate.ts" (e.g. "agent-gate.ts").
// The previous pattern (^[a-z][A-Za-z0-9]*Gate\.ts$) could not match a single
// real gate file, so discoverDomains() always returned {} and this script
// scanned 0 domains and reported success unconditionally. Fixed here.
const GATE_RE = /^[a-z][A-Za-z0-9-]*[Gg]ate\.ts$/;

// AGENTS.md §2: "Shared/, lib/, config/ exempt" — these folders may reach
// domain internals. They are not gated domains themselves.
const EXEMPT_IMPORTERS = ["shared", "lib", "config"];

// Pre-existing violations that predate the GATE_RE fix above. They live in
// domains this task does not own; listed here so the rule is enforced for all
// NEW code without silently swallowing the old debt. Remove an entry only by
// fixing the import (route it through that domain's gate).
const KNOWN_VIOLATIONS = [
  {
    file: "create-app.ts",
    imports: "./approvals/approval-sweeper.js",
    note: "gate->sweeper->gate cycle blocks a plain re-export; needs an approvals-owned restructure",
  },
  {
    file: "worker.ts",
    imports: "./approvals/approval-sweeper.js",
    note: "TODO(approvals): sweeper entry must be re-exported from approvals-gate.js (dynamic imports are now checked)",
  },
];

function isKnownViolation(file, spec) {
  // Compare slash-normalized paths so entries are portable across OSes.
  const rel = file.slice(SRC.length + 1).split(sep).join("/");
  return KNOWN_VIOLATIONS.some(
    (k) => k.file.split(sep).join("/") === rel && k.imports === spec,
  );
}

// Domains are derived dynamically: any top-level src folder containing at
// least one [x]Gate.ts file is a gated domain. Folders without a gate
// (Shared, types, db, routes, core, adapters) have no declared boundary and
// their internals stay freely importable until a gate is introduced.
function discoverDomains() {
  const domains = {};
  for (const name of readdirSync(SRC)) {
    const dir = join(SRC, name);
    if (!statSync(dir).isDirectory()) continue;
    const gates = readdirSync(dir).filter((f) => GATE_RE.test(f));
    if (gates.length > 0) domains[name] = gates.map((g) => g.replace(/\.ts$/, ""));
  }
  return domains;
}

const DOMAINS = discoverDomains();

// Gate stems additionally accepted as entry points (public surface not yet
// re-exported through a gate).
const EXTRA_ALLOWED = {
  runtime: ["types"],
};

const IMPORT_RE = /(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]/g;
// Dynamic `import("./internal.js")` is the same rule as a static import —
// it just hides from IMPORT_RE. Without this the gate rule was trivially
// bypassed (routes/workspace.ts pulled agent internals until this task).
const DYN_IMPORT_RE = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function domainOf(path) {
  for (const folder of Object.keys(DOMAINS)) {
    if (path.startsWith(join(SRC, folder) + sep)) return folder;
  }
  return null;
}

function isEntryOf(domain, target) {
  const stems = [...DOMAINS[domain], ...(EXTRA_ALLOWED[domain] ?? [])];
  return stems.some((stem) => target.endsWith(sep + stem + ".js") || target.endsWith(sep + stem + ".ts"));
}

const violations = [];
// Cross-domain test imports are violations of AGENTS.md §2 too, but they are
// e2e harnesses wiring real providers; reported non-fatally (see below).
const testViolations = [];
let knownHit = false;
const files = walk(SRC);

function scanRegex(content, file, re, sink) {
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(content))) {
    const spec = m[1];
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    if (!/\.(js|ts)$/.test(spec)) continue;
    const target = normalize(join(dirname(file), spec));
    const targetDomain = domainOf(target);
    if (!targetDomain) continue; // not inside a gated domain
    const importingDomain = domainOf(file);
    if (importingDomain === targetDomain) continue; // internal imports allowed
    // AGENTS.md §2 exempts Shared/, lib/, config/ from the gate rule.
    if (importingDomain === null) {
      const top = file.slice(SRC.length + 1).split(sep)[0];
      if (EXEMPT_IMPORTERS.includes(top)) continue;
    }
    if (isEntryOf(targetDomain, target)) continue;
    if (isKnownViolation(file, spec)) {
      knownHit = true;
      continue;
    }
    sink.push({
      file: file.slice(SRC.length + 1),
      imports: spec,
      shouldBe: DOMAINS[targetDomain].map((g) => `./${g}.js`).join(" | "),
    });
  }
}

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const isTest = file.includes(".test.") || file.includes(".spec.");
  const sink = isTest ? testViolations : violations;
  scanRegex(content, file, IMPORT_RE, sink);
  scanRegex(content, file, DYN_IMPORT_RE, sink);
}

if (violations.length > 0) {
  console.error("Gate rule violations (import past a domain gate):");
  for (const v of violations) {
    console.error(`  ${v.file} -> '${v.imports}' (use '${v.shouldBe}')`);
  }
  process.exit(1);
}

console.log(
  `Gate rule OK: scanned ${files.length} files across ${Object.keys(DOMAINS).length} domains (${Object.keys(DOMAINS).join(", ")}), 0 violations.`
);
if (testViolations.length > 0) {
  console.warn(
    `Gate rule TEST-ONLY findings (non-fatal, ${testViolations.length}): cross-domain tests import past gates — route via the gate when touching the file:`
  );
  for (const v of testViolations) {
    console.warn(`  ${v.file} -> '${v.imports}' (use '${v.shouldBe}')`);
  }
}
if (knownHit) {
  console.warn(
    `Gate rule NOTE: ${KNOWN_VIOLATIONS.length} pre-existing violation(s) allowlisted (enforced for new code, not yet fixed):`
  );
  for (const k of KNOWN_VIOLATIONS) {
    console.warn(`  ${k.file} -> '${k.imports}' — ${k.note}`);
  }
}
