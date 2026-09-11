import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Manual ETag for hot reference GETs (no new deps — @fastify/etag absent).
 * Emits `ETag` + `Cache-Control: private, max-age=5` and short-circuits 304s
 * so polling clients skip re-downloads. Returns the reply when a 304 was
 * sent, otherwise null and the caller should return its body normally.
 */
export function maybeSend304(
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
): boolean {
  let json = "";
  try {
    json = JSON.stringify(body ?? null);
  } catch {
    return false;
  }
  const etag = `"${createHash("sha1").update(json).digest("hex").slice(0, 27)}"`;
  reply.header("ETag", etag);
  reply.header("Cache-Control", "private, max-age=5");
  if (request.headers["if-none-match"] === etag) {
    void reply.status(304).send();
    return true;
  }
  return false;
}
