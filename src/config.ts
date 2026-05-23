import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  WHATSAPP_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  AUTHORIZED_PHONE: z.string().regex(/^\d+$/),
  MASTER_PIN: z.string().min(4),
  VAULT_MASTER_KEY: z.string().min(32)
});

export const config = envSchema.parse(process.env);
