import { TEST_USER_ID } from "./support/env.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { BotContext } from "../src/bot/context.js";
import { useStore } from "../src/db/index.js";
import { execute, handleUpdate } from "../src/telegram/polling.js";
import { deleteAllPendingNow } from "../src/telegram/selfDestruct.js";
import { createMemoryStore } from "./support/memoryStore.js";

// Telegram is replaced by a fake fetch that records every Bot API call.
type Call = { method: string; body: Record<string, any> };
let calls: Call[] = [];
let failEdits = false;
let nextMessageId = 1000;
const CHAT = Number(TEST_USER_ID);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const method = String(input).split("/").pop()!;
  const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? "{}"));
  calls.push({ method, body });

  if (method === "editMessageText" && failEdits) {
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: message can't be edited" }), { status: 400 });
  }

  const result = method === "sendMessage" || method === "sendDocument" ? { message_id: ++nextMessageId } : true;
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}) as typeof fetch;

const methods = () => calls.map((call) => call.method);
let memory: ReturnType<typeof createMemoryStore>;

describe("transport", () => {
  beforeEach(async () => {
    failEdits = false;
    memory = createMemoryStore();
    useStore(memory.store);
    // Self-destruct timers live in memory across tests; start each test clean.
    await deleteAllPendingNow(CHAT);
    calls = [];
  });

  after(async () => {
    await deleteAllPendingNow(CHAT);
  });

  it("deletes a secret message first, then replies", async () => {
    const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: 5 });
    ctx.deleteIncoming = true;
    ctx.send("ok");
    await execute(ctx);

    assert.deepEqual(methods(), ["deleteMessage", "sendMessage"]);
    assert.equal(calls[0].body.message_id, 5);
    assert.equal(calls[1].body.parse_mode, "HTML");
  });

  it("schedules self-destruction of secrets and persists it", async () => {
    const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: 6 });
    ctx.sendSecret("<code>secreto</code>", [[{ text: "x", callback_data: "x" }]]);
    await execute(ctx);

    const [pending] = memory.raw.pending.values();
    assert.equal(pending.messageId, nextMessageId);
    assert.ok(Math.abs(pending.deleteAt.getTime() - Date.now() - 60_000) < 2_000);
  });

  it("splits long messages and puts the keyboard on the last part only", async () => {
    const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: 7 });
    ctx.send(Array.from({ length: 400 }, (_, i) => `linea ${i} con algo de texto`).join("\n"), [[{ text: "m", callback_data: "m" }]]);
    await execute(ctx);

    const sends = calls.filter((call) => call.method === "sendMessage");
    assert.ok(sends.length >= 2);
    assert.ok(sends.every((call) => call.body.text.length <= 4096));
    assert.deepEqual(sends.map((call) => call.body.reply_markup !== undefined), [...sends.slice(1).map(() => false), true]);
  });

  it("edits the pressed message for navigation, falls back to a new one, and always answers the button", async () => {
    let ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "callback", callbackId: "q1", messageId: 77 });
    ctx.show("menu");
    ctx.toast("hecho");
    await execute(ctx);
    assert.deepEqual(methods(), ["editMessageText", "answerCallbackQuery"]);
    assert.equal(calls[1].body.text, "hecho");

    calls = [];
    failEdits = true;
    ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "callback", callbackId: "q2", messageId: 78 });
    ctx.show("menu");
    await execute(ctx);
    assert.deepEqual(methods(), ["editMessageText", "sendMessage", "answerCallbackQuery"]);
  });

  it("ignores strangers once configured and refuses group chats", async () => {
    await handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 9, type: "private" }, from: { id: 9 }, text: "hola" } });
    assert.deepEqual(methods(), [], "no reply at all to strangers");

    await handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: -100, type: "group" }, from: { id: CHAT }, text: "menu" }
    });
    assert.match(calls[0].body.text, /chat privado/);

    calls = [];
    await handleUpdate({ update_id: 3, callback_query: { id: "q", from: { id: 9 }, message: { message_id: 1, chat: { id: 9, type: "private" } }, data: "m" } });
    assert.deepEqual(methods(), ["answerCallbackQuery"], "buttons from strangers only stop spinning");
    assert.equal(calls[0].body.text, undefined, "and reveal nothing");
  });

  it("purges every pending secret with '.'", async () => {
    const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: 8 });
    ctx.sendSecret("uno");
    ctx.sendSecret("dos");
    await execute(ctx);
    calls = [];

    await handleUpdate({ update_id: 4, message: { message_id: 9, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: "." } });

    const deleted = calls.filter((call) => call.method === "deleteMessage").map((call) => call.body.message_id);
    assert.equal(deleted.length, 3, "two secrets and the '.' itself");
    assert.ok(deleted.includes(9));
    assert.match(calls.find((call) => call.method === "sendMessage")!.body.text, /Borré 2/);
  });
});
