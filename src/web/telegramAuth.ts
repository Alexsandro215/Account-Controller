import { createHmac, timingSafeEqual } from "node:crypto";

// Validates Telegram Mini App init data:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// The HMAC key is derived from the bot token, so only Telegram can produce valid data.

export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export function validateInitData(
  initData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = INIT_DATA_MAX_AGE_SECONDS
): { userId: string } | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    return null;
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest();

  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));

  if (!Number.isFinite(authDate) || nowSeconds - authDate > maxAgeSeconds || authDate - nowSeconds > 60) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: number } | null;
    return typeof user?.id === "number" ? { userId: String(user.id) } : null;
  } catch {
    return null;
  }
}

/** Builds valid init data for a user. Only for tests. */
export function signInitDataForTests(botToken: string, userId: number, authDate: number): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "test",
    user: JSON.stringify({ id: userId, first_name: "Test" })
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secretKey).update(dataCheckString).digest("hex"));
  return params.toString();
}
