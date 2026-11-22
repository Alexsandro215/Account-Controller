export type VaultErrorCode = "vault_not_ready" | "vault_locked" | "not_found" | "invalid" | "no_totp";

/** Expected failures with a user-facing (Spanish) message. Anything else is a bug. */
export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string = defaultMessages[code]
  ) {
    super(message);
    this.name = "VaultError";
  }
}

const defaultMessages: Record<VaultErrorCode, string> = {
  vault_not_ready: "La bóveda todavía no está configurada.",
  vault_locked: "La bóveda está cerrada.",
  not_found: "No encontré esa credencial.",
  invalid: "Dato inválido.",
  no_totp: "Esta credencial no tiene 2FA."
};

export function isVaultError(error: unknown, code?: VaultErrorCode): error is VaultError {
  return error instanceof VaultError && (code === undefined || error.code === code);
}
