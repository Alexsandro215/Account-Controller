import { db } from "../db/index.js";
import type { AuditRow } from "../db/store.js";

export type AuditAction =
  | "setup"
  | "unlock"
  | "unlock_failed"
  | "lockout"
  | "recovery_used"
  | "master_changed"
  | "recovery_rotated"
  | "lock"
  | "reveal"
  | "reveal_category"
  | "reveal_history"
  | "totp"
  | "create"
  | "update"
  | "delete"
  | "import"
  | "backup"
  | "restore"
  | "health";

export const AUDIT_LABELS: Record<AuditAction, string> = {
  setup: "Bóveda configurada",
  unlock: "Bóveda abierta",
  unlock_failed: "Contraseña maestra incorrecta",
  lockout: "Bóveda bloqueada por intentos fallidos",
  recovery_used: "Entrada con código de recuperación",
  master_changed: "Contraseña maestra cambiada",
  recovery_rotated: "Código de recuperación nuevo",
  lock: "Bóveda cerrada",
  reveal: "Contraseña vista",
  reveal_category: "Categoría vista completa",
  reveal_history: "Historial visto",
  totp: "Código 2FA generado",
  create: "Credencial creada",
  update: "Credencial editada",
  delete: "Credencial borrada",
  import: "Importación",
  backup: "Respaldo enviado",
  restore: "Respaldo restaurado",
  health: "Revisión de salud"
};

/** Records an event. Never throws: auditing must not break the action it describes. */
export async function audit(
  action: AuditAction,
  credential?: { id: string; service: string } | null,
  detail?: string
): Promise<void> {
  try {
    await db().audit.add({
      action,
      credentialId: credential?.id ?? null,
      label: credential?.service ?? null,
      detail: detail ?? null
    });
  } catch (error) {
    console.error(`Could not record audit event ${action}`, error);
  }
}

export async function recentActivity(limit = 15): Promise<AuditRow[]> {
  return db().audit.recent(limit);
}

export function auditLabel(action: string): string {
  return AUDIT_LABELS[action as AuditAction] ?? action;
}
