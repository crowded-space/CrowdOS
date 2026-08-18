import type { FastifySchemaCompiler } from "fastify";
import { ZodError, type ZodSchema } from "zod";

export const validatorCompiler: FastifySchemaCompiler<ZodSchema> = ({ schema }) => {
  return (data: any) => {
    try {
      const parsedValue = schema.parse(data);
      return { value: parsedValue };
    } catch (error) {
      return { error: error as ZodError };
    }
  };
};
