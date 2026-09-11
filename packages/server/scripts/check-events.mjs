// CTX-1 event-surface truth-out guard: every BrokerEventMap key must be
// emitted, nothing may be emitted/handled that isn't part of the contract,
// and phantom handlers are forbidden. Phase-5 planned events live in an
// explicit whitelist. Run via `npm run lint:gates`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..", "src");
const CLIENT_PKG = join(HERE, "..", "..", "..", "packages", "client");
const EVENT_TYPES_TS = join(SERVER_SRC, "event-broker", "event-types.ts");

const WHITELIST_PHASE5 = new Set([
  "swarm:created",
  "swarm:updated",
  "swarm:terminated",
]);

// Socket-native / lifecycle / client->server request names that are not
// broker contract events and must never trip the phantom checks.
const NON_BROKER_SOCKET_EVENTS = new Set([
  "*",
  "connection",
  "connect",
  "connect_error",
  "reconnect",
  "reconnect_attempt",
  "reconnect_error",
  "reconnect_failed",
  "disconnect",
  "error",
  "data",
  "exit",
  "close",
  "SIGTERM",
  "SIGINT",
  "completed",
  "failed",
  "stalled",
  "channel:join",
  "workspace:join",
  "user:message",
  "user:cancel",
  "run:resume",
  "run:resume:ok",
  "run:compensations",
  "run:compensations:list",
  "run:compensation:undo",
  "approval:decide",
  "approval:list",
  "approval:list:result",
  "approval:decided",
  "proxyReqWs",
]);

function parseBrokerEventMapKeys() {
  const src = readFileSync(EVENT_TYPES_TS, "utf8");
  const block = src.match(/export interface BrokerEventMap \{([\s\S]*?)\n\}/);
  if (!block) {
    console.error("check-events: could not locate BrokerEventMap in eventTypes.ts");
    process.exit(1);
  }
  const keys = [];
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*(?:"([^"]+)"|([A-Za-z0-9_$]+))\s*\??\s*:/);
    if (m) keys.push(m[1] ?? m[2]);
  }
  return keys;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".vite" || name === "coverage") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !name.endsWith(".d.ts") &&
      !/\.(test|spec)\.(ts|tsx)$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

const EMIT_RE = /\.emit\(\s*(['"])([^'"]+)\1/g;
const ON_RE = /\.(?:on|once)\(\s*(['"])([^'"]+)\1/g;

function collectLiterals(files, regex) {
  const sites = new Map();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(content))) {
      const literal = m[2];
      if (!sites.has(literal)) sites.set(literal, []);
      sites.get(literal).push(file);
    }
  }
  return sites;
}

function rel(p) {
  return p.split("packages")[1] ?? p;
}

const brokerKeys = parseBrokerEventMapKeys();
const keySet = new Set(brokerKeys);

const serverFiles = walk(SERVER_SRC);
const clientFiles = walk(CLIENT_PKG);

const emitSites = collectLiterals([...serverFiles, ...clientFiles], EMIT_RE);
const handlerSites = collectLiterals([...serverFiles, ...clientFiles], ON_RE);
const serverEmitSites = collectLiterals(serverFiles, EMIT_RE);

const problems = [];

const definedNeverEmitted = brokerKeys.filter((k) => !emitSites.has(k));
for (const k of definedNeverEmitted) {
  if (WHITELIST_PHASE5.has(k)) continue;
  problems.push(`defined-never-emitted: "${k}" is declared in BrokerEventMap but no emitter exists`);
}

for (const [literal, files] of serverEmitSites) {
  if (keySet.has(literal)) continue;
  if (NON_BROKER_SOCKET_EVENTS.has(literal)) continue;
  problems.push(
    `emitted-undeclared: server emits "${literal}" (${rel(files[0])}) but it is not in BrokerEventMap`,
  );
}

for (const [literal, files] of handlerSites) {
  if (emitSites.has(literal)) continue;
  if (keySet.has(literal) && WHITELIST_PHASE5.has(literal)) continue;
  if (NON_BROKER_SOCKET_EVENTS.has(literal)) continue;
  problems.push(
    `handled-never-emitted: "${literal}" has a handler (${rel(files[0])}) but nothing emits it`,
  );
}

if (problems.length > 0) {
  console.error(`check-events: ${problems.length} event-surface violation(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `check-events OK: ${brokerKeys.length} declared events, ${emitSites.size} emitted literals, ` +
    `${handlerSites.size} handler literals, whitelist [${[...WHITELIST_PHASE5].join(", ")}], 0 violations.`,
);
