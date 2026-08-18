import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  CLIENT_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1).optional(),
});

export const env = envSchema.parse(process.env);
