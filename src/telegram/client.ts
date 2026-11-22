import { config } from "../config.js";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

export type TelegramChat = { id: number; type: string };
export type TelegramUser = { id: number; is_bot?: boolean; first_name?: string; username?: string };

export type TelegramDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramPhotoSize = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: { message_id: number; chat: TelegramChat };
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

export type InlineKeyboard = InlineButton[][];

export type SendOptions = {
  html?: boolean;
  keyboard?: InlineKeyboard;
};

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string
  ) {
    super(`Telegram ${method} failed: ${status} ${description}`);
    this.name = "TelegramApiError";
  }

  /** 4xx errors other than rate limiting will not succeed on retry (e.g. message already gone). */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }

  get isNotModified(): boolean {
    return this.description.includes("message is not modified");
  }
}

const apiUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}`;

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  options: SendOptions = {}
): Promise<{ message_id: number }> {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options.html ? "HTML" : undefined,
    reply_markup: options.keyboard ? { inline_keyboard: options.keyboard } : undefined,
    link_preview_options: { is_disabled: true }
  });
}

export async function editTelegramMessage(
  chatId: number,
  messageId: number,
  text: string,
  options: SendOptions = {}
): Promise<void> {
  await telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: options.html ? "HTML" : undefined,
    reply_markup: { inline_keyboard: options.keyboard ?? [] },
    link_preview_options: { is_disabled: true }
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

export async function deleteTelegramMessage(chatId: number, messageId: number): Promise<void> {
  await telegramRequest("deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
}

export async function sendTelegramDocument(
  chatId: number,
  filename: string,
  content: Buffer,
  caption?: string
): Promise<{ message_id: number }> {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([new Uint8Array(content)], { type: "application/json" }), filename);

  if (caption) {
    form.set("caption", caption);
  }

  return telegramRequest("sendDocument", form);
}

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Downloads a file the user sent to the bot. */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const file = await telegramRequest<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });

  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
    throw new Error("File too large");
  }

  const response = await fetch(`${fileUrl}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) {
    throw new TelegramApiError("downloadFile", response.status, response.statusText);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function setTelegramCommands(commands: { command: string; description: string }[]): Promise<void> {
  await telegramRequest("setMyCommands", { commands });
}

export async function setTelegramMenuButton(chatId: number, text: string, url: string): Promise<void> {
  await telegramRequest("setChatMenuButton", {
    chat_id: chatId,
    menu_button: { type: "web_app", text, web_app: { url } }
  });
}

export async function getTelegramUpdates(offset?: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
  return telegramRequest<TelegramUpdate[]>(
    "getUpdates",
    {
      offset,
      timeout: 30,
      allowed_updates: ["message", "callback_query"]
    },
    signal
  );
}

async function telegramRequest<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const isForm = body instanceof FormData;
  const response = await fetch(`${apiUrl}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal
  });
  const payload = (await response.json().catch(() => ({ ok: false }))) as TelegramResponse<T>;

  if (!response.ok || !payload.ok) {
    throw new TelegramApiError(method, response.status, payload.description ?? "Unknown error");
  }

  return payload.result as T;
}
