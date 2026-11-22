import "dotenv/config";
import { z } from "zod";

/** Empty env vars ("") behave as unset, so `FOO=` in .env falls back to the default. */
function numberSetting(defaultValue: number, min: number, max: number) {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(min).max(max).default(defaultValue)
  );
}

const envSchema = z.object({
  PORT: numberSetting(3000, 1, 65535),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  AUTHORIZED_TELEGRAM_USER_ID: z.union([z.literal(""), z.string().regex(/^\d+$/)]).default(""),
  // Server secret: pepper for the master password, and the key of pre-upgrade data.
  VAULT_MASTER_KEY: z.string().min(32),
  // Deprecated: the vault is now opened with a master password. Ignored if present.
  MASTER_PIN: z.string().optional(),
  // Seconds before a message that reveals passwords deletes itself.
  SENSITIVE_MESSAGE_TTL_SECONDS: numberSetting(60, 10, 3600),
  // Minutes of inactivity before the vault locks itself again.
  VAULT_UNLOCK_MINUTES: numberSetting(5, 1, 60),
  // Days between automatic encrypted backups sent to your chat (0 = off).
  BACKUP_INTERVAL_DAYS: numberSetting(7, 0, 90),
  // Check passwords against Have I Been Pwned (k-anonymity: only 5 hash chars leave).
  PWNED_CHECK: z
    .enum(["true", "false", ""])
    .default("true")
    .transform((value) => value !== "false"),
  // Time zone for the times the bot shows (auto-lock, activity log).
  TIMEZONE: z
    .string()
    .default("America/Mexico_City")
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat("es-MX", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA time zone"),
  // Public HTTPS URL of the Mini App (e.g. https://my-vault.example.com/app/). Empty = off.
  WEBAPP_URL: z.union([z.literal(""), z.string().url().startsWith("https://")]).default("")
});

export const config = envSchema.parse(process.env);
