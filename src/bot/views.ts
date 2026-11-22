import { config } from "../config.js";
import type { AuditRow } from "../db/store.js";
import type { InlineButton, InlineKeyboard } from "../telegram/client.js";
import { auditLabel } from "../vault/audit.js";
import { categoryKey, type CategorySummary, type CredentialSummary } from "../vault/credentials.js";
import { passwordStrength } from "../vault/generator.js";
import type { HealthReport } from "../vault/health.js";
import { MIN_MASTER_PASSWORD_LENGTH } from "../vault/keys.js";
import { formatTotpCode } from "../vault/totp.js";
import { escapeHtml, formatDateTime, formatTime, plural, relativeAge, truncate } from "./text.js";

export type View = { text: string; keyboard?: InlineKeyboard };

const PAGE_SIZE = 8;

export function button(text: string, data: string): InlineButton {
  return { text, callback_data: data };
}

const menuButton = button("🏠 Menú", "m");
const closeButton = button("🗑 Borrar ya", "x");
const cancelButton = button("✖️ Cancelar", "cancel");

// ---------------------------------------------------------------------------------------
// Menu & navigation
// ---------------------------------------------------------------------------------------

export function mainMenuView(state: {
  credentials: number;
  categories: number;
  unlockedUntil?: Date;
}): View {
  const status = state.unlockedUntil
    ? `🔓 Abierta · se cierra sola a las ${formatTime(state.unlockedUntil)} si no la usas`
    : "🔒 Cerrada";

  const keyboard: InlineKeyboard = [
    [button("📂 Categorías", "cats:0"), button("🔎 Buscar", "srch")],
    [button("➕ Nueva", "new"), button("🎲 Generar", "gen")],
    [button("🩺 Salud", "hl"), button("📜 Actividad", "act")],
    [button("💾 Respaldo", "bk"), button("⚙️ Ajustes", "set")],
    [state.unlockedUntil ? button("🔒 Cerrar bóveda", "lock") : button("🔓 Abrir bóveda", "unlock")]
  ];

  if (config.WEBAPP_URL) {
    keyboard.push([{ text: "📱 Abrir app", web_app: { url: config.WEBAPP_URL } }]);
  }

  return {
    text: [
      "🔐 <b>Tu bóveda</b>",
      `${plural(state.credentials, "credencial", "credenciales")} en ${plural(state.categories, "categoría")}`,
      status,
      "",
      "Escribe el nombre de un servicio para buscarlo, o usa los botones."
    ].join("\n"),
    keyboard
  };
}

export function settingsView(): View {
  return {
    text: "⚙️ <b>Ajustes</b>",
    keyboard: [
      [button("🔑 Cambiar contraseña maestra", "chm")],
      [button("♻️ Nuevo código de recuperación", "rot")],
      [button("📥 Importar desde otro gestor", "imp")],
      [menuButton]
    ]
  };
}

export function importHelpView(): View {
  return {
    text: [
      "📥 <b>Importar contraseñas</b>",
      "",
      "Exporta tus contraseñas como <b>CSV</b> desde Chrome, Edge, Brave, Firefox, Bitwarden, 1Password o KeePass y mándame el archivo aquí como documento.",
      "",
      "• Lo borro del chat en cuanto lo leo.",
      "• No duplico lo que ya tienes (mismo servicio y usuario).",
      "• Después borra también el CSV de tu dispositivo: trae tus contraseñas sin cifrar.",
      "",
      "Para restaurar un <b>respaldo</b> de esta bóveda, mándame el archivo .json igual."
    ].join("\n"),
    keyboard: [[menuButton]]
  };
}

