import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export function isAuthorizedTelegramUser(userId: string): boolean {
  return config.AUTHORIZED_TELEGRAM_USER_ID !== "" && userId === config.AUTHORIZED_TELEGRAM_USER_ID;
}

export function isValidPin(input: string): boolean {
  const expected = Buffer.from(config.MASTER_PIN);
  const received = Buffer.from(input.trim());

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}
