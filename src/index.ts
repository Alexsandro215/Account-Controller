import { config } from "./config.js";
import { prisma } from "./db/prisma.js";
import { startBackupScheduler } from "./scheduler.js";
import { setTelegramCommands, setTelegramMenuButton } from "./telegram/client.js";
import { startTelegramPolling, stopTelegramPolling } from "./telegram/polling.js";
import { flushPendingDeletions } from "./telegram/selfDestruct.js";
import { migrateLegacyCredentials } from "./vault/credentials.js";
import { isVaultReady } from "./vault/keys.js";
import { lockVault } from "./vault/unlock.js";
import { createServer } from "./web/server.js";

const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

const BOT_COMMANDS = [
  { command: "menu", description: "Menú principal" },
  { command: "buscar", description: "Buscar una credencial: /buscar netflix" },
  { command: "nueva", description: "Guardar una credencial nueva" },
  { command: "generar", description: "Generar una contraseña segura" },
  { command: "salud", description: "Revisar contraseñas filtradas, repetidas o débiles" },
  { command: "respaldo", description: "Recibir un respaldo cifrado" },
  { command: "actividad", description: "Ver la actividad reciente" },
  { command: "bloquear", description: "Cerrar la bóveda ya" },
  { command: "ajustes", description: "Contraseña maestra, recuperación, importar" },
  { command: "cancelar", description: "Salir del paso actual" }
];

const server = createServer().listen(config.PORT, () => {
  console.log(`Account Controller listening on port ${config.PORT}`);
});

void prepare();

startTelegramPolling().catch((error) => {
  console.error("Telegram polling stopped", error);
  process.exitCode = 1;
});

const stopScheduler = startBackupScheduler();

/** Best-effort startup tasks; none of them may stop the bot from running. */
async function prepare(): Promise<void> {
  try {
    if (await isVaultReady()) {
      const { migrated, failed } = await migrateLegacyCredentials();
      if (migrated > 0 || failed > 0) {
        console.log(`Legacy credentials migrated: ${migrated}, failed: ${failed}`);
      }
    }
  } catch (error) {
    console.error("Legacy migration check failed", error);
  }

  try {
    await setTelegramCommands(BOT_COMMANDS);

    if (config.WEBAPP_URL && config.AUTHORIZED_TELEGRAM_USER_ID) {
      await setTelegramMenuButton(Number(config.AUTHORIZED_TELEGRAM_USER_ID), "Bóveda", config.WEBAPP_URL);
    }
  } catch (error) {
    console.error("Could not register bot commands", error);
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  stopTelegramPolling();
  stopScheduler();
  lockVault();

  // Delete revealed passwords now instead of leaving them visible while the bot is down.
  await Promise.race([
    flushPendingDeletions().catch((error) => console.error("Flush failed", error)),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS))
  ]);

  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
