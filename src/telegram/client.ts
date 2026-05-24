import { config } from "../config.js";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
    text?: string;
  };
};

type TelegramMessage = {
  message_id: number;
};

const baseUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

export async function sendTelegramMessage(chatId: number, text: string): Promise<TelegramMessage> {
  return telegramRequest<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

export async function deleteTelegramMessage(chatId: number, messageId: number): Promise<void> {
  await telegramRequest("deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
}

export async function getTelegramUpdates(offset?: number): Promise<TelegramUpdate[]> {
  return telegramRequest<TelegramUpdate[]>("getUpdates", {
    offset,
    timeout: 30,
    allowed_updates: ["message"]
  });
}

async function telegramRequest<T>(method: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as TelegramResponse<T>;

  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${payload.description ?? "Unknown error"}`);
  }

  return payload.result as T;
}
