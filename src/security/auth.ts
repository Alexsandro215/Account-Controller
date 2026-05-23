import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export function isAuthorizedPhone(phone: string): boolean {
  return phone === config.AUTHORIZED_PHONE;
}

export function isValidPin(input: string): boolean {
  const expected = Buffer.from(config.MASTER_PIN);
  const received = Buffer.from(input.trim());

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}
