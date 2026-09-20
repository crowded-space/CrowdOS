import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError, type ZodIssue } from "zod";
import { redactLogPayload } from "./redact.js";

export function setupErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Handle Zod Validation Errors
    if (error instanceof ZodError) {
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details: error.issues.map((err: ZodIssue) => ({
          path: err.path.join("."),
          message: err.message,
        })),
      });
    }

    // Handle standard Fastify Validation Errors
    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: error.message,
        details: error.validation,
      });
    }

    // Handle all other errors — redact secrets before logging (P0-2)
    // ponytail: deep-clone redact only for 5xx; 4xx warn without stack
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      const safeErr = redactLogPayload({ message: error.message, stack: error.stack, statusCode }) as any;
      request.log.error({ err: safeErr }, `Unhandled request error: ${safeErr.message || error.message}`);
    } else {
      request.log.warn({ statusCode, message: error.message }, `Request error: ${error.message}`);
    }
    
    // Dual-boot honesty: pass through machine-readable codes and user-facing
    // recovery suggestions when throw-sites provide them (e.g.
    // LOCAL_MODE_DEGRADED / WORKSPACE_DB_OFFLINE).
    const code = (error as any).code;
    const suggestion = (error as any).suggestion;
    return reply.status(statusCode).send({
      statusCode,
      error: error.name || "Internal Server Error",
      ...(typeof code === "string" ? { code } : {}),
      message: error.statusCode ? error.message : "An unexpected error occurred",
      ...(typeof suggestion === "string" ? { suggestion } : {}),
    });
  });
}
