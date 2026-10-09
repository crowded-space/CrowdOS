import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "packages/server/src";
const DOMAINS = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());

const edges = new Map();
const addEdge = (from, to, file) => {
  const k = from + " -> " + to;
  if (!edges.has(k)) edges.set(k, []);
  edges.get(k).push(file);
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

for (const file of walk(SRC)) {
  const rel = file.slice(SRC.length + 1).replaceAll("\\", "/");
  const fromDomain = rel.split("/")[0];
  let content = readFileSync(file, "utf8");
  // strip type-only import statements (import type {...} from "...";)
  content = content.replace(/import\s+type\s+[^;]*?;/g, "");
  // strip dynamic import types? keep value imports
  const re = /from\s+["']((?:\.\.\/)+)([^/"']+)\//g;
  let m;
  while ((m = re.exec(content))) {
    const toDomain = m[2];
    if (DOMAINS.includes(toDomain) && toDomain !== fromDomain) {
      addEdge(fromDomain, toDomain, rel);
    }
  }
}

console.log("=== VALUE-DEPENDENCY EDGES BETWEEN TOP-LEVEL DOMAINS (tests excluded, type-only imports stripped) ===");
for (const k of [...edges.keys()].sort()) {
  const files = edges.get(k);
  console.log(k.padEnd(48), "files:" + files.length, "|", files.slice(0, 4).join(", "));
}

// Detect 2-cycles
console.log("\n=== 2-CYCLES ===");
for (const k of [...edges.keys()].sort()) {
  const [a, b] = k.split(" -> ");
  const rev = b + " -> " + a;
  if (edges.has(rev) && a < b) {
    console.log("CYCLE:", a, "<->", b, "| forward:", edges.get(k).join(","), "| reverse:", edges.get(rev).join(","));
  }
}
