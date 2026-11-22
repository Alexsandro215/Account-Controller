import { TEST_USER_ID } from "./support/env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { useStore } from "../src/db/index.js";
import { createBackup, openBackupKey, parseBackup, restoreBackup } from "../src/vault/backup.js";
import {
  createCredential,
  currentTotp,
  deleteCredential,
  listCredentials,
  migrateLegacyCredentials,
  passwordHistory,
  revealSecrets,
  updateCredential
} from "../src/vault/credentials.js";
import { isVaultError } from "../src/vault/errors.js";
import { changeMasterPassword, rotateRecoveryCode, setupVault } from "../src/vault/keys.js";
import { encryptSecret } from "../src/vault/legacyCrypto.js";
import { parseTotpInput, totpCode } from "../src/vault/totp.js";
import { attemptUnlock, isUnlocked, lockVault, unlockVault } from "../src/vault/unlock.js";
import { createMemoryStore } from "./support/memoryStore.js";

const MASTER = "mi frase maestra de prueba";
let memory: ReturnType<typeof createMemoryStore>;

function useFreshStore() {
  memory = createMemoryStore();
  useStore(memory.store);
  return memory;
}

const sample = { category: "Streaming", service: "Netflix", email: "yo@mail.com", password: "S3cr3t<&>ñ" };

const isLocked = (error: unknown) => isVaultError(error, "vault_locked");

