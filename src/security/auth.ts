import { config } from "../config.js";

export function isVaultConfigured(): boolean {
  return config.AUTHORIZED_TELEGRAM_USER_ID !== "";
}

export function isAuthorizedTelegramUser(userId: string): boolean {
  return isVaultConfigured() && userId === config.AUTHORIZED_TELEGRAM_USER_ID;
}
