import type { KeyObject } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db/index.js";
import type { VaultKeyRow } from "../db/store.js";
import {
  deriveMasterKek,
  deriveRecoveryKek,
  exportPrivateKey,
  fromB64u,
  generateRecoveryCode,
  generateVaultKeyPair,
  importPrivateKey,
  importPublicKey,
  looksLikeRecoveryCode,
  MASTER_KDF,
  publicKeyOf,
  randomSalt,
  RECOVERY_KDF,
  unwrap,
  wrap,
  type KdfParams
} from "./crypto.js";
import { VaultError } from "./errors.js";

const PRIVATE_KEY_AAD = "account-controller/vault-private-key";
export const MIN_MASTER_PASSWORD_LENGTH = 10;

let publicKeyCache: { raw: string; key: KeyObject } | undefined;

export async function isVaultReady(): Promise<boolean> {
  return (await db().vaultKey.get()) !== null;
}

export async function vaultKeyRow(): Promise<VaultKeyRow> {
  const row = await db().vaultKey.get();

  if (!row) {
    throw new VaultError("vault_not_ready");
  }

  return row;
}

export async function vaultPublicKey(): Promise<KeyObject> {
  const row = await vaultKeyRow();

  if (publicKeyCache?.raw !== row.publicKey) {
    publicKeyCache = { raw: row.publicKey, key: importPublicKey(row.publicKey) };
  }

  return publicKeyCache.key;
}

/** Returns an error message in Spanish, or null if the password is acceptable. */
export function masterPasswordProblem(password: string): string | null {
  if ([...password].length < MIN_MASTER_PASSWORD_LENGTH) {
    return `Debe tener al menos ${MIN_MASTER_PASSWORD_LENGTH} caracteres. Una frase de varias palabras es ideal.`;
  }

  if (new Set(password).size < 4) {
    return "Es demasiado repetitiva. Usa una frase o mezcla caracteres.";
  }

  return null;
}

/** Creates the key pair and the recovery code. The caller shows the code to the user once. */
export async function setupVault(masterPassword: string): Promise<{ privateKey: KeyObject; recoveryCode: string }> {
  if (await isVaultReady()) {
    throw new VaultError("invalid", "La bóveda ya está configurada.");
  }

  const problem = masterPasswordProblem(masterPassword);

  if (problem) {
    throw new VaultError("invalid", problem);
  }

  const { privateKey } = generateVaultKeyPair();
  const recoveryCode = generateRecoveryCode();
  await db().vaultKey.save(await buildVaultKeyRow(privateKey, masterPassword, recoveryCode));

  return { privateKey, recoveryCode };
}

export async function buildVaultKeyRow(
  privateKey: KeyObject,
  masterPassword: string,
  recoveryCode: string
): Promise<VaultKeyRow> {
  const der = exportPrivateKey(privateKey);
  const masterSalt = randomSalt();
  const recoverySalt = randomSalt();
  const masterKek = await deriveMasterKek(masterPassword, fromB64u(masterSalt), MASTER_KDF, config.VAULT_MASTER_KEY);
  const recoveryKek = await deriveRecoveryKek(recoveryCode, fromB64u(recoverySalt), RECOVERY_KDF);

  return {
    publicKey: publicKeyOf(privateKey),
    masterSalt,
    masterKdf: JSON.stringify(MASTER_KDF),
    masterWrap: wrap(masterKek, der, PRIVATE_KEY_AAD),
    recoverySalt,
    recoveryKdf: JSON.stringify(RECOVERY_KDF),
    recoveryWrap: wrap(recoveryKek, der, PRIVATE_KEY_AAD)
  };
}

/** Null when the password is wrong. `row` lets a backup's key material be tried. */
export async function openWithMasterPassword(password: string, row?: VaultKeyRow): Promise<KeyObject | null> {
  const keyRow = row ?? (await vaultKeyRow());
  const kek = await deriveMasterKek(
    password,
    fromB64u(keyRow.masterSalt),
    parseKdf(keyRow.masterKdf),
    config.VAULT_MASTER_KEY
  );
  const der = unwrap(kek, keyRow.masterWrap, PRIVATE_KEY_AAD);

  return der ? importPrivateKey(der) : null;
}

export async function openWithRecoveryCode(code: string, row?: VaultKeyRow): Promise<KeyObject | null> {
  const keyRow = row ?? (await vaultKeyRow());
  const kek = await deriveRecoveryKek(code, fromB64u(keyRow.recoverySalt), parseKdf(keyRow.recoveryKdf));
  const der = unwrap(kek, keyRow.recoveryWrap, PRIVATE_KEY_AAD);

  return der ? importPrivateKey(der) : null;
}

/**
 * Opens with a recovery code or a master password. A master password can look exactly like a
 * recovery code (25 letters/digits), so when the code fails the master password is tried too.
 */
export async function openWithSecret(
  secret: string,
  allowRecovery: boolean,
  row?: VaultKeyRow
): Promise<{ key: KeyObject; via: "master" | "recovery" } | null> {
  if (allowRecovery && looksLikeRecoveryCode(secret)) {
    const key = await openWithRecoveryCode(secret, row);

    if (key) {
      return { key, via: "recovery" };
    }
  }

  const key = await openWithMasterPassword(secret, row);
  return key ? { key, via: "master" } : null;
}

/** Re-wraps the private key with a new master password. No credential is re-encrypted. */
export async function changeMasterPassword(privateKey: KeyObject, newPassword: string): Promise<void> {
  const problem = masterPasswordProblem(newPassword);

  if (problem) {
    throw new VaultError("invalid", problem);
  }

  const row = await vaultKeyRowFor(privateKey);
  const masterSalt = randomSalt();
  const kek = await deriveMasterKek(newPassword, fromB64u(masterSalt), MASTER_KDF, config.VAULT_MASTER_KEY);

  await db().vaultKey.save({
    ...row,
    masterSalt,
    masterKdf: JSON.stringify(MASTER_KDF),
    masterWrap: wrap(kek, exportPrivateKey(privateKey), PRIVATE_KEY_AAD)
  });
}

/** Issues a new recovery code; the previous one stops working. */
export async function rotateRecoveryCode(privateKey: KeyObject): Promise<string> {
  const row = await vaultKeyRowFor(privateKey);
  const recoveryCode = generateRecoveryCode();
  const recoverySalt = randomSalt();
  const kek = await deriveRecoveryKek(recoveryCode, fromB64u(recoverySalt), RECOVERY_KDF);

  await db().vaultKey.save({
    ...row,
    recoverySalt,
    recoveryKdf: JSON.stringify(RECOVERY_KDF),
    recoveryWrap: wrap(kek, exportPrivateKey(privateKey), PRIVATE_KEY_AAD)
  });

  return recoveryCode;
}

/** Used when restoring a backup into an empty database. */
export async function adoptVaultKey(row: VaultKeyRow): Promise<void> {
  if (await isVaultReady()) {
    throw new VaultError("invalid", "Ya hay una bóveda configurada.");
  }

  await db().vaultKey.save(row);
}

async function vaultKeyRowFor(privateKey: KeyObject): Promise<VaultKeyRow> {
  const row = await vaultKeyRow();

  if (publicKeyOf(privateKey) !== row.publicKey) {
    throw new Error("Private key does not belong to this vault");
  }

  return row;
}

function parseKdf(value: string): KdfParams {
  const parsed = JSON.parse(value) as Partial<KdfParams>;

  if (!Number.isInteger(parsed.N) || !Number.isInteger(parsed.r) || !Number.isInteger(parsed.p)) {
    throw new Error("Invalid KDF parameters");
  }

  return parsed as KdfParams;
}
