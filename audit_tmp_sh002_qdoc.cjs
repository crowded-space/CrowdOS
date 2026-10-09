const fs = require("fs");

// Queue.md domain spec: two small edits (Flow step 4 + Current Implementation table row)
const qp = "re-docs/Backend Docs/Domain Spec/Queue.md";
let q = fs.readFileSync(qp, "utf8");

const a1 = "sanitized to known types, else Auto (\`run-worker.ts\`, \`queues.ts:9\`).";
const a2 = "sanitized to known types, else Auto (\`run-worker.ts\`, \`queues.ts:9\`); the execute call is tenant-scoped via \`runWithDb(dbForWorkspace(workspaceId ?? \"default\"))\` when a handle resolves (unscoped fallback on NO_DATABASE/unknown workspace; SH-002, 2026-10-07).";
if (!q.includes(a1)) { console.error("A1 missing"); process.exit(1); }
q = q.replace(a1, a2);

const b1 = "| \`queue/run-worker.ts\` | \`runs\` Worker: \`processRunJob\` bridge to \`runtimeGate.execute\` with progress/extendLock heartbeats |";
const b2 = "| \`queue/run-worker.ts\` | \`runs\` Worker: \`processRunJob\` bridge to \`runtimeGate.execute\` inside \`runWithDb(dbForWorkspace(ws))\` tenant scope (SH-002) with progress/extendLock heartbeats |";
if (!q.includes(b1)) { console.error("B1 missing"); process.exit(1); }
q = q.replace(b1, b2);

fs.writeFileSync(qp, q);
console.log("Queue.md done");

