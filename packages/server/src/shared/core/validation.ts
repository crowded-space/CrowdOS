import type { FastifySchemaCompiler } from "fastify";
import type { ZodSchema } from "zod";

export const validatorCompiler: FastifySchemaCompiler<ZodSchema> = ({ schema }) => {
  return (data: any) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    return { error: result.error };
  };
};
