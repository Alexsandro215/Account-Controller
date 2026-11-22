import { TEST_BOT_TOKEN, TEST_USER_ID } from "./support/env.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { useStore } from "../src/db/index.js";
import { setupVault } from "../src/vault/keys.js";
import { lockVault } from "../src/vault/unlock.js";
import { createServer } from "../src/web/server.js";
import { signInitDataForTests, validateInitData } from "../src/web/telegramAuth.js";
import { closeStores, freshStore } from "./support/stores.js";

const MASTER = "frase maestra de la app";
let server: Server;
let base: string;

const now = () => Math.floor(Date.now() / 1000);
const auth = (userId = Number(TEST_USER_ID), authDate = now(), token = TEST_BOT_TOKEN) =>
  `tma ${signInitDataForTests(token, userId, authDate)}`;

async function api(method: string, path: string, body?: unknown, authorization = auth()) {
  const response = await fetch(`${base}/api/${path}`, {
    method,
    headers: { authorization, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("validateInitData", () => {
  it("accepts data signed with the bot token and rejects everything else", () => {
    const valid = signInitDataForTests(TEST_BOT_TOKEN, 42, 1_000_000);
    assert.deepEqual(validateInitData(valid, TEST_BOT_TOKEN, 1_000_100), { userId: "42" });
    assert.equal(validateInitData(valid, "other:token", 1_000_100), null, "other bot");
    assert.equal(validateInitData(valid.replace("42", "43"), TEST_BOT_TOKEN, 1_000_100), null, "tampered user");
    assert.equal(validateInitData(valid, TEST_BOT_TOKEN, 1_000_000 + 2 * 86_400), null, "expired");
    assert.equal(validateInitData("hash=zz", TEST_BOT_TOKEN), null, "garbage");
  });
});

describe("Mini App API", () => {
  before(async () => {
    useStore(await freshStore());
    lockVault();
    server = createServer({ miniApp: true }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await closeStores();
  });

  it("rejects requests that are not from the authorized Telegram user", async () => {
    assert.equal((await api("GET", "state", undefined, "")).status, 401);
    assert.equal((await api("GET", "state", undefined, auth(7))).status, 401, "another Telegram user");
    assert.equal((await api("GET", "state", undefined, auth(42, now(), "999:other"))).status, 401, "forged");
    assert.equal((await api("GET", "state", undefined, auth(42, now() - 3 * 86_400))).status, 401, "stale");
  });

  it("reports when the vault is not configured yet", async () => {
    assert.deepEqual((await api("GET", "state")).body, {
      vaultReady: false,
      unlocked: false,
      unlockExpiresAt: null,
      lockedUntil: null
    });
    assert.deepEqual(await api("GET", "credentials"), { status: 409, body: { error: "vault_not_ready" } });
  });

  it("lists and creates while locked, but reveals, edits and deletes only when open", async () => {
    await setupVault(MASTER);
    lockVault();

    const created = await api("POST", "credentials", {
      category: "Correo",
      service: "Gmail",
      email: "yo@gmail.com",
      password: "clave-gmail",
      totp: "JBSWY3DPEHPK3PXP"
    });
    assert.equal(created.status, 201);
    const id = created.body.item.id as string;
    assert.equal(created.body.item.hasTotp, true);
    assert.equal(created.body.item.password, undefined, "never echoes secrets");

    assert.equal((await api("GET", "credentials")).body.items.length, 1);
    assert.equal((await api("POST", `credentials/${id}/reveal`)).status, 423);
    assert.equal((await api("PATCH", `credentials/${id}`, { service: "X" })).status, 423);
    assert.equal((await api("DELETE", `credentials/${id}`)).status, 423);

    const wrong = await api("POST", "unlock", { password: "no es" });
    assert.deepEqual(wrong, { status: 403, body: { error: "wrong_password", remainingAttempts: 2 } });

    const unlocked = await api("POST", "unlock", { password: MASTER });
    assert.equal(unlocked.status, 200);
    assert.ok(Date.parse(unlocked.body.unlockExpiresAt) > Date.now());

    assert.deepEqual((await api("POST", `credentials/${id}/reveal`)).body, { password: "clave-gmail", notes: null });
    assert.match((await api("POST", `credentials/${id}/totp`)).body.code, /^\d{6}$/);

    const patched = await api("PATCH", `credentials/${id}`, { password: "nueva", totp: null, notes: "hola" });
    assert.equal(patched.body.item.hasTotp, false);
    assert.equal(patched.body.item.hasNotes, true);
    assert.deepEqual((await api("POST", `credentials/${id}/totp`)).body.error, "no_totp");

    assert.equal((await api("DELETE", `credentials/${id}`)).status, 200);
    assert.equal((await api("POST", `credentials/${id}/reveal`)).status, 404);

    assert.equal((await api("POST", "lock")).body.unlocked, false);
  });

  it("validates input and generates passwords", async () => {
    const invalid = await api("POST", "credentials", { category: "A", service: "", email: "x", password: "y" });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.message, /servicio/);

    const generated = await api("POST", "generate", { length: 30, symbols: false });
    assert.match(generated.body.password, /^[A-Za-z2-9]{30}$/);
  });

  it("locks the vault after repeated wrong passwords", async () => {
    // The successful unlock above reset the counter: three new failures are needed.
    assert.equal((await api("POST", "unlock", { password: "mal 1" })).status, 403);
    assert.equal((await api("POST", "unlock", { password: "mal 2" })).status, 403);
    const locked = await api("POST", "unlock", { password: "mal 3" });
    assert.equal(locked.status, 429);
    assert.equal((await api("POST", "unlock", { password: MASTER })).status, 429, "even the right one");
    assert.ok((await api("GET", "state")).body.lockedUntil);
  });

  it("serves the app with a strict Content Security Policy", { skip: !existsSync("public/app/index.html") }, async () => {
    const response = await fetch(`${base}/app/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self' https:\/\/telegram\.org/);
    assert.match(await response.text(), /telegram-web-app\.js/);

    const bare = await fetch(`${base}/app`, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), "/app/", "relative asset URLs need the trailing slash");
  });

  it("answers health checks", async () => {
    const response = await fetch(`${base}/health`);
    assert.deepEqual(await response.json(), { ok: true, database: true, polling: false });
  });
});
