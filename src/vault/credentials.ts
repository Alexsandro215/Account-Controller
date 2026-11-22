import { createHash, randomUUID, type KeyObject } from "node:crypto";
import { db } from "../db/index.js";
import type { CredentialPatch, CredentialRow } from "../db/store.js";
import { audit } from "./audit.js";
import { seal, unseal } from "./crypto.js";
import { VaultError } from "./errors.js";
import { vaultPublicKey } from "./keys.js";
import { decryptSecret as decryptLegacy } from "./legacyCrypto.js";
import { foldText } from "./search.js";
import { parseTotpInput, serializeTotp, totpCode } from "./totp.js";
import { requireUnlockedKey } from "./unlock.js";

export type CredentialSummary = {
  id: string;
  service: string;
  email: string;
  category: string;
  aliases: string[];
  hasTotp: boolean;
  hasNotes: boolean;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CredentialInput = {
  category: string;
  service: string;
  email: string;
  password: string;
  notes?: string | null;
  totp?: string | null;
};

export type CredentialUpdate = Partial<{
  category: string;
  service: string;
  email: string;
  password: string;
  notes: string | null;
  totp: string | null;
}>;

type SecretField = "password" | "notes" | "totp";

const LIMITS = { text: 200, password: 1000, notes: 4000 } as const;

/** Binds each ciphertext to its credential and field. */
export function secretAad(credentialId: string, field: SecretField): string {
  return `credential:${credentialId}:${field}`;
}

export function summarize(row: CredentialRow): CredentialSummary {
  return {
    id: row.id,
    service: row.service,
    email: row.email,
    category: row.category,
    aliases: row.aliases,
    hasTotp: row.totpSealed !== null,
    hasNotes: row.notesSealed !== null || row.notes !== null,
    passwordChangedAt: row.passwordChangedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  const rows = await db().credentials.list();

  return rows.map(summarize).sort(
    (a, b) =>
      a.category.localeCompare(b.category, "es", { sensitivity: "base" }) ||
      a.service.localeCompare(b.service, "es", { sensitivity: "base" }) ||
      a.email.localeCompare(b.email, "es", { sensitivity: "base" })
  );
}

export async function getCredential(id: string): Promise<CredentialSummary> {
  return summarize(await getRow(id));
}

async function getRow(id: string): Promise<CredentialRow> {
  const row = await db().credentials.get(id);

  if (!row) {
    throw new VaultError("not_found");
  }

  return row;
}

/** Creating only needs the public key, so it works while the vault is closed. */
export async function createCredential(
  input: CredentialInput,
  options: { audit?: boolean } = {}
): Promise<CredentialSummary> {
  const service = requiredText(input.service, "el servicio");
  const email = requiredText(input.email, "el usuario o correo");
  const password = requiredSecret(input.password);
  const notes = optionalNotes(input.notes);
  const totp = input.totp ? serializeTotp(parseTotpInput(input.totp)) : null;
  const category = await canonicalCategory(requiredText(input.category, "la categoría"));
  const publicKey = await vaultPublicKey();
  const id = randomUUID();

  const row = await db().credentials.create({
    id,
    service,
    email,
    category,
    passwordSealed: seal(password, publicKey, secretAad(id, "password")),
    notesSealed: notes ? seal(notes, publicKey, secretAad(id, "notes")) : null,
    totpSealed: totp ? seal(totp, publicKey, secretAad(id, "totp")) : null
  });

  if (options.audit !== false) {
    await audit("create", row);
  }

  return summarize(row);
}

/** Editing requires the vault to be open: a stolen phone must not be able to wreck it. */
export async function updateCredential(id: string, update: CredentialUpdate): Promise<CredentialSummary> {
  requireUnlockedKey();
  const row = await getRow(id);
  const publicKey = await vaultPublicKey();
  const patch: CredentialPatch = {};
  const changed: string[] = [];

  if (update.service !== undefined) {
    patch.service = requiredText(update.service, "el servicio");
    changed.push("servicio");
  }

  if (update.email !== undefined) {
    patch.email = requiredText(update.email, "el usuario o correo");
    changed.push("usuario");
  }

  if (update.category !== undefined) {
    patch.category = await canonicalCategory(requiredText(update.category, "la categoría"));
    changed.push("categoría");
  }

  // Every field is validated before anything is written: a rejected update must not leave a
  // stray history entry behind.
  let previousPassword: string | null = null;

  if (update.password !== undefined) {
    const password = requiredSecret(update.password);
    previousPassword = row.passwordSealed ?? trySealLegacyPassword(row, publicKey);
    patch.passwordSealed = seal(password, publicKey, secretAad(id, "password"));
    patch.passwordChangedAt = new Date();
    clearLegacy(patch);
    changed.push("contraseña");
  }

  if (update.notes !== undefined) {
    const notes = optionalNotes(update.notes);
    patch.notesSealed = notes ? seal(notes, publicKey, secretAad(id, "notes")) : null;
    patch.notes = null;
    changed.push("notas");
  }

  if (update.totp !== undefined) {
    const totp = update.totp ? serializeTotp(parseTotpInput(update.totp)) : null;
    patch.totpSealed = totp ? seal(totp, publicKey, secretAad(id, "totp")) : null;
    changed.push("2FA");
  }

  if (previousPassword) {
    await db().history.add(id, previousPassword);
  }

  const updated = await db().credentials.update(id, patch);
  await audit("update", updated, changed.join(", "));
  return summarize(updated);
}

export async function deleteCredential(id: string): Promise<void> {
  requireUnlockedKey();
  const row = await getRow(id);
  await db().credentials.remove(id);
  await audit("delete", row, row.email);
}

export async function revealSecrets(id: string): Promise<{ credential: CredentialSummary; password: string; notes: string | null }> {
  const key = requireUnlockedKey();
  const row = await getRow(id);
  const secrets = openSecrets(row, key);
  await audit("reveal", row);
  return { credential: summarize(row), ...secrets };
}

export async function revealCategory(
  category: string
): Promise<{ credential: CredentialSummary; password: string | null }[]> {
  const key = requireUnlockedKey();
  const folded = foldText(category);
  const rows = (await db().credentials.list()).filter((row) => foldText(row.category) === folded);

  if (rows.length > 0) {
    await audit("reveal_category", null, rows[0].category);
  }

  return rows
    .map((row) => ({ credential: summarize(row), password: tryOpenPassword(row, key) }))
    .sort((a, b) => a.credential.service.localeCompare(b.credential.service, "es"));
}

/** Every password, for the health report. */
export async function revealAll(): Promise<{ credential: CredentialSummary; password: string | null }[]> {
  const key = requireUnlockedKey();
  const rows = await db().credentials.list();
  return rows.map((row) => ({ credential: summarize(row), password: tryOpenPassword(row, key) }));
}

export async function currentTotp(
  id: string,
  nowMs = Date.now()
): Promise<{ credential: CredentialSummary; code: string; remainingSeconds: number; period: number }> {
  const key = requireUnlockedKey();
  const row = await getRow(id);

  if (!row.totpSealed) {
    throw new VaultError("no_totp");
  }

  const config = parseTotpInput(unseal(row.totpSealed, key, secretAad(id, "totp")));
  const { code, remainingSeconds } = totpCode(config, nowMs);
  await audit("totp", row);

  return { credential: summarize(row), code, remainingSeconds, period: config.period };
}

export async function passwordHistory(id: string): Promise<{ password: string; replacedAt: Date }[]> {
  const key = requireUnlockedKey();
  const row = await getRow(id);
  const entries = await db().history.list(id);
  await audit("reveal_history", row);

  return entries.map((entry) => ({
    password: unseal(entry.passwordSealed, key, secretAad(id, "password")),
    replacedAt: entry.replacedAt
  }));
}

/** Reuses the spelling of an existing category so "bancos" and "Bancos" do not split. */
export async function canonicalCategory(input: string): Promise<string> {
  const folded = foldText(input);
  const rows = await db().credentials.list();
  const existing = rows
    .filter((row) => foldText(row.category) === folded)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

  return existing?.category ?? input.trim();
}

export type CategorySummary = { name: string; key: string; count: number };

/** Groups case/accent-insensitively; `key` is a short stable id for button callbacks. */
export function groupCategories(items: { category: string }[]): CategorySummary[] {
  const groups = new Map<string, CategorySummary>();

  for (const item of items) {
    const folded = foldText(item.category);
    const group = groups.get(folded);

    if (group) {
      group.count++;
    } else {
      groups.set(folded, { name: item.category, key: categoryKey(item.category), count: 1 });
    }
  }

  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
}

export function categoryKey(category: string): string {
  return createHash("sha256").update(foldText(category)).digest("base64url").slice(0, 10);
}

export function sameCategory(a: string, b: string): boolean {
  return foldText(a) === foldText(b);
}

/**
 * Seals credentials stored in the pre-upgrade format (server key only). Needs just the
 * public key, so it runs right after setup and on every start. Returns how many failed.
 */
export async function migrateLegacyCredentials(): Promise<{ migrated: number; failed: number }> {
  const legacy = (await db().credentials.list()).filter((row) => row.passwordSealed === null);

  if (legacy.length === 0) {
    return { migrated: 0, failed: 0 };
  }

  const publicKey = await vaultPublicKey();
  let migrated = 0;
  let failed = 0;

  for (const row of legacy) {
    try {
      if (!row.passwordCiphertext || !row.passwordIv || !row.passwordAuthTag) {
        throw new Error("Credential has no password at all");
      }

      const password = decryptLegacy({
        ciphertext: row.passwordCiphertext,
        iv: row.passwordIv,
        authTag: row.passwordAuthTag
      });
      const patch: CredentialPatch = { passwordSealed: seal(password, publicKey, secretAad(row.id, "password")) };
      clearLegacy(patch);

      if (row.notes) {
        patch.notesSealed = seal(row.notes, publicKey, secretAad(row.id, "notes"));
        patch.notes = null;
      }

      await db().credentials.update(row.id, patch);
      migrated++;
    } catch (error) {
      failed++;
      console.error(`Could not migrate legacy credential ${row.id}`, error);
    }
  }

  return { migrated, failed };
}

function openSecrets(row: CredentialRow, key: KeyObject): { password: string; notes: string | null } {
  const password = openPassword(row, key);
  const notes = row.notesSealed ? unseal(row.notesSealed, key, secretAad(row.id, "notes")) : row.notes;
  return { password, notes };
}

function openPassword(row: CredentialRow, key: KeyObject): string {
  if (row.passwordSealed) {
    return unseal(row.passwordSealed, key, secretAad(row.id, "password"));
  }

  if (row.passwordCiphertext && row.passwordIv && row.passwordAuthTag) {
    return decryptLegacy({ ciphertext: row.passwordCiphertext, iv: row.passwordIv, authTag: row.passwordAuthTag });
  }

  throw new Error(`Credential ${row.id} has no password`);
}

export function sealLegacyPassword(row: CredentialRow, publicKey: KeyObject): string | null {
  if (!row.passwordCiphertext || !row.passwordIv || !row.passwordAuthTag) {
    return null;
  }

  const password = decryptLegacy({ ciphertext: row.passwordCiphertext, iv: row.passwordIv, authTag: row.passwordAuthTag });
  return seal(password, publicKey, secretAad(row.id, "password"));
}

/** Like sealLegacyPassword, but an unreadable legacy password just yields no history entry. */
function trySealLegacyPassword(row: CredentialRow, publicKey: KeyObject): string | null {
  try {
    return sealLegacyPassword(row, publicKey);
  } catch (error) {
    console.error(`Could not read legacy password of ${row.id}; replacing it without history`, error);
    return null;
  }
}

function tryOpenPassword(row: CredentialRow, key: KeyObject): string | null {
  try {
    return openPassword(row, key);
  } catch (error) {
    console.error(`Could not open credential ${row.id}`, error);
    return null;
  }
}

function clearLegacy(patch: CredentialPatch): void {
  patch.passwordCiphertext = null;
  patch.passwordIv = null;
  patch.passwordAuthTag = null;
}

function requiredText(value: string, name: string): string {
  const trimmed = (value ?? "").trim();

  if (trimmed === "") {
    throw new VaultError("invalid", `Falta ${name}.`);
  }

  if (trimmed.length > LIMITS.text) {
    throw new VaultError("invalid", `${capitalize(name)} es demasiado largo (máximo ${LIMITS.text} caracteres).`);
  }

  return trimmed;
}

function requiredSecret(value: string): string {
  if (!value || value.trim() === "") {
    throw new VaultError("invalid", "Falta la contraseña.");
  }

  if (value.length > LIMITS.password) {
    throw new VaultError("invalid", "La contraseña es demasiado larga.");
  }

  return value;
}

function optionalNotes(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }

  if (value.length > LIMITS.notes) {
    throw new VaultError("invalid", `Las notas son demasiado largas (máximo ${LIMITS.notes} caracteres).`);
  }

  return value;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
