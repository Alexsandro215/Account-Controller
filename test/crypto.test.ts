import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveMasterKek,
  deriveRecoveryKek,
  exportPrivateKey,
  generateRecoveryCode,
  generateVaultKeyPair,
  importPrivateKey,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  publicKeyOf,
  RECOVERY_KDF,
  seal,
  unseal,
  unwrap,
  wrap
} from "../src/vault/crypto.js";

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

describe("sealed boxes", () => {
  const { publicKey, privateKey } = generateVaultKeyPair();

  it("round-trips unicode secrets", () => {
    const secret = "contraseña 🔑 <&> \"quotes\"";
    assert.equal(unseal(seal(secret, publicKey, "credential:1:password"), privateKey, "credential:1:password"), secret);
  });

  it("uses a fresh ephemeral key every time", () => {
    assert.notEqual(seal("same", publicKey, "a"), seal("same", publicKey, "a"));
  });

  it("refuses a ciphertext moved to another credential or field (AAD)", () => {
    const sealed = seal("secret", publicKey, "credential:1:password");
    assert.throws(() => unseal(sealed, privateKey, "credential:2:password"));
    assert.throws(() => unseal(sealed, privateKey, "credential:1:notes"));
  });

  it("detects tampering", () => {
    const parts = seal("secret", publicKey, "a").split(".");
    const ciphertext = Buffer.from(parts[4], "base64url");
    ciphertext[0] ^= 1;
    parts[4] = ciphertext.toString("base64url");
    assert.throws(() => unseal(parts.join("."), privateKey, "a"));
  });

  it("cannot be opened with another vault's key", () => {
    const other = generateVaultKeyPair();
    assert.throws(() => unseal(seal("secret", publicKey, "a"), other.privateKey, "a"));
  });

  it("exports and re-imports the private key", () => {
    const again = importPrivateKey(exportPrivateKey(privateKey));
    assert.equal(publicKeyOf(again), publicKeyOf(privateKey));
  });
});

describe("key wrapping and derivation", () => {
  it("unwraps only with the right key-encryption key", async () => {
    const salt = Buffer.alloc(16, 7);
    const right = await deriveMasterKek("frase muy secreta", salt, FAST_KDF, "pepper");
    const wrongPassword = await deriveMasterKek("frase muy secretA", salt, FAST_KDF, "pepper");
    const wrongPepper = await deriveMasterKek("frase muy secreta", salt, FAST_KDF, "other pepper");
    const wrapped = wrap(right, Buffer.from("private key"), "aad");

    assert.equal(unwrap(right, wrapped, "aad")?.toString(), "private key");
    assert.equal(unwrap(wrongPassword, wrapped, "aad"), null);
    assert.equal(unwrap(wrongPepper, wrapped, "aad"), null, "a stolen database is useless without the server secret");
  });

  it("derives the recovery key from the code regardless of formatting", async () => {
    const code = generateRecoveryCode();
    const salt = Buffer.alloc(16, 1);
    const a = await deriveRecoveryKek(code, salt, RECOVERY_KDF);
    const b = await deriveRecoveryKek(code.toLowerCase().replace(/-/g, " "), salt, RECOVERY_KDF);
    assert.deepEqual(a, b);
  });
});

describe("recovery codes", () => {
  it("are 5 groups of 5 Crockford base32 characters", () => {
    const code = generateRecoveryCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    assert.ok(looksLikeRecoveryCode(code));
  });

  it("tolerates common misreadings", () => {
    assert.equal(normalizeRecoveryCode("oIl-u"), "011V");
  });

  it("does not mistake a normal password for a code", () => {
    assert.equal(looksLikeRecoveryCode("mi frase secreta larga"), false);
  });
});