export function categoriesView(categories: CategorySummary[], page: number): View {
  if (categories.length === 0) {
    return {
      text: "📂 Aún no hay categorías. Crea tu primera credencial.",
      keyboard: [[button("➕ Nueva", "new")], [menuButton]]
    };
  }

  const { items, nav, label } = paginate(categories, page, (target) => `cats:${target}`);

  return {
    text: `📂 <b>Categorías</b>${label}`,
    keyboard: [
      ...items.map((category) => [button(`${truncate(category.name, 40)} (${category.count})`, `cat:${category.key}:0`)]),
      ...nav,
      [menuButton]
    ]
  };
}

export function categoryView(category: string, credentials: CredentialSummary[], page: number): View {
  const key = categoryKey(category);
  const { items, nav, label } = paginate(credentials, page, (target) => `cat:${key}:${target}`);

  return {
    text: `📂 <b>${escapeHtml(category)}</b> · ${plural(credentials.length, "credencial", "credenciales")}${label}`,
    keyboard: [
      ...items.map((credential) => [button(credentialLabel(credential), `cr:${credential.id}`)]),
      ...nav,
      [button("👁 Ver todas las contraseñas", `rvc:${key}`)],
      [button("⬅️ Categorías", "cats:0"), menuButton]
    ]
  };
}

export function credentialView(credential: CredentialSummary, now = new Date()): View {
  const lines = [
    `🔑 <b>${escapeHtml(credential.service)}</b>`,
    `👤 <code>${escapeHtml(credential.email)}</code>`,
    `📂 ${escapeHtml(credential.category)}`,
    "🔒 Contraseña: ••••••••",
    `🕒 Cambiada ${relativeAge(credential.passwordChangedAt, now)}`
  ];

  if (credential.hasTotp) lines.push("🔢 2FA activado");
  if (credential.hasNotes) lines.push("📝 Tiene notas");

  const firstRow = [button("👁 Mostrar contraseña", `rv:${credential.id}`)];

  if (credential.hasTotp) {
    firstRow.push(button("🔢 Código 2FA", `otp:${credential.id}`));
  }

  return {
    text: lines.join("\n"),
    keyboard: [
      firstRow,
      [button("✏️ Editar", `ed:${credential.id}`), button("🗑 Borrar", `del:${credential.id}`)],
      [button("🕘 Contraseñas anteriores", `hs:${credential.id}`)],
      [button(`⬅️ ${truncate(credential.category, 20)}`, `cat:${categoryKey(credential.category)}:0`), menuButton]
    ]
  };
}

export function editMenuView(credential: CredentialSummary): View {
  const id = credential.id;
  const totpRow = credential.hasTotp
    ? [button("🔢 Cambiar 2FA", `ef:${id}:t`), button("❌ Quitar 2FA", `et:${id}`)]
    : [button("🔢 Agregar 2FA", `ef:${id}:t`)];

  return {
    text: `✏️ <b>Editar ${escapeHtml(credential.service)}</b>\n¿Qué quieres cambiar?`,
    keyboard: [
      [button("Servicio", `ef:${id}:s`), button("Usuario", `ef:${id}:u`)],
      [button("Contraseña", `ef:${id}:p`), button("🎲 Generar nueva", `eg:${id}`)],
      [button("Categoría", `ef:${id}:c`), button("Notas", `ef:${id}:n`)],
      totpRow,
      [button("⬅️ Volver", `cr:${id}`)]
    ]
  };
}

export function confirmDeleteView(credential: CredentialSummary): View {
  return {
    text: `🗑 ¿Borrar <b>${escapeHtml(credential.service)}</b> (${escapeHtml(credential.email)})?\nNo se puede deshacer (salvo desde un respaldo).`,
    keyboard: [[button("Sí, borrar", `dy:${credential.id}`), button("No", `cr:${credential.id}`)]]
  };
}

/**
 * The query is never repeated back: if a secret was typed where the bot expected a search,
 * echoing it would leave it in the chat in a message that does not self-destruct.
 */
