import { BotContext } from "../bot/context.js";
import { handleCallback, handleDocument, handlePhoto, handleText } from "../bot/router.js";
import { isAuthorizedTelegramUser, isVaultConfigured } from "../security/auth.js";
import {
  answerCallbackQuery,
  downloadTelegramFile,
  editTelegramMessage,
  getTelegramUpdates,
  sendTelegramDocument,
  sendTelegramMessage,
  TelegramApiError,
  type InlineKeyboard,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate
} from "./client.js";
import { splitMessage } from "./format.js";
import { deleteAllPendingNow, deleteNow, restorePendingDeletions, scheduleDeletion } from "./selfDestruct.js";

const NOTICE_TTL_MS = 5_000;

let offset: number | undefined;
let running = false;
let currentPoll: AbortController | undefined;
let lastPollAt = 0;

/** For the health check: the long poll returns at least every ~30 s while healthy. */
export function lastSuccessfulPoll(): Date | undefined {
  return lastPollAt === 0 ? undefined : new Date(lastPollAt);
}

export async function startTelegramPolling(): Promise<void> {
  running = true;

  try {
    await restorePendingDeletions();
  } catch (error) {
    console.error("Could not restore pending deletions", error);
  }

  console.log("Telegram polling started");

  while (running) {
    currentPoll = new AbortController();
    let updates: TelegramUpdate[];

    try {
      updates = await getTelegramUpdates(offset, currentPoll.signal);
      lastPollAt = Date.now();
    } catch (error) {
      if (!running) {
        break;
      }

      console.error("Telegram polling error", error);
      await delay(3_000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;

      try {
        await handleUpdate(update);
      } catch (error) {
        console.error(`Failed to handle update ${update.update_id}`, error);
      }
    }
  }

  console.log("Telegram polling stopped");
}

export function stopTelegramPolling(): void {
  running = false;
  currentPoll?.abort();
}

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    return handleCallbackUpdate(update.callback_query);
  }

  if (update.message) {
    return handleMessageUpdate(update.message);
  }
}

async function handleMessageUpdate(message: TelegramMessage): Promise<void> {
  if (!message.from || message.from.is_bot) {
    return;
  }

  const userId = String(message.from.id);
  const chatId = message.chat.id;

  if (!isAuthorizedTelegramUser(userId)) {
    if (!isVaultConfigured()) {
      await sendTelegramMessage(
        chatId,
        [
          "Este bot está bloqueado para uso personal.",
          `Tu Telegram user id es: ${userId}`,
          "Ponlo en AUTHORIZED_TELEGRAM_USER_ID dentro de .env y reinicia el bot."
        ].join("\n")
      );
    } else {
      // Once configured, strangers get no reply at all: nothing to learn about the bot.
      console.warn(`Ignored message from unauthorized Telegram user ${userId}`);
    }
    return;
  }

  if (message.chat.type !== "private") {
    // Revealing passwords in a group would show them to every member.
    await sendTelegramMessage(chatId, "Por seguridad solo funciono en chat privado.");
    return;
  }

  if (message.text?.trim() === ".") {
    await purgeSensitiveMessages(chatId, message.message_id);
    return;
  }

  const ctx = new BotContext(userId, chatId, { kind: "message", messageId: message.message_id });

  if (message.text !== undefined) {
    await handleText(ctx, message.text);
  } else if (message.document) {
    const document = message.document;
    await handleDocument(ctx, {
      fileName: document.file_name,
      size: document.file_size,
      download: () => downloadTelegramFile(document.file_id)
    });
  } else if (message.photo && message.photo.length > 0) {
    // Telegram sends several sizes; the last one is the largest (best for QR decoding).
    const largest = message.photo[message.photo.length - 1];
    await handlePhoto(ctx, () => downloadTelegramFile(largest.file_id));
  } else {
    return;
  }

  await execute(ctx);
}

async function handleCallbackUpdate(query: TelegramCallbackQuery): Promise<void> {
  const userId = String(query.from.id);

  if (!isAuthorizedTelegramUser(userId) || !query.message || query.message.chat.type !== "private") {
    console.warn(`Ignored callback from Telegram user ${userId}`);
    // Answer anyway (with nothing) so the button stops spinning; it reveals nothing.
    await answerCallbackQuery(query.id).catch(() => undefined);
    return;
  }

  const ctx = new BotContext(userId, query.message.chat.id, {
    kind: "callback",
    callbackId: query.id,
    messageId: query.message.message_id
  });

  await handleCallback(ctx, query.data ?? "");
  await execute(ctx);
}

/** Carries out what a handler asked for, in order. */
export async function execute(ctx: BotContext): Promise<void> {
  const { chatId, source } = ctx;

  try {
    if (ctx.deleteIncoming && source.kind === "message") {
      await deleteNow(chatId, source.messageId);
    }

    for (const output of ctx.outputs) {
      switch (output.kind) {
        case "send":
          await sendChunks(chatId, output.text, output.keyboard, output.ttlSeconds);
          break;

        case "show":
          if (!(await tryEditSource(ctx, output.text, output.keyboard, output.ttlSeconds))) {
            await sendChunks(chatId, output.text, output.keyboard, output.ttlSeconds);
          }
          break;

        case "document":
          await sendTelegramDocument(chatId, output.filename, output.content, output.caption);
          break;

        case "deleteSource":
          if (source.messageId) {
            await deleteNow(chatId, source.messageId);
          }
          break;
      }
    }
  } finally {
    if (source.kind === "callback") {
      // Always answer, or the button keeps spinning in the user's app.
      await answerCallbackQuery(source.callbackId, ctx.toastText, ctx.toastAlert).catch((error) =>
        console.warn("Could not answer callback query", error)
      );
    }
  }
}

async function tryEditSource(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard | undefined,
  ttlSeconds: number | undefined
): Promise<boolean> {
  const { source, chatId } = ctx;

  if (source.kind !== "callback" || !source.messageId || splitMessage(text).length > 1) {
    return false;
  }

  try {
    await editTelegramMessage(chatId, source.messageId, text, { html: true, keyboard });
  } catch (error) {
    if (error instanceof TelegramApiError && error.isNotModified) {
      return true;
    }

    // Too old to edit, deleted, etc.: fall back to a new message.
    console.warn("Could not edit message, sending a new one", error);
    return false;
  }

  if (ttlSeconds) {
    await scheduleDeletion(chatId, source.messageId, ttlSeconds * 1000);
  }

  return true;
}

async function sendChunks(
  chatId: number,
  text: string,
  keyboard: InlineKeyboard | undefined,
  ttlSeconds: number | undefined
): Promise<void> {
  const chunks = splitMessage(text);

  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const sent = await sendTelegramMessage(chatId, chunk, { html: true, keyboard: isLast ? keyboard : undefined });

    if (ttlSeconds) {
      await scheduleDeletion(chatId, sent.message_id, ttlSeconds * 1000);
    }
  }
}

async function purgeSensitiveMessages(chatId: number, triggerMessageId: number): Promise<void> {
  const deleted = await deleteAllPendingNow(chatId);
  await deleteNow(chatId, triggerMessageId);

  const notice = await sendTelegramMessage(
    chatId,
    deleted === 0 ? "No hay mensajes sensibles pendientes de borrar." : `Borré ${deleted} mensaje(s) sensible(s).`
  );
  await scheduleDeletion(chatId, notice.message_id, NOTICE_TTL_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
