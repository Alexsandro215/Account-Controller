import { config } from "../config.js";
import type { InlineKeyboard } from "../telegram/client.js";

// Handlers never call Telegram directly: they describe what to do on a BotContext and the
// transport (telegram/polling.ts) executes it. That keeps handlers testable.

export type Output =
  /** A new message. With ttlSeconds it deletes itself (used for anything revealing secrets). */
  | { kind: "send"; text: string; keyboard?: InlineKeyboard; ttlSeconds?: number }
  /** Replace the message a button was pressed on (navigation); a new message otherwise. */
  | { kind: "show"; text: string; keyboard?: InlineKeyboard; ttlSeconds?: number }
  | { kind: "document"; filename: string; content: Buffer; caption?: string }
  /** Delete the message a button was pressed on. */
  | { kind: "deleteSource" };

export type Source =
  | { kind: "message"; messageId: number }
  | { kind: "callback"; callbackId: string; messageId?: number };

export class BotContext {
  readonly outputs: Output[] = [];
  /** The user's message carried a secret (password, PIN, CSV, QR photo): delete it. */
  deleteIncoming = false;
  toastText?: string;
  toastAlert = false;

  constructor(
    readonly userId: string,
    readonly chatId: number,
    readonly source: Source
  ) {}

  /** All texts are HTML: escape anything dynamic with escapeHtml(). */
  send(text: string, keyboard?: InlineKeyboard): void {
    this.outputs.push({ kind: "send", text, keyboard });
  }

  show(text: string, keyboard?: InlineKeyboard): void {
    this.outputs.push({ kind: "show", text, keyboard });
  }

  /** A message with secrets: deleted automatically after `ttlSeconds`. */
  sendSecret(text: string, keyboard?: InlineKeyboard, ttlSeconds = config.SENSITIVE_MESSAGE_TTL_SECONDS): void {
    this.outputs.push({ kind: "send", text, keyboard, ttlSeconds });
  }

  /** Replaces a secret message in place (e.g. "another password" in the generator). */
  showSecret(text: string, keyboard?: InlineKeyboard, ttlSeconds = config.SENSITIVE_MESSAGE_TTL_SECONDS): void {
    this.outputs.push({ kind: "show", text, keyboard, ttlSeconds });
  }

  document(filename: string, content: Buffer, caption?: string): void {
    this.outputs.push({ kind: "document", filename, content, caption });
  }

  toast(text: string, alert = false): void {
    this.toastText = text;
    this.toastAlert = alert;
  }

  deleteSource(): void {
    this.outputs.push({ kind: "deleteSource" });
  }
}