export function searchResultsView(results: CredentialSummary[], deletedQuery = false): View {
  if (results.length === 0) {
    return {
      text: deletedQuery
        ? "🔎 No encontré nada. Por si era una contraseña, borré tu mensaje."
        : "🔎 No encontré nada con eso.",
      keyboard: [[button("🔎 Buscar otra cosa", "srch"), button("➕ Nueva", "new")], [menuButton]]
    };
  }

  const shown = results.slice(0, 10);
  const more = results.length > shown.length ? `\nMuestro las primeras ${shown.length}; afina la búsqueda para ver otras.` : "";

  return {
    text: `🔎 <b>${plural(results.length, "resultado")}</b>${more}`,
    keyboard: [
      ...shown.map((credential) => [button(credentialLabel(credential, true), `cr:${credential.id}`)]),
      [button("🔎 Buscar otra cosa", "srch"), menuButton]
    ]
  };
}

/** The classic text listing ("categorias" / "1"), grouped by category. */
export function categoryTreeView(credentials: CredentialSummary[], categories: CategorySummary[]): View {
  if (credentials.length === 0) {
    return { text: "Aún no hay categorías guardadas.", keyboard: [[button("➕ Nueva", "new")], [menuButton]] };
  }

  const lines = ["<b>Categorías:</b>"];

  for (const category of categories) {
    lines.push("", `-----${escapeHtml(category.name)}-----`);

    for (const credential of credentials.filter((item) => categoryKey(item.category) === category.key)) {
      const prefix = credential.service !== category.name ? `${escapeHtml(credential.service)} · ` : "";
      lines.push(`${prefix}${escapeHtml(credential.email)}`);
    }
  }

  return { text: lines.join("\n"), keyboard: [[button("📂 Ver con botones", "cats:0"), menuButton]] };
}

// ---------------------------------------------------------------------------------------
// Secrets (always sent as self-destructing messages)
// ---------------------------------------------------------------------------------------

export function revealView(credential: CredentialSummary, password: string, notes: string | null): View {
  const lines = [
    `🔑 <b>${escapeHtml(credential.service)}</b>`,
    `👤 <code>${escapeHtml(credential.email)}</code>`,
    `🔒 <code>${escapeHtml(password)}</code>`
  ];

  if (notes) {
    lines.push("", `📝 ${escapeHtml(notes)}`);
  }

  lines.push("", selfDestructNote());
  return { text: lines.join("\n"), keyboard: [[closeButton]] };
}

export function revealCategoryView(
  category: string,
  entries: { credential: CredentialSummary; password: string | null }[]
): View {
  const lines = [`👁 <b>${escapeHtml(category)}</b>`, ""];

  for (const { credential, password } of entries) {
    lines.push(`<b>${escapeHtml(credential.service)}</b> · ${escapeHtml(credential.email)}`);
    lines.push(password === null ? "🔒 (no se pudo descifrar)" : `🔒 <code>${escapeHtml(password)}</code>`);
    lines.push("");
  }

  lines.push(selfDestructNote());
  return { text: lines.join("\n"), keyboard: [[closeButton]] };
}

export function historyView(credential: CredentialSummary, entries: { password: string; replacedAt: Date }[]): View {
  if (entries.length === 0) {
    return { text: `🕘 <b>${escapeHtml(credential.service)}</b> no tiene contraseñas anteriores.`, keyboard: [[closeButton]] };
  }

  const lines = [`🕘 <b>Contraseñas anteriores de ${escapeHtml(credential.service)}</b>`, ""];

  for (const entry of entries.slice(0, 10)) {
    lines.push(`<code>${escapeHtml(entry.password)}</code> · reemplazada ${relativeAge(entry.replacedAt)}`);
  }

  lines.push("", selfDestructNote());
  return { text: lines.join("\n"), keyboard: [[closeButton]] };
}

export function totpView(credential: CredentialSummary, code: string, remainingSeconds: number): View {
  return {
    text: [
      `🔢 <b>${escapeHtml(credential.service)}</b>`,
      `<code>${formatTotpCode(code)}</code>`,
      `Válido por ${remainingSeconds} s · toca el código para copiarlo`
    ].join("\n"),
    keyboard: [[button("🔄 Actualizar", `otpr:${credential.id}`), closeButton]]
  };
}

