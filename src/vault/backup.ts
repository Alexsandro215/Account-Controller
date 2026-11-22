import type { KeyObject } from "node:crypto";
import { db } from "../db/index.js";
import type { VaultKeyRow } from "../db/store.js";
import { audit } from "./audit.js";
import { publicKeyOf, seal, unseal } from "./crypto.js";
import { sealLegacyPassword, secretAad } from "./credentials.js";
import { VaultError } from "./errors.js";
import { adoptVaultKey, isVaultReady, openWithSecret, vaultKeyRow, vaultPublicKey } from "./keys.js";

// A backup is a single JSON file that is safe to keep anywhere (even in the Telegram chat):
// all credentials, metadata included, are sealed with the vault's public key, and the file
// carries the wrapped private key, so it opens with the master password or the recovery code.

export const BACKUP_FORMAT = "account-controller-backup";
const BACKUP_VERSION = 1;
const PAYLOAD_AAD = "account-controller/backup-payload/v1";

type BackupFile = {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  vault: VaultKeyRow;
  payload: string;
};

type BackupCredential = {
  id: string;
  service: string;
  email: string;
  category: string;
  aliases: string[];
  passwordSealed: string;
  notesSealed: string | null;
  totpSealed: string | null;
  passwordChangedAt: string;
  createdAt: string;
  history: { passwordSealed: string; replacedAt: string }[];
};

export async function createBackup(
  now = new Date()
): Promise<{ filename: string; content: Buffer; count: number; skipped: number }> {
  const vault = await vaultKeyRow();
  const publicKey = await vaultPublicKey();
  const rows = await db().credentials.list();
  const credentials: BackupCredential[] = [];
  let skipped = 0;

  for (const row of rows) {
    let passwordSealed: string | null;

    try {
      passwordSealed = row.passwordSealed ?? sealLegacyPassword(row, publicKey);
    } catch (error) {
      // One unreadable pre-upgrade row must not stop every future backup.
      console.error(`Backup skipped unreadable legacy credential ${row.id}`, error);
      passwordSealed = null;
    }

    if (!passwordSealed) {
      skipped++;
      continue;
    }

    const notesSealed = row.notesSealed ?? (row.notes ? seal(row.notes, publicKey, secretAad(row.id, "notes")) : null);
    const history = await db().history.list(row.id);

    credentials.push({
      id: row.id,
      service: row.service,
      email: row.email,
      category: row.category,
      aliases: row.aliases,
      passwordSealed,
      notesSealed,
      totpSealed: row.totpSealed,
      passwordChangedAt: row.passwordChangedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      history: history.map((entry) => ({ passwordSealed: entry.passwordSealed, replacedAt: entry.replacedAt.toISOString() }))
    });
  }

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    vault: {
      publicKey: vault.publicKey,
      masterSalt: vault.masterSalt,
      masterKdf: vault.masterKdf,
      masterWrap: vault.masterWrap,
      recoverySalt: vault.recoverySalt,
      recoveryKdf: vault.recoveryKdf,
      recoveryWrap: vault.recoveryWrap
    },
    payload: seal(JSON.stringify({ credentials }), publicKey, PAYLOAD_AAD)
  };

  await audit("backup", null, `${credentials.length} credenciales`);

  return {
    filename: `boveda-${now.toISOString().slice(0, 10)}.json`,
    content: Buffer.from(JSON.stringify(file, null, 2), "utf8"),
    count: credentials.length,
    skipped
  };
}

export function looksLikeBackup(text: string): boolean {
  return text.includes(`"format"`) && text.includes(BACKUP_FORMAT);
}

export function parseBackup(text: string): BackupFile {
  let parsed: Partial<BackupFile>;

  try {
    parsed = JSON.parse(text) as Partial<BackupFile>;
  } catch {
    throw new VaultError("invalid", "El archivo no es un respaldo válido.");
  }

  const vault = parsed.vault as Partial<VaultKeyRow> | undefined;
  const vaultFields: (keyof VaultKeyRow)[] = [
    "publicKey",
    "masterSalt",
    "masterKdf",
    "masterWrap",
    "recoverySalt",
    "recoveryKdf",
    "recoveryWrap"
  ];

  if (
    parsed.format !== BACKUP_FORMAT ||
    parsed.version !== BACKUP_VERSION ||
    typeof parsed.payload !== "string" ||
    !vault ||
    vaultFields.some((field) => typeof vault[field] !== "string")
  ) {
    throw new VaultError("invalid", "El archivo no es un respaldo válido de esta bóveda.");
  }

  return parsed as BackupFile;
}

/**
 * Opens a backup's own key material. ONLY for restoring into an empty database: when a vault
 * exists, the secret must open the vault as it is now (an old backup plus an old, rotated
 * password or recovery code must never open the live vault).
 */
export async function openBackupKey(
  file: BackupFile,
  secret: string
): Promise<{ key: KeyObject; via: "master" | "recovery" } | null> {
  return openWithSecret(secret, true, file.vault);
}

/**
 * Restores into the same vault (adds what is missing, keeps what exists) or into an empty
 * database (adopts the backup's keys). Backups from a different vault are refused.
 */
export async function restoreBackup(file: BackupFile, privateKey: KeyObject): Promise<{ added: number; skipped: number }> {
  if (publicKeyOf(privateKey) !== file.vault.publicKey) {
    throw new VaultError("invalid", "La llave no corresponde a este respaldo.");
  }

  const vaultExists = await isVaultReady();

  if (vaultExists && (await vaultKeyRow()).publicKey !== file.vault.publicKey) {
    throw new VaultError(
      "invalid",
      "Este respaldo es de otra bóveda. Solo puedo restaurarlo en esta misma bóveda o en una base de datos vacía."
    );
  }

  // Decrypt before changing anything, so a broken file leaves the database untouched.
  const payload = JSON.parse(unseal(file.payload, privateKey, PAYLOAD_AAD)) as { credentials: BackupCredential[] };

  if (!vaultExists) {
    await adoptVaultKey(file.vault);
  }

  let added = 0;
  let skipped = 0;

  for (const credential of payload.credentials) {
    if (await db().credentials.get(credential.id)) {
      skipped++;
      continue;
    }

    await db().credentials.create({
      id: credential.id,
      service: credential.service,
      email: credential.email,
      category: credential.category,
      aliases: credential.aliases,
      passwordSealed: credential.passwordSealed,
      notesSealed: credential.notesSealed,
      totpSealed: credential.totpSealed,
      passwordChangedAt: new Date(credential.passwordChangedAt),
      createdAt: new Date(credential.createdAt)
    });

    try {
      for (const entry of credential.history) {
        await db().history.add(credential.id, entry.passwordSealed, new Date(entry.replacedAt));
      }
    } catch (error) {
      // Undo this credential so retrying the restore brings it back complete with its history.
      await db().credentials.remove(credential.id).catch(() => undefined);
      throw error;
    }

    added++;
  }

  await audit("restore", null, `${added} agregadas, ${skipped} ya existían`);
  return { added, skipped };
}
