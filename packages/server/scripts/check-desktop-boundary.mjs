// Electron boundary guard: keeps the future packages/desktop scaffold from
// leaking into the web client, and keeps Node/Electron main-process APIs out
// of the preload bridge surface. Run via `npm run lint:gates`.
//
// Rules:
//   (a) no file under packages/client/src or packages/client/components may
//       import from packages/desktop/main|utility or from 'electron'.
//       (The renderer must talk to desktop only through the preload bridge /
//       public contracts, never main-process code.)
//   (b) no file under packages/desktop/preload may value-import 'fs',
//       'child_process', 'shell', or 'BrowserWindow'. Type-only
//       `import type ...` is allowed (erased at compile time).
//   (c) no file outside packages/desktop may import from packages/desktop
//       except via desktopGate.ts or ipc-contracts.ts (Domain Facade Standard
//       applied to the desktop domain).
//
// Dependency-free (node:fs / node:path / node:url only). Pre-scaffold this
// exits 0 with a warning when packages/desktop does not exist yet.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const DESKTOP_DIR = join(ROOT, "packages", "desktop");
const PRELOAD_DIR = join(DESKTOP_DIR, "preload");
const CLIENT_DIRS = [
  join(ROOT, "packages", "client", "src"),
  join(ROOT, "packages", "client", "components"),
];

if (!existsSync(DESKTOP_DIR)) {
  console.warn(
    "check-desktop-boundary: packages/desktop not present — skipping (scaffold not landed yet)."
  );
  process.exit(0);
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", "coverage", ".git"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_RE.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// Static `import ... from 'x'` / `export ... from 'x'`, side-effect
// `import 'x'`, dynamic `import('x')`, and `require('x')`.
const STATIC_FROM_RE = /(import|export)[^'";]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TYPE_ONLY_RE = /^(import|export)\s+type\b/;

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

function rel(path) {
  return path.startsWith(ROOT + sep) ? path.slice(ROOT.length + 1) : path;
}

function collectSpecs(content) {
  const out = [];
  const patterns = [
    [STATIC_FROM_RE, "static"],
    [SIDE_EFFECT_RE, "side-effect"],
    [DYNAMIC_IMPORT_RE, "dynamic"],
    [REQUIRE_RE, "require"],
  ];
  for (const [re, kind] of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) {
      const spec = kind === "static" ? m[2] : m[1];
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      const statement = content.slice(lineStart, m.index + m[0].length);
      const typeOnly = kind === "static" && TYPE_ONLY_RE.test(m[0]);
      out.push({ spec, index: m.index, statement, kind, typeOnly });
    }
  }
  return out;
}

function underDir(resolved, dir) {
  return resolved === dir || resolved.startsWith(dir + sep);
}

// --- Rule (a): client must not reach desktop main|utility or electron. ---
const violationsA = [];
const clientFiles = CLIENT_DIRS.filter((d) => existsSync(d)).flatMap((d) => walk(d));
for (const file of clientFiles) {
  const content = readFileSync(file, "utf8");
  for (const { spec, index, typeOnly } of collectSpecs(content)) {
    if (typeOnly) continue; // `import type` is erased; harmless.
    let hit = false;
    if (spec === "electron" || spec.startsWith("electron/")) hit = true;
    else if (
      spec.includes("packages/desktop/main") ||
      spec.includes("packages/desktop/utility")
    )
      hit = true;
    else if (spec.startsWith(".")) {
      const resolved = normalize(join(dirname(file), spec));
      if (
        underDir(resolved, join(DESKTOP_DIR, "main")) ||
        underDir(resolved, join(DESKTOP_DIR, "utility"))
      )
        hit = true;
    }
    if (hit) violationsA.push({ file: rel(file), line: lineOf(content, index), spec });
  }
}

// --- Rule (b): preload must not value-import main-process APIs. ---
const PRELOAD_FORBIDDEN_SPEC_RE =
  /^((node:)?fs(\/|$)|(node:)?child_process(\/|$)|(node:)?shell(\/|$))/;
const violationsB = [];
const preloadFiles = existsSync(PRELOAD_DIR) ? walk(PRELOAD_DIR) : [];
for (const file of preloadFiles) {
  const content = readFileSync(file, "utf8");
  for (const entry of collectSpecs(content)) {
    const { spec, index, statement, kind, typeOnly } = entry;
    if (typeOnly) continue; // full-statement `import type` is allowed.
    if (PRELOAD_FORBIDDEN_SPEC_RE.test(spec)) {
      violationsB.push({ file: rel(file), line: lineOf(content, index), spec });
      continue;
    }
    if (spec === "electron" || spec.startsWith("electron/")) {
      // `shell` / `BrowserWindow` are main-process-only; the preload bridge
      // must not pull them in as values. Look at the import clause (static)
      // or the surrounding text (require/dynamic) for those bindings.
      const context =
        kind === "static"
          ? statement
          : content.slice(Math.max(0, index - 300), index) + statement;
      const clause = context.match(/\{([^}]*)\}/)?.[1] ?? context;
      const names = clause
        .split(",")
        .map((b) =>
          b.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim()
        );
      if (names.includes("BrowserWindow") || names.includes("shell")) {
        violationsB.push({ file: rel(file), line: lineOf(content, index), spec });
      }
    }
  }
}

