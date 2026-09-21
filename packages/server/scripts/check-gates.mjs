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
    file: join("runtime", "runtimes", "swarm-runtime.ts"),
    imports: "../../swarm/swarm-worker-resolver.js",
    note: "resolveWorker/loadWorkerCandidates are not re-exported by swarm-gate.ts",
  },
];

function isKnownViolation(file, spec) {
  const rel = file.slice(SRC.length + 1);
  return KNOWN_VIOLATIONS.some((k) => k.file === rel && k.imports === spec);
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
let knownHit = false;
const files = walk(SRC);

for (const file of files) {
  // Domain standard: tests inside a domain may import internals directly;
  // cross-domain test imports via gates are tested separately. Exempt test
  // files from this lint to avoid false positives on e2e harnesses that
  // deliberately wire real providers (e.g., Swarm e2e). See check-events
  // for the parallel exemption of test files.
  if (file.includes(".test.") || file.includes(".spec.")) continue;
  const content = readFileSync(file, "utf8");
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content))) {
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
    violations.push({
      file: file.slice(SRC.length + 1),
      imports: spec,
      shouldBe: DOMAINS[targetDomain].map((g) => `./${g}.js`).join(" | "),
    });
  }
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
if (knownHit) {
  console.warn(
    `Gate rule NOTE: ${KNOWN_VIOLATIONS.length} pre-existing violation(s) allowlisted (enforced for new code, not yet fixed):`
  );
  for (const k of KNOWN_VIOLATIONS) {
    console.warn(`  ${k.file} -> '${k.imports}' — ${k.note}`);
  }
}
