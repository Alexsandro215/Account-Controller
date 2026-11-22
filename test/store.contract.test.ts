import "./support/env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, describe, it } from "node:test";
import type { Store } from "../src/db/store.js";
import { createMemoryStore } from "./support/memoryStore.js";

// The same behavioral contract for every Store implementation. The Prisma store runs only
// when TEST_DATABASE_URL points to a migrated PostgreSQL database (CI does this).

type Harness = { store: Store; reset: () => Promise<void>; close?: () => Promise<void> };

async function prismaHarness(): Promise<Harness> {
  const { prisma } = await import("../src/db/prisma.js");
  const { prismaStore } = await import("../src/db/prismaStore.js");
  return {
    store: prismaStore,
    reset: async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE "CredentialHistory", "Credential", "VaultKey", "AuditEvent", "Setting", "PendingDeletion", "UnlockGuard" CASCADE'
      );
    },
    close: () => prisma.$disconnect()
  };
}

function memoryHarness(): Harness {
  const harness: Harness = {
    store: createMemoryStore().store,
    reset: async () => {
      harness.store = createMemoryStore().store;
    }
  };
  return harness;
}

const targets: [string, () => Promise<Harness> | Harness, boolean][] = [
  ["memory", memoryHarness, false],
  ["prisma", prismaHarness, !process.env.TEST_DATABASE_URL]
];

for (const [name, create, skip] of targets) {
  describe(`${name} store`, { skip: skip ? "set TEST_DATABASE_URL to run" : false }, () => {
    let harness: Harness;
    const store = () => harness.store;

    beforeEach(async () => {
      harness ??= await create();
      await harness.reset();
    });

    after(async () => {
      await harness?.close?.();
    });

    const newCredential = (overrides: Partial<Parameters<Store["credentials"]["create"]>[0]> = {}) => ({
      id: randomUUID(),
      service: "Netflix",
      email: "yo@mail.com",
      category: "Streaming",
      passwordSealed: "s1.a.b.c.d",
      ...overrides
    });

    it("creates, reads, lists, updates and removes credentials", async () => {
      const created = await store().credentials.create(newCredential({ aliases: ["nf"], totpSealed: "s1.t" }));
      assert.equal(created.notesSealed, null);
      assert.deepEqual(created.aliases, ["nf"]);
      assert.equal(created.passwordCiphertext, null);
      assert.ok(created.createdAt instanceof Date && created.passwordChangedAt instanceof Date);

      assert.equal((await store().credentials.get(created.id))?.service, "Netflix");
      assert.equal(await store().credentials.get(randomUUID()), null);
      assert.equal((await store().credentials.list()).length, 1);

      const updated = await store().credentials.update(created.id, { service: "Netflix MX", totpSealed: null });
      assert.equal(updated.service, "Netflix MX");
      assert.equal(updated.totpSealed, null);
      assert.ok(updated.updatedAt.getTime() >= created.updatedAt.getTime());

      await store().credentials.remove(created.id);
      assert.equal(await store().credentials.get(created.id), null);
    });

    it("keeps explicit timestamps (restores) and deletes history with its credential", async () => {
      const when = new Date("2020-01-02T03:04:05.000Z");
      const credential = await store().credentials.create(newCredential({ createdAt: when, passwordChangedAt: when }));
      assert.equal(credential.createdAt.toISOString(), when.toISOString());

      await store().history.add(credential.id, "s1.old1", new Date("2021-01-01T00:00:00Z"));
      await store().history.add(credential.id, "s1.old2", new Date("2022-01-01T00:00:00Z"));
      assert.deepEqual((await store().history.list(credential.id)).map((entry) => entry.passwordSealed), ["s1.old2", "s1.old1"]);

      await store().credentials.remove(credential.id);
      assert.deepEqual(await store().history.list(credential.id), []);
    });

    it("stores a single vault key row", async () => {
      assert.equal(await store().vaultKey.get(), null);
      const row = { publicKey: "p", masterSalt: "s", masterKdf: "{}", masterWrap: "w", recoverySalt: "rs", recoveryKdf: "{}", recoveryWrap: "rw" };
      await store().vaultKey.save(row);
      await store().vaultKey.save({ ...row, masterWrap: "w2" });
      assert.deepEqual(await store().vaultKey.get().then((value) => value && { ...value, masterWrap: value.masterWrap }), {
        ...(await store().vaultKey.get())!,
        masterWrap: "w2"
      });
    });

    it("returns audit events newest first", async () => {
      await store().audit.add({ action: "a" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store().audit.add({ action: "b", label: "Netflix", detail: "x" });
      const events = await store().audit.recent(10);
      assert.deepEqual(events.map((event) => event.action), ["b", "a"]);
      assert.equal(events[0].label, "Netflix");
      assert.equal(events[1].credentialId, null);
    });

    it("upserts settings", async () => {
      assert.equal(await store().settings.get("k"), null);
      await store().settings.set("k", "1");
      await store().settings.set("k", "2");
      assert.equal(await store().settings.get("k"), "2");
    });

    it("counts unlock failures, locks and resets", async () => {
      assert.equal(await store().unlockGuard.get("u"), null);
      assert.equal((await store().unlockGuard.increment("u")).failedAttempts, 1);
      assert.equal((await store().unlockGuard.increment("u")).failedAttempts, 2);
      const until = new Date(Date.now() + 60_000);
      await store().unlockGuard.setLock("u", until);
      assert.equal((await store().unlockGuard.get("u"))?.lockedUntil?.toISOString(), until.toISOString());
      await store().unlockGuard.reset("u");
      assert.equal(await store().unlockGuard.get("u"), null);
    });

    it("tracks pending deletions per chat, including large chat ids", async () => {
      const bigChat = 7_000_000_000;
      const soon = new Date(Date.now() + 60_000);
      await store().pendingDeletions.upsert({ chatId: bigChat, messageId: 1, deleteAt: soon });
      await store().pendingDeletions.upsert({ chatId: bigChat, messageId: 1, deleteAt: soon });
      await store().pendingDeletions.upsert({ chatId: 5, messageId: 2, deleteAt: new Date(0) });

      assert.deepEqual(await store().pendingDeletions.listForChat(bigChat), [{ chatId: bigChat, messageId: 1, deleteAt: soon }]);
      await store().pendingDeletions.purgeBefore(new Date(1000));
      assert.equal((await store().pendingDeletions.listAll()).length, 1);
      await store().pendingDeletions.remove(bigChat, 1);
      assert.deepEqual(await store().pendingDeletions.listAll(), []);
    });

    it("answers ping", async () => {
      await store().ping();
    });
  });
}