// --- Rule (c): outside desktop, only the gate / contracts are importable. ---
const GATE_FILE_RE = /(^|[/\\])(desktopGate|ipc-contracts)(\.(ts|tsx|js|jsx|mjs|cjs))?$/;
const violationsC = [];
const scopeRoots = [join(ROOT, "packages"), join(ROOT, "e2e")].filter((d) =>
  existsSync(d)
);
const externalFiles = scopeRoots
  .flatMap((d) => walk(d))
  .filter((f) => !underDir(f, DESKTOP_DIR));
for (const file of externalFiles) {
  const content = readFileSync(file, "utf8");
  for (const { spec, index, typeOnly } of collectSpecs(content)) {
    if (typeOnly) continue;
    let targetsDesktop = false;
    let allowed = false;
    if (spec.includes("packages/desktop")) {
      targetsDesktop = true;
      allowed = GATE_FILE_RE.test(spec);
    } else if (spec.startsWith(".")) {
      const resolved = normalize(join(dirname(file), spec));
      if (underDir(resolved, DESKTOP_DIR)) {
        targetsDesktop = true;
        allowed = GATE_FILE_RE.test(resolved);
      }
    }
    if (targetsDesktop && !allowed) {
      violationsC.push({ file: rel(file), line: lineOf(content, index), spec });
    }
  }
}

const total = violationsA.length + violationsB.length + violationsC.length;
if (total > 0) {
  console.error("check-desktop-boundary: desktop boundary violations:");
  if (violationsA.length > 0) {
    console.error(
      "  (a) client imports Electron / desktop main|utility (renderer must use the preload bridge, not main-process code):"
    );
    for (const v of violationsA)
      console.error(`    ${v.file}:${v.line} -> '${v.spec}'`);
  }
  if (violationsB.length > 0) {
    console.error(
      "  (b) preload imports main-process API (fs | child_process | shell | BrowserWindow; `import type` only):"
    );
    for (const v of violationsB)
      console.error(`    ${v.file}:${v.line} -> '${v.spec}'`);
  }
  if (violationsC.length > 0) {
    console.error(
      "  (c) import past the desktop gate (use desktopGate.ts or ipc-contracts.ts):"
    );
    for (const v of violationsC)
      console.error(`    ${v.file}:${v.line} -> '${v.spec}'`);
  }
  process.exit(1);
}

console.log(
  `check-desktop-boundary OK: scanned ${clientFiles.length} client, ${preloadFiles.length} preload, ${externalFiles.length} external files, 0 violations.`
);
