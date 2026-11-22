import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base32Decode, parseTotpInput, serializeTotp, totpCode } from "../src/vault/totp.js";

// RFC 6238 appendix B test vectors (8 digits, period 30).
const SEEDS = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234"
} as const;

const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1234567890, "89005924", "91819424", "93441116"],
  [20000000000, "65353130", "77737706", "47863826"]
];

function base32(text: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of Buffer.from(text)) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

describe("totpCode", () => {
  for (const [time, sha1, sha256, sha512] of VECTORS) {
    it(`matches RFC 6238 at T=${time}`, () => {
      for (const [algorithm, expected] of [["SHA1", sha1], ["SHA256", sha256], ["SHA512", sha512]] as const) {
        const config = { secret: base32(SEEDS[algorithm]), algorithm, digits: 8, period: 30 };
        assert.equal(totpCode(config, time * 1000).code, expected, algorithm);
      }
    });
  }

  it("reports the seconds left in the period", () => {
    const config = parseTotpInput("JBSWY3DPEHPK3PXP");
    assert.equal(totpCode(config, 59_000).remainingSeconds, 1);
    assert.equal(totpCode(config, 60_000).remainingSeconds, 30);
  });
});

describe("parseTotpInput", () => {
  it("accepts a bare secret with spaces and lowercase", () => {
    const config = parseTotpInput("jbsw y3dp ehpk 3pxp");
    assert.equal(config.secret, "JBSWY3DPEHPK3PXP");
    assert.equal(config.digits, 6);
  });

  it("reads every parameter of an otpauth URI", () => {
    const config = parseTotpInput(
      "otpauth://totp/GitHub:yo%40mail.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60"
    );
    assert.deepEqual(config, {
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA256",
      digits: 8,
      period: 60,
      issuer: "GitHub",
      account: "yo@mail.com"
    });
    assert.deepEqual(parseTotpInput(serializeTotp(config)), config);
  });

  it("rejects HOTP, bad base32 and short secrets", () => {
    assert.throws(() => parseTotpInput("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1"), /TOTP/);
    assert.throws(() => parseTotpInput("not base32 !!"), /base32/);
    assert.throws(() => parseTotpInput("JBSW"), /corto/);
  });

  it("decodes base32", () => {
    assert.equal(base32Decode("JBSWY3DP").toString(), "Hello");
  });
});