export function generatorView(password: string, length: number, symbols: boolean): View {
  const strength = passwordStrength(password);
  const sizes = [16, 20, 24, 32].map((size) =>
    button(size === length ? `· ${size} ·` : String(size), `g:${size}:${symbols ? 1 : 0}`)
  );

  return {
    text: [
      "🎲 <b>Contraseña generada</b>",
      `<code>${escapeHtml(password)}</code>`,
      `${length} caracteres · ${symbols ? "con" : "sin"} símbolos · ${strength.label}`,
      "",
      "Toca la contraseña para copiarla. " + selfDestructNote()
    ].join("\n"),
    keyboard: [
      [button("🔄 Otra", `g:${length}:${symbols ? 1 : 0}`), button(symbols ? "Sin símbolos" : "Con símbolos", `g:${length}:${symbols ? 0 : 1}`)],
      sizes,
      [closeButton]
    ]
  };
}

export function recoveryCodeView(code: string, intro: string): View {
  return {
    text: [
      intro,
      "",
      "🧾 <b>Código de recuperación</b>",
      `<code>${escapeHtml(code)}</code>`,
      "",
      "Anótalo en papel y guárdalo en un lugar seguro. Es la única forma de entrar si olvidas tu contraseña maestra, y también abre tus respaldos.",
      "Este mensaje se borra solo en 10 minutos."
    ].join("\n"),
    keyboard: [[button("✅ Ya lo anoté", "x")]]
  };
}

function selfDestructNote(): string {
  return `⏱ Se borra solo en ${config.SENSITIVE_MESSAGE_TTL_SECONDS} s (o escribe . para borrarlo ya).`;
}

// ---------------------------------------------------------------------------------------
// Vault setup / unlock prompts
// ---------------------------------------------------------------------------------------

export function setupIntroView(): View {
  return {
    text: [
      "🔐 <b>Configura tu bóveda</b>",
      "",
      "Tus contraseñas ahora se protegen con una <b>contraseña maestra</b> que solo tú sabes: sin ella, ni el servidor ni quien robe la base de datos puede leerlas.",
      "",
      `• Mínimo ${MIN_MASTER_PASSWORD_LENGTH} caracteres. Una frase de varias palabras es ideal y fácil de recordar.`,
      "• Te daré un código de recuperación por si la olvidas.",
      "",
      "Escribe tu contraseña maestra (borraré tu mensaje)."
    ].join("\n")
  };
}

export function unlockPromptView(): View {
  return {
    text: "🔒 La bóveda está cerrada. Escribe tu <b>contraseña maestra</b> para abrirla (borraré tu mensaje).",
    keyboard: [[button("Olvidé mi contraseña", "rec"), cancelButton]]
  };
}

export function lockedOutText(until: Date): string {
  return `⛔ La bóveda está bloqueada por intentos fallidos. Intenta de nuevo después de las ${formatTime(until)}.`;
}

export function cancelKeyboard(extra: InlineButton[] = []): InlineKeyboard {
  return extra.length > 0 ? [extra, [cancelButton]] : [[cancelButton]];
}

// ---------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------

