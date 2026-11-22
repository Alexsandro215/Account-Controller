import { createHmac } from "node:crypto";
import { VaultError } from "./errors.js";

// Time-based one-time passwords (RFC 6238), compatible with Google Authenticator & co.

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export type TotpConfig = {
  secret: string; // base32, normalized (uppercase, no padding/spaces)
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = normalizeSecret(input);
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of clean) {
    const index = BASE32.indexOf(char);

    if (index === -1) {
      throw new VaultError("invalid", "El secreto 2FA no es válido (debe ser base32: letras A-Z y números 2-7).");
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }

  return Buffer.from(bytes);
}

function normalizeSecret(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
}

/** Accepts an otpauth://totp/... URI (what QR codes contain) or a bare base32 secret. */
export function parseTotpInput(input: string): TotpConfig {
  const text = input.trim();

  if (/^otpauth:\/\//i.test(text)) {
    return parseOtpauthUri(text);
  }

  return validated({ secret: normalizeSecret(text), algorithm: "SHA1", digits: 6, period: 30 });
}

function parseOtpauthUri(text: string): TotpConfig {
  let url: URL;

  try {
    url = new URL(text);
  } catch {
    throw new VaultError("invalid", "El enlace otpauth:// no es válido.");
  }

  if (url.hostname.toLowerCase() !== "totp") {
    throw new VaultError("invalid", "Solo se admiten códigos por tiempo (TOTP), no por contador (HOTP).");
  }

  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const [labelIssuer, account] = label.includes(":") ? label.split(/:(.*)/s, 2) : [undefined, label];
  const params = url.searchParams;
  const algorithm = (params.get("algorithm") ?? "SHA1").toUpperCase();

  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") {
    throw new VaultError("invalid", `Algoritmo 2FA no soportado: ${algorithm}.`);
  }

  return validated({
    secret: normalizeSecret(params.get("secret") ?? ""),
    algorithm,
    digits: Number(params.get("digits") ?? 6),
    period: Number(params.get("period") ?? 30),
    issuer: params.get("issuer") ?? labelIssuer?.trim() ?? undefined,
    account: account?.trim() || undefined
  });
}

function validated(config: TotpConfig): TotpConfig {
  if (config.secret === "") {
    throw new VaultError("invalid", "Falta el secreto 2FA.");
  }

  if (base32Decode(config.secret).length < 8) {
    throw new VaultError("invalid", "El secreto 2FA es demasiado corto.");
  }

  if (!Number.isInteger(config.digits) || config.digits < 6 || config.digits > 8) {
    throw new VaultError("invalid", "El 2FA debe ser de 6 a 8 dígitos.");
  }

  if (!Number.isInteger(config.period) || config.period < 10 || config.period > 300) {
    throw new VaultError("invalid", "El período del 2FA debe estar entre 10 y 300 segundos.");
  }

  return config;
}

/** Stored (sealed) as a URI so all parameters survive. */
export function serializeTotp(config: TotpConfig): string {
  const label = [config.issuer, config.account].filter(Boolean).join(":") || "cuenta";
  const params = new URLSearchParams({
    secret: config.secret,
    algorithm: config.algorithm,
    digits: String(config.digits),
    period: String(config.period)
  });

  if (config.issuer) {
    params.set("issuer", config.issuer);
  }

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function totpCode(config: TotpConfig, nowMs = Date.now()): { code: string; remainingSeconds: number } {
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / config.period);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac(config.algorithm.toLowerCase(), base32Decode(config.secret)).update(counterBytes).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  const code = String(binary % 10 ** config.digits).padStart(config.digits, "0");

  return { code, remainingSeconds: config.period - (seconds % config.period) };
}

export function formatTotpCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
