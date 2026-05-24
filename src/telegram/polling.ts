import { handleBotMessage } from "../bot/flows.js";
import { isAuthorizedTelegramUser } from "../security/auth.js";
import {
  deleteTelegramMessage,
  getTelegramUpdates,
  sendTelegramMessage,
  type TelegramUpdate
} from "./client.js";

let offset: number | undefined;
const sensitiveMessageIds = new Map<number, number[]>();

export async function startTelegramPolling(): Promise<void> {
  console.log("Telegram polling started");

  while (true) {
    try {
      const updates = await getTelegramUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error("Telegram polling error", error);
      await delay(3_000);
    }
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;

  if (!message?.text || !message.from || message.from.is_bot) {
    return;
  }

  const userId = String(message.from.id);
  const chatId = message.chat.id;

  if (!isAuthorizedTelegramUser(userId)) {
    await sendTelegramMessage(
      chatId,
      [
        "Este bot esta bloqueado para uso personal.",
        `Tu Telegram user id es: ${userId}`,
        "Ponlo en AUTHORIZED_TELEGRAM_USER_ID dentro de .env y reinicia el bot."
      ].join("\n")
    );
    return;
  }

  if (message.text.trim() === ".") {
    await clearSensitiveMessages(chatId, message.message_id);
    return;
  }

  try {
    const reply = await handleBotMessage(userId, message.text);
    const sentMessage = await sendTelegramMessage(chatId, reply);

    if (isSensitiveReply(reply)) {
      rememberSensitiveMessage(chatId, sentMessage.message_id);
    }
  } catch (error) {
    console.error("Bot error", error);
    await sendTelegramMessage(chatId, "Hubo un error procesando tu mensaje.");
  }
}

async function clearSensitiveMessages(chatId: number, triggerMessageId: number): Promise<void> {
  const messageIds = sensitiveMessageIds.get(chatId) ?? [];
  sensitiveMessageIds.delete(chatId);

  for (const messageId of messageIds) {
    await deleteIgnoringErrors(chatId, messageId);
  }

  await deleteIgnoringErrors(chatId, triggerMessageId);

  if (messageIds.length === 0) {
    const sentMessage = await sendTelegramMessage(chatId, "No hay mensajes sensibles guardados para borrar.");
    setTimeout(() => {
      void deleteIgnoringErrors(chatId, sentMessage.message_id);
    }, 5_000);
    return;
  }

  const sentMessage = await sendTelegramMessage(chatId, "Mensajes sensibles borrados.");
  setTimeout(() => {
    void deleteIgnoringErrors(chatId, sentMessage.message_id);
  }, 5_000);
}

function rememberSensitiveMessage(chatId: number, messageId: number): void {
  const messageIds = sensitiveMessageIds.get(chatId) ?? [];
  messageIds.push(messageId);
  sensitiveMessageIds.set(chatId, messageIds.slice(-10));
}

function isSensitiveReply(reply: string): boolean {
  return reply.includes("Contrasena:");
}

async function deleteIgnoringErrors(chatId: number, messageId: number): Promise<void> {
  try {
    await deleteTelegramMessage(chatId, messageId);
  } catch (error) {
    console.error("Telegram delete failed", error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
