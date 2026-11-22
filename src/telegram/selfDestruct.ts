import { db } from "../db/index.js";
import { deleteTelegramMessage, TelegramApiError } from "./client.js";

// Telegram only lets bots delete messages younger than 48 h; past that, give up.
const TELEGRAM_DELETE_WINDOW_MS = 48 * 60 * 60_000;
const RETRY_DELAY_MS = 30_000;

type Pending = {
  chatId: number;
  messageId: number;
  deleteAt: Date;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();

/**
 * Deletes a message after `delayMs`. The timer lives in memory and the job is also
 * stored in the database, so a restart picks it up again via restorePendingDeletions().
 */
export async function scheduleDeletion(chatId: number, messageId: number, delayMs: number): Promise<void> {
  const deleteAt = new Date(Date.now() + delayMs);
  arm(chatId, messageId, deleteAt);

  try {
    await db().pendingDeletions.upsert({ chatId, messageId, deleteAt });
  } catch (error) {
    // The in-memory timer still runs; only restart-survival is lost.
    console.error("Could not persist pending deletion", error);
  }
}

/** Deletes a message right away; if Telegram is unreachable, keeps retrying in the background. */
export async function deleteNow(chatId: number, messageId: number): Promise<void> {
  const wasScheduled = disarm(chatId, messageId);
  const outcome = await attemptDelete(chatId, messageId);

  if (outcome === "retry") {
    await scheduleDeletion(chatId, messageId, RETRY_DELAY_MS);
  } else if (wasScheduled) {
    await forget(chatId, messageId);
  }
}

/** Deletes every pending message of a chat immediately. Returns how many there were. */
export async function deleteAllPendingNow(chatId: number): Promise<number> {
  const messageIds = new Set<number>();

  for (const job of pending.values()) {
    if (job.chatId === chatId) {
      messageIds.add(job.messageId);
    }
  }

  try {
    const rows = await db().pendingDeletions.listForChat(chatId);
    rows.forEach((row) => messageIds.add(row.messageId));
  } catch (error) {
    console.error("Could not read pending deletions", error);
  }

  for (const messageId of messageIds) {
    await runDeletion(chatId, messageId, new Date());
  }

  return messageIds.size;
}

/** Used on shutdown: better to delete secrets early than leave them while the bot is down. */
export async function flushPendingDeletions(): Promise<void> {
  const jobs = [...pending.values()];

  for (const job of jobs) {
    await runDeletion(job.chatId, job.messageId, job.deleteAt, false);
  }
}

export async function restorePendingDeletions(): Promise<void> {
  const cutoff = new Date(Date.now() - TELEGRAM_DELETE_WINDOW_MS);

  await db().pendingDeletions.purgeBefore(cutoff);
  const rows = await db().pendingDeletions.listAll();

  for (const row of rows) {
    arm(row.chatId, row.messageId, row.deleteAt);
  }

  if (rows.length > 0) {
    console.log(`Restored ${rows.length} pending message deletion(s)`);
  }
}

function arm(chatId: number, messageId: number, deleteAt: Date, fireAt = deleteAt): void {
  const key = keyOf(chatId, messageId);
  const existing = pending.get(key);

  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    void runDeletion(chatId, messageId, deleteAt);
  }, Math.max(0, fireAt.getTime() - Date.now()));

  pending.set(key, { chatId, messageId, deleteAt, timer });
}

/** Cancels an in-memory timer. Returns whether one existed. */
function disarm(chatId: number, messageId: number): boolean {
  const key = keyOf(chatId, messageId);
  const existing = pending.get(key);

  if (!existing) {
    return false;
  }

  clearTimeout(existing.timer);
  pending.delete(key);
  return true;
}

async function forget(chatId: number, messageId: number): Promise<void> {
  try {
    await db().pendingDeletions.remove(chatId, messageId);
  } catch (error) {
    console.error("Could not clear pending deletion", error);
  }
}

async function runDeletion(chatId: number, messageId: number, deleteAt: Date, retry = true): Promise<void> {
  disarm(chatId, messageId);

  const outcome = await attemptDelete(chatId, messageId);
  const tooOld = Date.now() - deleteAt.getTime() > TELEGRAM_DELETE_WINDOW_MS;

  if (outcome === "retry" && !tooOld) {
    if (retry) {
      arm(chatId, messageId, deleteAt, new Date(Date.now() + RETRY_DELAY_MS));
    }
    // Without retry (shutdown) the database row stays, so the next start tries again.
    return;
  }

  await forget(chatId, messageId);
}

async function attemptDelete(chatId: number, messageId: number): Promise<"done" | "retry"> {
  try {
    await deleteTelegramMessage(chatId, messageId);
    return "done";
  } catch (error) {
    if (error instanceof TelegramApiError && error.isPermanent) {
      // Already deleted by the user, or too old: nothing else to do.
      return "done";
    }

    console.error("Telegram delete failed, will retry", error);
    return "retry";
  }
}

function keyOf(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}