export function healthView(report: HealthReport): View {
  if (report.total === 0) {
    return { text: "🩺 Aún no hay contraseñas que revisar.", keyboard: [[menuButton]] };
  }

  const emoji = report.score >= 80 ? "💚" : report.score >= 50 ? "💛" : "❤️‍🩹";
  const lines = [`🩺 <b>Salud de tus contraseñas: ${report.score}/100</b> ${emoji}`];
  const name = (credential: CredentialSummary) =>
    `${escapeHtml(credential.service)} (${escapeHtml(truncate(credential.email, 30))})`;
  const urgent: CredentialSummary[] = [];

  if (report.pwned === null) {
    lines.push("", "🌐 No pude revisar filtraciones en línea esta vez.");
  } else if (report.pwned.length > 0) {
    lines.push("", `🚨 <b>Filtradas (${report.pwned.length})</b>: aparecen en hackeos conocidos. Cámbialas ya.`);
    for (const entry of report.pwned.slice(0, 10)) {
      lines.push(`• ${name(entry.credential)}: ${entry.count.toLocaleString("es-MX")} veces`);
      urgent.push(entry.credential);
    }
  }

  if (report.reused.length > 0) {
    lines.push("", `♻️ <b>Repetidas (${report.reused.length} grupos)</b>: si cae una, caen todas.`);
    for (const group of report.reused.slice(0, 8)) {
      lines.push(`• ${group.map((credential) => escapeHtml(credential.service)).join(", ")}`);
      urgent.push(...group);
    }
  }

  if (report.weak.length > 0) {
    lines.push("", `⚠️ <b>Débiles (${report.weak.length})</b>`);
    for (const entry of report.weak.slice(0, 10)) {
      lines.push(`• ${name(entry.credential)}: ${entry.label.toLowerCase()}`);
      urgent.push(entry.credential);
    }
  }

  if (report.old.length > 0) {
    lines.push("", `⏳ <b>Sin cambiar en más de un año (${report.old.length})</b>`);
    for (const entry of report.old.slice(0, 10)) {
      lines.push(`• ${name(entry.credential)}: ${relativeAge(entry.credential.passwordChangedAt)}`);
    }
  }

  if (report.unreadable.length > 0) {
    lines.push("", `❓ <b>No se pudieron descifrar (${report.unreadable.length})</b>`);
  }

  const withProblems = new Set([
    ...(report.pwned ?? []).map((entry) => entry.credential.id),
    ...report.reused.flat().map((credential) => credential.id),
    ...report.weak.map((entry) => entry.credential.id),
    ...report.old.map((entry) => entry.credential.id),
    ...report.unreadable.map((credential) => credential.id)
  ]);
  const clean = report.total - withProblems.size;
  lines.splice(1, 0, `✅ ${clean} de ${report.total} sin problemas`);

  const seen = new Set<string>();
  const buttons = urgent
    .filter((credential) => !seen.has(credential.id) && seen.add(credential.id))
    .slice(0, 6)
    .map((credential) => [button(`Arreglar ${truncate(credential.service, 30)}`, `ed:${credential.id}`)]);

  return { text: lines.join("\n"), keyboard: [...buttons, [menuButton]] };
}

export function activityView(events: AuditRow[]): View {
  if (events.length === 0) {
    return { text: "📜 Aún no hay actividad registrada.", keyboard: [[menuButton]] };
  }

  const lines = ["📜 <b>Actividad reciente</b>", ""];

  for (const event of events) {
    const parts = [formatDateTime(event.at), auditLabel(event.action)];
    if (event.label) parts.push(escapeHtml(event.label));
    if (event.detail) parts.push(escapeHtml(truncate(event.detail, 60)));
    lines.push(parts.join(" · "));
  }

  return { text: lines.join("\n"), keyboard: [[menuButton]] };
}

// ---------------------------------------------------------------------------------------

function credentialLabel(credential: CredentialSummary, withCategory = false): string {
  const base = `${credential.service} · ${credential.email}`;
  return truncate(withCategory ? `${base} (${credential.category})` : base, 60);
}

function paginate<T>(
  items: T[],
  page: number,
  target: (page: number) => string
): { items: T[]; nav: InlineKeyboard; label: string } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const nav: InlineButton[] = [];

  if (current > 0) nav.push(button("◀️ Anterior", target(current - 1)));
  if (current < pages - 1) nav.push(button("Siguiente ▶️", target(current + 1)));

  return {
    items: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE),
    nav: nav.length > 0 ? [nav] : [],
    label: pages > 1 ? ` · página ${current + 1}/${pages}` : ""
  };
}
