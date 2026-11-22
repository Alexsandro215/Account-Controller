import { TEST_USER_ID } from "./support/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useStore } from "../src/db/index.js";
import { LAST_BACKUP_SETTING, runScheduledBackup } from "../src/scheduler.js";
import { createCredential } from "../src/vault/credentials.js";
import { setupVault } from "../src/vault/keys.js";
import { lockVault } from "../src/vault/unlock.js";
import { createMemoryStore } from "./support/memoryStore.js";

const sent: { method: string; chatId: string; filename?: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const method = String(input).split("/").pop()!;
  const form = init?.body as FormData;
  const document = form.get("document") as File;
  sent.push({ method, chatId: String(form.get("chat_id")), filename: document?.name });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}) as typeof fetch;

describe("scheduled backups", () => {
  it("sends an encrypted backup to the owner once per interval, even with the vault closed", async () => {
    const memory = createMemoryStore();
    useStore(memory.store);

    assert.equal(await runScheduledBackup(), false, "nothing to back up before setup");

    await setupVault("frase maestra del respaldo");
    lockVault();
    assert.equal(await runScheduledBackup(), false, "an empty vault is not backed up");

    await createCredential({ category: "A", service: "A", email: "a", password: "a" });
    const monday = new Date("2026-11-23T09:00:00Z");
    assert.equal(await runScheduledBackup(monday), true);
    assert.deepEqual(sent, [{ method: "sendDocument", chatId: TEST_USER_ID, filename: "boveda-2026-11-23.json" }]);
    assert.equal(memory.raw.settings.get(LAST_BACKUP_SETTING), monday.toISOString());

    assert.equal(await runScheduledBackup(new Date("2026-11-27T09:00:00Z")), false, "not again within 7 days");
    assert.equal(await runScheduledBackup(new Date("2026-11-30T09:00:01Z")), true, "again after 7 days");
    assert.equal(sent.length, 2);
  });
});
