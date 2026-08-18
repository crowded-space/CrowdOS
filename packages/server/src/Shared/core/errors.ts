import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError, type ZodIssue } from "zod";

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

    // Handle all other errors
    request.log.error({ err: error }, `Unhandled request error: ${error.message}`);
    
    return reply.status(error.statusCode || 500).send({
      statusCode: error.statusCode || 500,
      error: error.name || "Internal Server Error",
      message: error.statusCode ? error.message : "An unexpected error occurred",
    });
  });
}
