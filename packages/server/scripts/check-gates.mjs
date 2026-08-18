// Dependency-free guard that enforces the Domain Facade Standard:
// "Nothing outside ./[Domain]/ may import from any file in that folder
// except [domain]Gate.ts." Run via `npm run lint:gates`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";

const SRC = join(process.cwd(), "src");

// domain folder name -> gate filename (relative import target)
const DOMAINS = {
  Agents: "agentGate.js",
  Modules: "moduleGate.js",
  Channels: "channelGate.js",
  Messages: "messageGate.js",
  Memories: "memoriesGate.js",
  Workspace: "workspaceGate.js",
  EventBroker: "eventBrokerGate.js",
  tools: "toolsGate.js",
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

const violations = [];
const files = walk(SRC);

for (const file of files) {
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
    const gate = DOMAINS[targetDomain];
    if (!target.endsWith(sep + gate)) {
      violations.push({
        file: file.slice(SRC.length + 1),
        imports: spec,
        shouldBe: `./${gate}`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Gate rule violations (import past a domain gate):");
  for (const v of violations) {
    console.error(`  ${v.file} -> '${v.imports}' (use '${v.shouldBe}')`);
  }
  process.exit(1);
}

console.log(`Gate rule OK: scanned ${files.length} files, 0 violations.`);
