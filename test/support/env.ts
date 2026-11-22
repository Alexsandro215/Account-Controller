// Imported first by tests that load src/config.ts, so the config parses without a .env.
export const TEST_BOT_TOKEN = "123456:TEST_TOKEN";
export const TEST_USER_ID = "42";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://test:test@127.0.0.1:1/test";
process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
process.env.AUTHORIZED_TELEGRAM_USER_ID = TEST_USER_ID;
process.env.VAULT_MASTER_KEY = "test-server-secret-that-is-long-enough-1234";
process.env.SENSITIVE_MESSAGE_TTL_SECONDS = "60";
process.env.VAULT_UNLOCK_MINUTES = "5";
process.env.PWNED_CHECK = "false";
process.env.TIMEZONE = "America/Mexico_City";
process.env.WEBAPP_URL ??= "";