describe("vault", () => {
  beforeEach(() => {
    lockVault();
    useFreshStore();
  });

  it("stores nothing readable and only reveals secrets once opened", async () => {
    await setupVault(MASTER);
    lockVault();

    const credential = await createCredential({ ...sample, notes: "pregunta: azul" });
    await assert.rejects(revealSecrets(credential.id), isLocked);

    const stored = JSON.stringify([...memory.raw.credentials.values(), memory.raw.getVaultKey()]);
    assert.ok(!stored.includes(sample.password), "password not in the database");
    assert.ok(!stored.includes("azul"), "notes not in the database");
    assert.ok(!stored.includes(MASTER), "master password not in the database");

    const attempt = await attemptUnlock(TEST_USER_ID, MASTER);
    assert.equal(attempt.ok, true);
    assert.deepEqual(
      { password: (await revealSecrets(credential.id)).password, notes: (await revealSecrets(credential.id)).notes },
      { password: sample.password, notes: "pregunta: azul" }
    );
  });

  it("locks itself out after repeated wrong master passwords", async () => {
    await setupVault(MASTER);
    lockVault();

    const first = await attemptUnlock(TEST_USER_ID, "incorrecta 1");
    const second = await attemptUnlock(TEST_USER_ID, "incorrecta 2");
    const third = await attemptUnlock(TEST_USER_ID, "incorrecta 3");

    assert.deepEqual([first, second].map((a) => !a.ok && a.reason === "wrong" && a.remainingAttempts), [2, 1]);
    assert.ok(!third.ok && third.reason === "wrong" && third.lockedUntil, "third failure locks");

    const evenCorrect = await attemptUnlock(TEST_USER_ID, MASTER);
    assert.ok(!evenCorrect.ok && evenCorrect.reason === "locked", "the right password is refused while locked");
    assert.equal(isUnlocked(), false);

    const actions = memory.raw.audit.map((event) => event.action);
    assert.ok(actions.includes("lockout"));
  });

  it("opens with the recovery code, which stops working once rotated", async () => {
    const { recoveryCode } = await setupVault(MASTER);
    lockVault();

    const viaCode = await attemptUnlock(TEST_USER_ID, recoveryCode.toLowerCase());
    assert.ok(viaCode.ok && viaCode.via === "recovery");

    const newCode = await rotateRecoveryCode(viaCode.key);
    lockVault();

    const oldAgain = await attemptUnlock(TEST_USER_ID, recoveryCode);
    assert.equal(oldAgain.ok, false);
    const viaNew = await attemptUnlock(TEST_USER_ID, newCode);
    assert.equal(viaNew.ok, true);
  });

  it("changes the master password without touching credentials", async () => {
    const { privateKey } = await setupVault(MASTER);
    const credential = await createCredential(sample);

    await changeMasterPassword(privateKey, "otra frase maestra nueva");
    lockVault();

    assert.equal((await attemptUnlock(TEST_USER_ID, MASTER)).ok, false);
    assert.equal((await attemptUnlock(TEST_USER_ID, "otra frase maestra nueva")).ok, true);
    assert.equal((await revealSecrets(credential.id)).password, sample.password);
  });

  it("rejects weak master passwords", async () => {
    await assert.rejects(setupVault("corta"), /al menos 10/);
    await assert.rejects(setupVault("aaaaaaaaaaaaaaa"), /repetitiva/);
  });

  it("refuses ciphertexts swapped between credentials", async () => {
    const { privateKey } = await setupVault(MASTER);
    unlockVault(privateKey);
    const a = await createCredential(sample);
    const b = await createCredential({ ...sample, service: "Gmail", password: "otra" });

    const rowA = memory.raw.credentials.get(a.id)!;
    const rowB = memory.raw.credentials.get(b.id)!;
    memory.raw.credentials.set(a.id, { ...rowA, passwordSealed: rowB.passwordSealed });

    await assert.rejects(revealSecrets(a.id));
  });

  it("requires an open vault to edit or delete, and keeps password history", async () => {
    const { privateKey } = await setupVault(MASTER);
    lockVault();
    const credential = await createCredential(sample);

    await assert.rejects(updateCredential(credential.id, { password: "nueva" }), isLocked);
    await assert.rejects(deleteCredential(credential.id), isLocked);

    unlockVault(privateKey);
    const updated = await updateCredential(credential.id, { password: "nueva", category: "streaming" });
    assert.equal(updated.category, "Streaming", "reuses the existing category spelling");
    assert.equal((await revealSecrets(credential.id)).password, "nueva");
    assert.deepEqual((await passwordHistory(credential.id)).map((entry) => entry.password), [sample.password]);

    await deleteCredential(credential.id);
    assert.equal((await listCredentials()).length, 0);
    assert.equal(memory.raw.history.length, 0, "history is deleted with the credential");
  });

  it("generates 2FA codes from the sealed seed", async () => {
    const { privateKey } = await setupVault(MASTER);
    const credential = await createCredential({ ...sample, totp: "JBSWY3DPEHPK3PXP" });
    unlockVault(privateKey);

    const now = Date.UTC(2026, 10, 21, 12, 0, 10);
    const result = await currentTotp(credential.id, now);

    assert.equal(result.code, totpCode(parseTotpInput("JBSWY3DPEHPK3PXP"), now).code);
    assert.equal(result.remainingSeconds, 20);
    await assert.rejects(createCredential({ ...sample, totp: "no es base32 !!" }), /base32/);
  });

  it("migrates credentials saved before the master password existed", async () => {
    const legacy = encryptSecret("clave-vieja");
    const id = "legacy-1";
    await memory.store.credentials.create({ id, service: "BBVA", email: "cliente", category: "Bancos", passwordSealed: "x" });
    memory.raw.credentials.set(id, {
      ...memory.raw.credentials.get(id)!,
      passwordSealed: null,
      notes: "nip 1234",
      passwordCiphertext: legacy.ciphertext,
      passwordIv: legacy.iv,
      passwordAuthTag: legacy.authTag
    });

    const { privateKey } = await setupVault(MASTER);
    assert.deepEqual(await migrateLegacyCredentials(), { migrated: 1, failed: 0 });

    const row = memory.raw.credentials.get(id)!;
    assert.equal(row.passwordCiphertext, null);
    assert.equal(row.notes, null);
    assert.ok(row.passwordSealed?.startsWith("s1."));

    unlockVault(privateKey);
    assert.deepEqual(
      { password: (await revealSecrets(id)).password, notes: (await revealSecrets(id)).notes },
      { password: "clave-vieja", notes: "nip 1234" }
    );
  });

  it("backs up and restores into an empty database, the same vault, but never another vault", async () => {
    const { privateKey, recoveryCode } = await setupVault(MASTER);
    unlockVault(privateKey);
    const kept = await createCredential(sample);
    const removed = await createCredential({ ...sample, service: "Gmail", password: "g-pass", totp: "JBSWY3DPEHPK3PXP" });
    await updateCredential(removed.id, { password: "g-pass-2" });

    const backup = await createBackup();
    const text = backup.content.toString("utf8");
    assert.equal(backup.count, 2);
    assert.ok(!text.includes("Netflix") && !text.includes("yo@mail.com"), "even metadata is encrypted");

    // 1) Same vault: only what is missing comes back.
    await deleteCredential(removed.id);
    const file = parseBackup(text);
    assert.equal(await openBackupKey(file, "no es la clave"), null);
    assert.deepEqual(await restoreBackup(file, (await openBackupKey(file, MASTER))!.key), { added: 1, skipped: 1 });
    assert.equal((await revealSecrets(removed.id)).password, "g-pass-2");
    assert.deepEqual((await passwordHistory(removed.id)).map((entry) => entry.password), ["g-pass"]);

    // 2) Empty database (new server): the backup's keys are adopted; recovery code works.
    lockVault();
    useFreshStore();
    const opened = await openBackupKey(file, recoveryCode);
    assert.ok(opened && opened.via === "recovery");
    const key = opened.key;
    assert.deepEqual(await restoreBackup(file, key), { added: 2, skipped: 0 });
    lockVault();
    assert.equal((await attemptUnlock(TEST_USER_ID, MASTER)).ok, true, "same master password after restore");
    assert.equal((await revealSecrets(kept.id)).password, sample.password);
    assert.ok((await currentTotp(removed.id)).code.match(/^\d{6}$/));

    // 3) A different vault refuses it.
    lockVault();
    useFreshStore();
    await setupVault("una boveda completamente distinta");
    await assert.rejects(restoreBackup(file, key), /otra bóveda/);
  });

  it("serializes concurrent guesses so a burst cannot get past the lockout", async () => {
    await setupVault(MASTER);
    lockVault();

    const guesses = [...Array.from({ length: 12 }, (_, i) => `incorrecta ${i}`), MASTER];
    const results = await Promise.all(guesses.map((guess) => attemptUnlock(TEST_USER_ID, guess)));

    assert.equal(results.filter((result) => result.ok).length, 0, "the right password arrives after the lock");
    assert.equal(memory.raw.guards.get(TEST_USER_ID)?.failedAttempts, 3, "only three guesses were actually tested");
    assert.equal(isUnlocked(), false);
  });

  it("accepts a master password that happens to look like a recovery code", async () => {
    const lookalike = "correct horse battery staple";
    await setupVault(lookalike);
    lockVault();

    const result = await attemptUnlock(TEST_USER_ID, lookalike);
    assert.ok(result.ok && result.via === "master");
  });

  it("keeps backing up and editing when a pre-upgrade row cannot be read", async () => {
    await memory.store.credentials.create({ id: "broken", service: "Viejo", email: "x", category: "X", passwordSealed: "x" });
    memory.raw.credentials.set("broken", {
      ...memory.raw.credentials.get("broken")!,
      passwordSealed: null,
      passwordCiphertext: "AAAA",
      passwordIv: "AAAAAAAAAAAAAAAA",
      passwordAuthTag: "AAAAAAAAAAAAAAAAAAAAAA=="
    });

    const { privateKey } = await setupVault(MASTER);
    assert.deepEqual(await migrateLegacyCredentials(), { migrated: 0, failed: 1 });
    await createCredential(sample);

    const backup = await createBackup();
    assert.deepEqual({ count: backup.count, skipped: backup.skipped }, { count: 1, skipped: 1 });

    unlockVault(privateKey);
    await updateCredential("broken", { password: "por fin una nueva" });
    assert.equal((await revealSecrets("broken")).password, "por fin una nueva");
  });

  it("does not record history for an update that is rejected", async () => {
    const { privateKey } = await setupVault(MASTER);
    unlockVault(privateKey);
    const credential = await createCredential(sample);

    await assert.rejects(updateCredential(credential.id, { password: "nueva", totp: "no es base32 !!" }), /base32/);
    await assert.rejects(updateCredential(credential.id, { password: "nueva", notes: "x".repeat(5000) }), /notas/);

    assert.equal(memory.raw.history.length, 0);
    assert.equal((await revealSecrets(credential.id)).password, sample.password);
  });

  it("validates input", async () => {
    await setupVault(MASTER);
    await assert.rejects(createCredential({ ...sample, service: "   " }), /servicio/);
    await assert.rejects(createCredential({ ...sample, password: "" }), /contraseña/);
    await assert.rejects(revealSecrets(randomUUID()));
  });
});
