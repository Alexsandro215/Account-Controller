import { config } from "./config.js";
import { db } from "./db/index.js";
import { sendTelegramDocument } from "./telegram/client.js";
import { createBackup } from "./vault/backup.js";
import { isVaultReady } from "./vault/keys.js";

const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_AFTER_MS = 2 * 60_000;
export const LAST_BACKUP_SETTING = "lastBackupAt";

/**
 * Sends an encrypted backup to your Telegram chat every BACKUP_INTERVAL_DAYS. Backups only
 * need the vault's public key, so they run even while the vault is closed.
 */
export function startBackupScheduler(): () => void {
  if (config.BACKUP_INTERVAL_DAYS === 0 || config.AUTHORIZED_TELEGRAM_USER_ID === "") {
    return () => {};
  }

  const first = setTimeout(() => void runScheduledBackup(), FIRST_CHECK_AFTER_MS);
  const timer = setInterval(() => void runScheduledBackup(), CHECK_EVERY_MS);
  first.unref();
  timer.unref();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export async function runScheduledBackup(now = new Date()): Promise<boolean> {
  try {
    if (!(await isVaultReady())) {
      return false;
    }

    const last = await db().settings.get(LAST_BACKUP_SETTING);
    const intervalMs = config.BACKUP_INTERVAL_DAYS * 86_400_000;

    if (last && now.getTime() - new Date(last).getTime() < intervalMs) {
      return false;
    }

    const backup = await createBackup(now);

    if (backup.count === 0) {
      return false;
    }

    // In a private chat, the chat id is the user id.
    await sendTelegramDocument(
      Number(config.AUTHORIZED_TELEGRAM_USER_ID),
      backup.filename,
      backup.content,
      `💾 Respaldo automático (${backup.count} credenciales). Se abre con tu contraseña maestra o tu código de recuperación.`
    );
    await db().settings.set(LAST_BACKUP_SETTING, now.toISOString());
    console.log(`Scheduled backup sent (${backup.count} credentials)`);
    return true;
  } catch (error) {
    console.error("Scheduled backup failed", error);
    return false;
  }
}
