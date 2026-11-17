// UI audit §2.15: /api/search was PG-only — without DATABASE_URL the route
// answered an unhandled 500 (getDb() throws before any try/catch), and with
// an unreachable tenant DB the drizzle fallback failed the same way, so
// OmniSearch message history silently covered only the client's in-memory
// open-channel rows. The local workspace message logs are the truth tier
// (§17), so the route must degrade to them instead of 500ing.
//
// Hermetic: real route + real gate, local tier via a temp store dir, env
// singleton unset so any unbound getDb() fails fast.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { setLocalStoreDirForTests, appendJsonl } from "../shared/core/local-file.js";
import { env } from "../shared/config/env.js";
import { validatorCompiler } from "../shared/core/validation.js";
import { searchRoutes } from "./search.js";

const prevDatabaseUrl = env.DATABASE_URL;
(env as any).DATABASE_URL = undefined;
afterAll(() => {
  (env as any).DATABASE_URL = prevDatabaseUrl;
});

const WS_A = "ws-search-a";
const WS_B = "ws-search-b";

let dir: string;

function row(opts: {
  id: string;
  channelId: string;
  workspaceId: string;
  content: string;
  authorName: string;
  isInternalMonologue?: boolean;
  timestamp: string;
  sequenceNumber: number;
}) {
  return {
    id: opts.id,
    channelId: opts.channelId,
    threadId: null,
    workspaceId: opts.workspaceId,
    authorId: `author-${opts.authorName}`,
    authorName: opts.authorName,
    authorLevel: "1",
    authorType: "user",
    content: opts.content,
    mentions: [],
    metadata: null,
    toolCalls: null,
    isInternalMonologue: opts.isInternalMonologue ?? false,
    sequenceNumber: opts.sequenceNumber,
    timestamp: opts.timestamp,
  };
}

async function makeApp(db?: any) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  // Test-local tenant wiring (the real hook lives in create-app.ts): pin the
  // workspace scope so the route resolves the local tier; leave request.db
  // unset for the local-mode case.
  app.addHook("onRequest", async (request) => {
    (request as any).workspaceId = WS_A;
    if (db) (request as any).db = db;
  });
  await searchRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crowdos-search-"));
  setLocalStoreDirForTests(dir);
  return () => {
    setLocalStoreDirForTests(null);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe("GET /api/search local-tier fallback", () => {
  it("answers 200 from the workspace message logs when no database is configured", async () => {
    await appendJsonl("ch-alpha", row({
      id: "m-1", channelId: "ch-alpha", workspaceId: WS_A,
      content: "Connection check completed", authorName: "Ridder",
      timestamp: "2026-01-01T00:00:01.000Z", sequenceNumber: 1,
    }), WS_A);
    await appendJsonl("ch-alpha", row({
      id: "m-2", channelId: "ch-alpha", workspaceId: WS_A,
      content: "hello from the QA auditor", authorName: "QA auditor",
      timestamp: "2026-01-01T00:00:02.000Z", sequenceNumber: 2,
    }), WS_A);
    // A second channel in the same workspace: search must cover the whole
    // workspace, not only the open channel.
    await appendJsonl("ch-beta", row({
      id: "m-4", channelId: "ch-beta", workspaceId: WS_A,
      content: "connection check again", authorName: "Nova",
      timestamp: "2025-12-31T23:59:59.000Z", sequenceNumber: 1,
    }), WS_A);

    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/search?q=connection%20check" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.query).toBe("connection check");
    expect(body.channels).toEqual([]);
    expect(body.messages.map((m: any) => m.id)).toEqual(["m-1", "m-4"]);
    expect(body.messages[0]).toMatchObject({
      channelId: "ch-alpha",
      authorName: "Ridder",
      content: "Connection check completed",
    });
  });

  it("scopes results to the caller workspace", async () => {
    await appendJsonl("ch-alpha", row({
      id: "m-1", channelId: "ch-alpha", workspaceId: WS_A,
      content: "connection check here", authorName: "Ridder",
      timestamp: "2026-01-01T00:00:01.000Z", sequenceNumber: 1,
    }), WS_A);
    // Another workspace, newer row: recency must not beat scoping.
    await appendJsonl("ch-gamma", row({
      id: "m-5", channelId: "ch-gamma", workspaceId: WS_B,
      content: "connection check elsewhere", authorName: "Stranger",
      timestamp: "2026-01-02T00:00:00.000Z", sequenceNumber: 1,
    }), WS_B);

    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/search?q=connection%20check" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().messages.map((m: any) => m.id)).toEqual(["m-1"]);
  });

  it("matches author names as well as content", async () => {
    await appendJsonl("ch-alpha", row({
      id: "m-2", channelId: "ch-alpha", workspaceId: WS_A,
      content: "completely unrelated words", authorName: "QA auditor",
      timestamp: "2026-01-01T00:00:02.000Z", sequenceNumber: 2,
    }), WS_A);

    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/search?q=QA%20auditor" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().messages.map((m: any) => m.id)).toEqual(["m-2"]);
  });

  it("keeps internal-monologue rows in the raw payload (the client filters them)", async () => {
    // UI audit minor #22: reasoning text must not surface in OmniSearch. The
    // server returns the raw tier rows for both PG and local; the modal owns
    // the presentation filter, so the raw contract keeps monologues here.
    await appendJsonl("ch-alpha", row({
      id: "m-3", channelId: "ch-alpha", workspaceId: WS_A,
      content: "thinking about the weather", authorName: "Ridder",
      isInternalMonologue: true,
      timestamp: "2026-01-01T00:00:03.000Z", sequenceNumber: 3,
    }), WS_A);

    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/search?q=thinking%20about%20the%20weather" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([
      expect.objectContaining({ id: "m-3", isInternalMonologue: true }),
    ]);
  });

  it("degrades to the local tier when an explicit database handle is unreachable", async () => {
    await appendJsonl("ch-alpha", row({
      id: "m-1", channelId: "ch-alpha", workspaceId: WS_A,
      content: "connection check on a dead replica", authorName: "Ridder",
      timestamp: "2026-01-01T00:00:01.000Z", sequenceNumber: 1,
    }), WS_A);

    const refused = Object.assign(new Error("Failed query: select 1"), {
      cause: { code: "ECONNREFUSED" },
    });
    const deadDb = {
      execute: async () => { throw refused; },
      select: () => { throw refused; },
    };

    const app = await makeApp(deadDb);
    const res = await app.inject({ method: "GET", url: "/api/search?q=dead%20replica" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().messages.map((m: any) => m.id)).toEqual(["m-1"]);
  });

  it("still 500s on a logic-class failure (not an outage)", async () => {
    const logicErr = new Error("column \"messages\" does not exist");
    const deadDb = {
      execute: async () => { throw logicErr; },
      select: () => { throw logicErr; },
    };

    const app = await makeApp(deadDb);
    const res = await app.inject({ method: "GET", url: "/api/search?q=anything" });
    await app.close();

    expect(res.statusCode).toBe(500);
  });
});
