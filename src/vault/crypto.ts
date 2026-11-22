import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt,
  type KeyObject
} from "node:crypto";

// ---------------------------------------------------------------------------------------
// Sealed boxes: anyone with the vault's public key can encrypt (so credentials can be
// saved while the vault is locked); only the private key can decrypt. Each secret uses
// a fresh ephemeral X25519 key, HKDF-SHA256 and AES-256-GCM. The AAD binds a ciphertext
// to its row and field, so a database attacker cannot swap secrets between credentials.
// ---------------------------------------------------------------------------------------

const SEALED_VERSION = "s1";
const SEAL_INFO = "account-controller/seal/v1";
const WRAP_VERSION = "w1";

export function generateVaultKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("x25519");
}

export function exportPublicKey(key: KeyObject): string {
  return b64u(key.export({ format: "der", type: "spki" }));
}

export function importPublicKey(value: string): KeyObject {
  return createPublicKey({ key: fromB64u(value), format: "der", type: "spki" });
}

export function exportPrivateKey(key: KeyObject): Buffer {
  return key.export({ format: "der", type: "pkcs8" });
}

export function importPrivateKey(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function publicKeyOf(privateKey: KeyObject): string {
  return exportPublicKey(createPublicKey(privateKey));
}

export function seal(plaintext: string, recipient: KeyObject, aad: string): string {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralDer = ephemeral.publicKey.export({ format: "der", type: "spki" });
  const recipientDer = recipient.export({ format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = deriveSealKey(shared, ephemeralDer, recipientDer);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [SEALED_VERSION, b64u(ephemeralDer), b64u(iv), b64u(cipher.getAuthTag()), b64u(ciphertext)].join(".");
}

export function unseal(sealed: string, privateKey: KeyObject, aad: string): string {
  const parts = sealed.split(".");

  if (parts.length !== 5 || parts[0] !== SEALED_VERSION) {
    throw new Error("Unsupported sealed secret format");
  }

  const [, ephemeralB64, ivB64, tagB64, ciphertextB64] = parts;
  const ephemeralDer = fromB64u(ephemeralB64);
  const ephemeral = createPublicKey({ key: ephemeralDer, format: "der", type: "spki" });
  const recipientDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const key = deriveSealKey(shared, ephemeralDer, recipientDer);

  const decipher = createDecipheriv("aes-256-gcm", key, fromB64u(ivB64));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(fromB64u(tagB64));

  return Buffer.concat([decipher.update(fromB64u(ciphertextB64)), decipher.final()]).toString("utf8");
}

function deriveSealKey(shared: Buffer, ephemeralDer: Buffer, recipientDer: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralDer, recipientDer]), SEAL_INFO, 32));
}

// ---------------------------------------------------------------------------------------
// Key wrapping (symmetric) for the vault's private key.
// ---------------------------------------------------------------------------------------

export function wrap(kek: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return [WRAP_VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ciphertext)].join(".");
}

/** Returns null when the key is wrong (authentication fails). */
export function unwrap(kek: Buffer, wrapped: string, aad: string): Buffer | null {
  const parts = wrapped.split(".");

  if (parts.length !== 4 || parts[0] !== WRAP_VERSION) {
    throw new Error("Unsupported wrapped key format");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, fromB64u(parts[1]));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(fromB64u(parts[2]));
    return Buffer.concat([decipher.update(fromB64u(parts[3])), decipher.final()]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Key derivation.
// ---------------------------------------------------------------------------------------

export type KdfParams = { N: number; r: number; p: number };

/** ~64 MB and a few hundred ms per guess: expensive for an attacker, fine for one unlock. */
export const MASTER_KDF: KdfParams = { N: 2 ** 16, r: 8, p: 1 };
/** The recovery code already has 125 bits of entropy; the KDF is just a formality. */
export const RECOVERY_KDF: KdfParams = { N: 2 ** 14, r: 8, p: 1 };

const MASTER_INFO = "account-controller/kek/master/v1";
const RECOVERY_INFO = "account-controller/kek/recovery/v1";

/**
 * Master password → key-encryption key. The server secret (VAULT_MASTER_KEY) is mixed in
 * as a pepper, so a database leak alone does not allow guessing the master password.
 */
export async function deriveMasterKek(password: string, salt: Buffer, params: KdfParams, pepper: string): Promise<Buffer> {
  const stretched = await scryptAsync(password.normalize("NFKC"), salt, params);
  const pepperHash = createHash("sha256").update(pepper, "utf8").digest();
  return Buffer.from(hkdfSync("sha256", stretched, pepperHash, MASTER_INFO, 32));
}

/**
 * Recovery code → key-encryption key. Deliberately independent of the server secret, so
 * the recovery code still opens a backup if VAULT_MASTER_KEY is lost.
 */
export async function deriveRecoveryKek(code: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  const stretched = await scryptAsync(normalizeRecoveryCode(code), salt, params);
  return Buffer.from(hkdfSync("sha256", stretched, Buffer.alloc(0), RECOVERY_INFO, 32));
}

function scryptAsync(secret: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, { ...params, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

// ---------------------------------------------------------------------------------------
// Recovery codes: 25 Crockford base32 characters (125 bits), shown as 5 groups of 5.
// ---------------------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateRecoveryCode(): string {
  const chars = Array.from({ length: 25 }, () => CROCKFORD[randomInt(CROCKFORD.length)]);
  return [0, 5, 10, 15, 20].map((start) => chars.slice(start, start + 5).join("")).join("-");
}

/** Accepts the code with or without dashes/spaces, any case, and common misreadings. */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export function looksLikeRecoveryCode(input: string): boolean {
  const normalized = normalizeRecoveryCode(input);
  return normalized.length === 25 && [...normalized].every((char) => CROCKFORD.includes(char));
}

// ---------------------------------------------------------------------------------------

export function randomSalt(): string {
  return b64u(randomBytes(16));
}

export function b64u(value: Buffer): string {
  return value.toString("base64url");
}

export function fromB64u(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
