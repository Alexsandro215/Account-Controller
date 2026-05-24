import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  AUTHORIZED_TELEGRAM_USER_ID: z.union([z.literal(""), z.string().regex(/^\d+$/)]).default(""),
  MASTER_PIN: z.string().min(4),
  VAULT_MASTER_KEY: z.string().min(32)
});

export const config = envSchema.parse(process.env);
