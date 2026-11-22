import type { KeyObject } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { audit, recentActivity } from "../vault/audit.js";
import { createBackup, looksLikeBackup, openBackupKey, parseBackup, restoreBackup } from "../vault/backup.js";
import {
  canonicalCategory,
  createCredential,
  currentTotp,
  deleteCredential,
  getCredential,
  groupCategories,
  listCredentials,
  migrateLegacyCredentials,
  passwordHistory,
  revealAll,
  revealCategory,
  revealSecrets,
  sameCategory,
  updateCredential,
  type CredentialSummary,
  type CredentialUpdate
} from "../vault/credentials.js";
import { looksLikeRecoveryCode, sha256Hex } from "../vault/crypto.js";
import { isVaultError, VaultError } from "../vault/errors.js";
import { generatePassword, MAX_GENERATED_LENGTH, MIN_GENERATED_LENGTH, passwordStrength } from "../vault/generator.js";
import { buildHealthReport } from "../vault/health.js";
import { DEFAULT_IMPORT_CATEGORY, importCsv, type ImportedCredential } from "../vault/importers.js";
import {
  changeMasterPassword,
  isVaultReady,
  masterPasswordProblem,
  MIN_MASTER_PASSWORD_LENGTH,
  rotateRecoveryCode,
  setupVault,
  vaultKeyRow
} from "../vault/keys.js";
import { decodeQrFromJpeg } from "../vault/qr.js";
import { foldText, searchCredentials } from "../vault/search.js";
import {
  attemptUnlock,
  currentLock,
  lockVault,
  registerFailure,
  resetFailures,
  serializeAttempts,
  unlockedKey,
  unlockExpiresAt,
  unlockVault,
  type UnlockAttempt
} from "../vault/unlock.js";
import type { BotContext } from "./context.js";
import {
  clearConversation,
  expectsSecret,
  getConversation,
  setConversation,
  takeExpiredConversation,
  type Conversation,
  type CreateDraft,
  type EditField
} from "./sessions.js";
import { escapeHtml, plural } from "./text.js";
import * as views from "./views.js";
import { button } from "./views.js";

const RECOVERY_CODE_TTL_SECONDS = 600;
const NOTICE_TTL_SECONDS = 15;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const CANCEL_WORDS = new Set(["cancelar", "/cancelar", "cancel", "/cancel", "salir"]);

/** Text shortcuts → button actions. Anything else typed is a search. */
const TEXT_COMMANDS: Record<string, string> = {
  menu: "m", "menú": "m", hola: "m", inicio: "m", "0": "m", start: "m",
  categorias: "tree", "categorías": "tree", "ver categorias": "tree", "ver categorías": "tree", "1": "tree",
  crear: "new", "crear credencial": "new", guardar: "new", nueva: "new", "2": "new",
  "ver categoria": "cats:0", "ver categoría": "cats:0", "ver credenciales": "cats:0",
  "ver credenciales de categoria": "cats:0", "ver credenciales de categoría": "cats:0", "3": "cats:0",
  buscar: "srch", generar: "gen", bloquear: "lock", cerrar: "lock", abrir: "unlock", desbloquear: "unlock",
  salud: "hl", respaldo: "bk", actividad: "act", importar: "imp", ajustes: "set", recuperar: "rec",
  "olvide mi contraseña": "rec", "olvidé mi contraseña": "rec", app: "app", cancelar: "cancel", salir: "cancel"
};

const EDIT_FIELDS: Record<string, EditField> = {
  s: "service",
  u: "email",
  c: "category",
  p: "password",
  n: "notes",
  t: "totp"
};

export type IncomingFile = {
  fileName?: string;
  size?: number;
  download: () => Promise<Buffer>;
};

// =======================================================================================
// Entry points (called by the transport)
// =======================================================================================

export async function handleText(ctx: BotContext, rawText: string): Promise<void> {
  const text = rawText.trim();
  const conversation = getConversation(ctx.userId);
  const expired = conversation ? undefined : takeExpiredConversation(ctx.userId);

  if (expectsSecret(conversation) || expectsSecret(expired)) {
    ctx.deleteIncoming = true;
  }

  await guarded(ctx, async () => {
    if (!(await isVaultReady())) {
      return handleSetupText(ctx, text, conversation);
    }

    const { word, action, argument } = parseCommand(text);

    if (action === "m") {
      clearConversation(ctx.userId);
      return mainMenu(ctx);
    }

    if (conversation && CANCEL_WORDS.has(word)) {
      clearConversation(ctx.userId);
      ctx.send("Cancelado.");
      return mainMenu(ctx);
    }

    if (conversation) {
      return continueConversation(ctx, conversation, text);
    }

    if (action === "srch" && argument) {
      return search(ctx, argument);
    }

    if (action === "gen" && argument) {
      const length = Number.parseInt(argument, 10);
      return showGenerator(ctx, Number.isFinite(length) ? length : 20, true, false);
    }

    if (action) {
      return dispatchAction(ctx, action);
    }

    if (expired) {
      ctx.send(expiredText(expired), [[button("🏠 Menú", "m")]]);
      return;
    }

    return search(ctx, text);
  });
}

export async function handleCallback(ctx: BotContext, data: string): Promise<void> {
  await guarded(
    ctx,
    async () => {
      if (data === "x") {
        ctx.deleteSource();
        return;
      }

      if (!(await isVaultReady())) {
        startSetup(ctx);
        return;
      }

      await dispatchAction(ctx, data);
    },
    data
  );
}

export async function handleDocument(ctx: BotContext, file: IncomingFile): Promise<void> {
  await guarded(ctx, async () => {
    if ((file.size ?? 0) > MAX_UPLOAD_BYTES) {
      ctx.deleteIncoming = true;
      ctx.send("Ese archivo es demasiado grande (máximo 5 MB). Lo borré del chat.");
      return;
    }

    // Any file may be a CSV full of clear-text passwords: delete it unless it turns out to be
    // an (encrypted) backup. Set before downloading so a failed download still deletes it.
    ctx.deleteIncoming = true;
    const content = (await file.download()).toString("utf8");

    if (looksLikeBackup(content)) {
      ctx.deleteIncoming = false;
      return startRestore(ctx, content);
    }

    if (content.includes("\u0000")) {
      ctx.send("No reconozco ese archivo (lo borré del chat). Mándame un CSV exportado de tu gestor de contraseñas o un respaldo .json.");
      return;
    }

    if (!(await isVaultReady())) {
      ctx.send("Primero configura tu bóveda y después mándame el archivo otra vez. Ya lo borré del chat.");
      startSetup(ctx);
      return;
    }

    let parsed;

    try {
      parsed = importCsv(content);
    } catch (error) {
      ctx.send(`No pude leer el CSV: ${escapeHtml((error as Error).message)} Lo borré del chat.`);
      return;
    }

    await importItems(ctx, parsed.format, parsed.items, parsed.skipped);
  });
}

export async function handlePhoto(ctx: BotContext, download: () => Promise<Buffer>): Promise<void> {
  // A photo sent to a vault is most likely a 2FA QR code: never leave it in the chat.
  ctx.deleteIncoming = true;

  await guarded(ctx, async () => {
    const conversation = getConversation(ctx.userId);

    if (conversation?.type !== "edit" || conversation.field !== "totp") {
      ctx.send(
        "🖼 Borré la foto por seguridad. Para agregar 2FA con un QR: abre la credencial → ✏️ Editar → 🔢 Agregar 2FA, y luego mándame la foto."
      );
      return;
    }

    const text = decodeQrFromJpeg(await download());

    if (!text) {
      ctx.send("No pude leer un código QR en la foto. Prueba con otra más nítida o mándame el secreto como texto.", views.cancelKeyboard());
      return;
    }

    return continueEdit(ctx, conversation, text);
  });
}

// =======================================================================================
// Actions (buttons; text commands map onto them too)
// =======================================================================================

async function dispatchAction(ctx: BotContext, data: string): Promise<void> {
  const [action, ...args] = data.split(":");
  const id = args[0] ?? "";

  switch (action) {
    case "m":
      clearConversation(ctx.userId);
      return mainMenu(ctx);

    case "cancel":
      clearConversation(ctx.userId);
      ctx.toast("Cancelado");
      return mainMenu(ctx);

    case "tree": {
      const credentials = await listCredentials();
      const view = views.categoryTreeView(credentials, groupCategories(credentials));
      ctx.send(view.text, view.keyboard);
      return;
    }

    case "cats": {
      const view = views.categoriesView(groupCategories(await listCredentials()), toInt(args[0]));
      ctx.show(view.text, view.keyboard);
      return;
    }

    case "cat":
      return showCategory(ctx, args[0], toInt(args[1]));

    case "cr":
      return showCredential(ctx, id);

    case "rv": {
      if (await needsUnlock(ctx, data)) return;
      const { credential, password, notes } = await revealSecrets(id);
      const view = views.revealView(credential, password, notes);
      ctx.sendSecret(view.text, view.keyboard);
      return;
    }

    case "rvc": {
      if (await needsUnlock(ctx, data)) return;
      const category = await findCategory(id);
      if (!category) return categoryGone(ctx);
      const view = views.revealCategoryView(category, await revealCategory(category));
      ctx.sendSecret(view.text, view.keyboard);
      return;
    }

    case "otp":
    case "otpr": {
      if (await needsUnlock(ctx, data)) return;
      const { credential, code, remainingSeconds } = await currentTotp(id);
      const view = views.totpView(credential, code, remainingSeconds);
      if (action === "otpr") {
        ctx.showSecret(view.text, view.keyboard);
      } else {
        ctx.sendSecret(view.text, view.keyboard);
      }
      return;
    }

    case "hs": {
      if (await needsUnlock(ctx, data)) return;
      const view = views.historyView(await getCredential(id), await passwordHistory(id));
      ctx.sendSecret(view.text, view.keyboard);
      return;
    }

    case "ed": {
      if (await needsUnlock(ctx, data)) return;
      const view = views.editMenuView(await getCredential(id));
      ctx.show(view.text, view.keyboard);
      return;
    }

    case "ef": {
      if (await needsUnlock(ctx, data)) return;
      const field = EDIT_FIELDS[args[1] ?? ""];
      if (!field) return unknownAction(ctx);
      return promptEdit(ctx, await getCredential(id), field);
    }

    case "eg": {
      if (await needsUnlock(ctx, data)) return;
      const password = generatePassword({ length: 20, symbols: true });
      const credential = await updateCredential(id, { password });
      ctx.send("✅ Contraseña nueva guardada; la anterior quedó en el historial. Cópiala en el sitio:");
      const view = views.revealView(credential, password, null);
      ctx.sendSecret(view.text, view.keyboard);
      return;
    }

    case "et": {
      if (await needsUnlock(ctx, data)) return;
      const credential = await updateCredential(id, { totp: null });
      ctx.toast("2FA quitado");
      const view = views.credentialView(credential);
      ctx.show(view.text, view.keyboard);
      return;
    }

    case "del": {
      if (await needsUnlock(ctx, data)) return;
      const view = views.confirmDeleteView(await getCredential(id));
      ctx.show(view.text, view.keyboard);
      return;
    }

    case "dy": {
      if (await needsUnlock(ctx, data)) return;
      const credential = await getCredential(id);
      await deleteCredential(id);
      ctx.show(`🗑 Borré <b>${escapeHtml(credential.service)}</b> (${escapeHtml(credential.email)}).`, [
        [button("📂 Categorías", "cats:0"), button("🏠 Menú", "m")]
      ]);
      return;
    }

    case "new":
      return startCreate(ctx);

    case "nc":
    case "ns":
    case "np":
      return createButton(ctx, action, id);

    case "srch":
      setConversation(ctx.userId, { type: "search" });
      ctx.send("🔎 ¿Qué buscas? Escribe el servicio, el usuario o la categoría.", views.cancelKeyboard());
      return;

    case "gen":
      return showGenerator(ctx, 20, true, false);

    case "g":
      return showGenerator(ctx, toInt(args[0], 20), args[1] !== "0", true);

    case "hl": {
      if (await needsUnlock(ctx, data)) return;
      const report = await buildHealthReport(await revealAll(), { checkPwned: config.PWNED_CHECK });
      await audit("health", null, `${report.score}/100`);
      const view = views.healthView(report);
      ctx.send(view.text, view.keyboard);
      return;
    }

    case "act": {
      const view = views.activityView(await recentActivity(15));
      ctx.show(view.text, view.keyboard);
      return;
    }

    case "bk": {
      const backup = await createBackup();
      await db().settings.set("lastBackupAt", new Date().toISOString());
      const skippedNote =
        backup.skipped > 0 ? ` ⚠️ ${plural(backup.skipped, "credencial antigua no se pudo", "credenciales antiguas no se pudieron")} leer (revisa VAULT_MASTER_KEY).` : "";
      ctx.document(
        backup.filename,
        backup.content,
        `💾 Respaldo cifrado (${plural(backup.count, "credencial", "credenciales")}). Se abre con tu contraseña maestra o tu código de recuperación. Para restaurarlo, mándamelo como archivo.${skippedNote}`
      );
      ctx.toast("Respaldo enviado");
      return;
    }

    case "set": {
      const view = views.settingsView();
      ctx.show(view.text, view.keyboard);
      return;
    }

    case "imp": {
      const view = views.importHelpView();
      ctx.show(view.text, view.keyboard);
      return;
    }

    case "chm":
    case "rot":
      // These can lock the owner out, so an open vault is not enough: whoever holds the phone
      // during the unlocked window must still prove they know the current master password.
      if (await reportLockout(ctx)) return;
      setConversation(ctx.userId, { type: "confirmMaster", then: action });
      ctx.send(
        action === "chm"
          ? "🔑 Para cambiarla, primero escribe tu contraseña maestra <b>actual</b> (borraré tu mensaje)."
          : "♻️ Para generar un código nuevo, escribe tu contraseña maestra <b>actual</b> (borraré tu mensaje).",
        views.cancelKeyboard()
      );
      return;

    case "lock":
      lockVault();
      await audit("lock");
      ctx.toast("🔒 Bóveda cerrada");
      return mainMenu(ctx);

    case "unlock": {
      if (unlockedKey()) {
        ctx.toast("Ya está abierta");
        return mainMenu(ctx);
      }
      if (await reportLockout(ctx)) return;
      setConversation(ctx.userId, { type: "unlock" });
      const view = views.unlockPromptView();
      ctx.send(view.text, view.keyboard);
      return;
    }

    case "rec":
      if (await reportLockout(ctx)) return;
      setConversation(ctx.userId, { type: "recovery" });
      ctx.send(
        "🧾 Escribe tu <b>código de recuperación</b> (25 caracteres, como XXXXX-XXXXX-XXXXX-XXXXX-XXXXX). Borraré tu mensaje.",
        views.cancelKeyboard()
      );
      return;

    case "app":
      if (config.WEBAPP_URL) {
        ctx.send("📱 Tu bóveda en modo app:", [[{ text: "Abrir app", web_app: { url: config.WEBAPP_URL } }]]);
      } else {
        ctx.send("La app no está configurada en este servidor (falta WEBAPP_URL).");
      }
      return;

    default:
      return unknownAction(ctx);
  }
}

async function mainMenu(ctx: BotContext): Promise<void> {
  const credentials = await listCredentials();
  const view = views.mainMenuView({
    credentials: credentials.length,
    categories: groupCategories(credentials).length,
    unlockedUntil: unlockExpiresAt()
  });
  ctx.show(view.text, view.keyboard);
}

async function showCategory(ctx: BotContext, key: string, page: number): Promise<void> {
  const category = await findCategory(key);

  if (!category) {
    return categoryGone(ctx);
  }

  const credentials = (await listCredentials()).filter((credential) => sameCategory(credential.category, category));
  const view = views.categoryView(category, credentials, page);
  ctx.show(view.text, view.keyboard);
}

async function showCredential(ctx: BotContext, id: string): Promise<void> {
  const view = views.credentialView(await getCredential(id));
  ctx.show(view.text, view.keyboard);
}

async function findCategory(key: string): Promise<string | undefined> {
  return groupCategories(await listCredentials()).find((category) => category.key === key)?.name;
}

async function categoryGone(ctx: BotContext): Promise<void> {
  ctx.toast("Esa categoría ya no existe");
  const view = views.categoriesView(groupCategories(await listCredentials()), 0);
  ctx.show(view.text, view.keyboard);
}

async function search(ctx: BotContext, query: string): Promise<void> {
  const results = searchCredentials(await listCredentials(), query);

  if (results.length === 1) {
    return showCredential(ctx, results[0].id);
  }

  // Free text that finds nothing and looks like a password was probably typed into a step
  // the bot no longer remembers (e.g. after a restart): don't leave it in the chat.
  const looksSecret = results.length === 0 && passwordStrength(query).score >= 2;

  if (looksSecret) {
    ctx.deleteIncoming = true;
  }

  const view = views.searchResultsView(results, looksSecret);
  ctx.send(view.text, view.keyboard);
}

function showGenerator(ctx: BotContext, length: number, symbols: boolean, inPlace: boolean): void {
  const size = Math.min(MAX_GENERATED_LENGTH, Math.max(MIN_GENERATED_LENGTH, length));
  const view = views.generatorView(generatePassword({ length: size, symbols }), size, symbols);

  if (inPlace) {
    ctx.showSecret(view.text, view.keyboard);
  } else {
    ctx.sendSecret(view.text, view.keyboard);
  }
}

async function unknownAction(ctx: BotContext): Promise<void> {
  ctx.toast("Ese botón ya no es válido");
  return mainMenu(ctx);
}

// =======================================================================================
// Unlocking
// =======================================================================================

/** If the vault is closed, asks for the master password and returns true; `then` runs after. */
async function needsUnlock(ctx: BotContext, then: string): Promise<boolean> {
  if (unlockedKey()) {
    return false;
  }

  if (await reportLockout(ctx)) {
    return true;
  }

  setConversation(ctx.userId, { type: "unlock", then });
  const view = views.unlockPromptView();
  ctx.send(view.text, view.keyboard);
  return true;
}

async function reportLockout(ctx: BotContext): Promise<boolean> {
  const until = await currentLock(ctx.userId);

  if (until) {
    clearConversation(ctx.userId);
    ctx.send(views.lockedOutText(until));
    return true;
  }

  return false;
}


async function continueUnlock(ctx: BotContext, conversation: Conversation & { type: "unlock" | "recovery" }, text: string): Promise<void> {
  if (conversation.type === "recovery" && !looksLikeRecoveryCode(text)) {
    ctx.send(
      "Eso no parece un código de recuperación (son 25 caracteres, como XXXXX-XXXXX-XXXXX-XXXXX-XXXXX). Intenta de nuevo o escribe cancelar."
    );
    return;
  }

  const result = await attemptUnlock(ctx.userId, text);

  if (!result.ok) {
    return reportFailedUnlock(ctx, result, conversation);
  }

  if (result.via === "recovery") {
    setConversation(ctx.userId, { type: "newMaster", step: "password", reason: "recovery" });
    ctx.send(
      `✅ Código correcto. Ahora elige una <b>contraseña maestra nueva</b> (mínimo ${MIN_MASTER_PASSWORD_LENGTH} caracteres; borraré tu mensaje).`
    );
    return;
  }

  clearConversation(ctx.userId);
  notice(ctx, `🔓 Bóveda abierta. Se cierra sola tras ${config.VAULT_UNLOCK_MINUTES} min sin uso.`);

  if (conversation.type === "unlock" && conversation.then) {
    return dispatchAction(ctx, conversation.then);
  }

  return mainMenu(ctx);
}

function reportFailedUnlock(ctx: BotContext, result: UnlockAttempt & { ok: false }, conversation: Conversation): void {
  if (result.reason === "locked" || result.lockedUntil) {
    clearConversation(ctx.userId);
    ctx.send(views.lockedOutText(result.reason === "locked" ? result.lockedUntil : result.lockedUntil!));
    return;
  }

  // Keep the step open: typos are common and the lockout already limits guessing.
  const { expiresAt: _expiresAt, ...input } = conversation;
  setConversation(ctx.userId, input);
  ctx.send(
    `❌ No es correcta. Te quedan ${plural(result.remainingAttempts, "intento")} antes de que la bóveda se bloquee. Intenta de nuevo o escribe cancelar.`,
    [[button("Olvidé mi contraseña", "rec"), button("✖️ Cancelar", "cancel")]]
  );
}

// =======================================================================================
// Conversations (multi-step text input)
// =======================================================================================

async function continueConversation(ctx: BotContext, conversation: Conversation, text: string): Promise<void> {
  switch (conversation.type) {
    case "unlock":
    case "recovery":
      return continueUnlock(ctx, conversation, text);
    case "confirmMaster":
      return continueConfirmMaster(ctx, conversation, text);
    case "newMaster":
      return continueNewMaster(ctx, conversation, text);
    case "create":
      return continueCreate(ctx, conversation, text);
    case "edit":
      return continueEdit(ctx, conversation, text);
    case "search":
      clearConversation(ctx.userId);
      return search(ctx, text);
    case "restore":
      return continueRestore(ctx, conversation, text);
    case "setup":
      clearConversation(ctx.userId);
      return mainMenu(ctx);
  }
}

// --- Setup ------------------------------------------------------------------------------

async function handleSetupText(ctx: BotContext, text: string, conversation: Conversation | undefined): Promise<void> {
  if (conversation && CANCEL_WORDS.has(foldText(text))) {
    clearConversation(ctx.userId);
    ctx.send("De acuerdo. Cuando quieras configurar tu bóveda, escríbeme.");
    return;
  }

  if (conversation?.type === "restore") {
    return continueRestore(ctx, conversation, text);
  }

  if (conversation?.type !== "setup") {
    return startSetup(ctx);
  }

  if (conversation.step === "password") {
    const problem = masterPasswordProblem(text);

    if (problem) {
      ctx.send(`❌ ${problem} Escribe otra.`);
      return;
    }

    setConversation(ctx.userId, { type: "setup", step: "confirm", firstHash: sha256Hex(text) });
    ctx.send("Escríbela otra vez para confirmar.");
    return;
  }

  if (sha256Hex(text) !== conversation.firstHash) {
    setConversation(ctx.userId, { type: "setup", step: "password" });
    ctx.send("No coinciden. Empecemos de nuevo: escribe tu contraseña maestra.");
    return;
  }

  const { privateKey, recoveryCode } = await setupVault(text);
  clearConversation(ctx.userId);
  unlockVault(privateKey);
  await audit("setup");

  const { migrated, failed } = await migrateLegacyCredentials();
  const intro = ["✅ <b>Bóveda lista.</b>"];

  if (migrated > 0) intro.push(`Pasé ${plural(migrated, "credencial", "credenciales")} al nuevo cifrado.`);
  if (failed > 0) intro.push(`⚠️ ${plural(failed, "credencial no se pudo", "credenciales no se pudieron")} migrar; revisa VAULT_MASTER_KEY.`);

  const view = views.recoveryCodeView(recoveryCode, intro.join("\n"));
  ctx.sendSecret(view.text, view.keyboard, RECOVERY_CODE_TTL_SECONDS);
  return mainMenu(ctx);
}

function startSetup(ctx: BotContext): void {
  setConversation(ctx.userId, { type: "setup", step: "password" });
  const view = views.setupIntroView();
  ctx.send(view.text, view.keyboard);
}

// --- Re-authentication before sensitive settings ------------------------------------------

async function continueConfirmMaster(
  ctx: BotContext,
  conversation: Conversation & { type: "confirmMaster" },
  text: string
): Promise<void> {
  // Master password only: the recovery code has its own flow.
  const result = await attemptUnlock(ctx.userId, text, false);

  if (!result.ok) {
    return reportFailedUnlock(ctx, result, conversation);
  }

  clearConversation(ctx.userId);

  if (conversation.then === "chm") {
    setConversation(ctx.userId, { type: "newMaster", step: "password", reason: "change" });
    ctx.send(
      `🔑 Correcto. Escribe tu <b>nueva</b> contraseña maestra (mínimo ${MIN_MASTER_PASSWORD_LENGTH} caracteres; borraré tu mensaje).`,
      views.cancelKeyboard()
    );
    return;
  }

  const code = await rotateRecoveryCode(result.key);
  await audit("recovery_rotated");
  const view = views.recoveryCodeView(code, "♻️ <b>Código de recuperación nuevo.</b> El anterior ya no sirve.");
  ctx.sendSecret(view.text, view.keyboard, RECOVERY_CODE_TTL_SECONDS);
}

// --- New master password (change or after recovery) --------------------------------------

async function continueNewMaster(
  ctx: BotContext,
  conversation: Conversation & { type: "newMaster" },
  text: string
): Promise<void> {
  const key = unlockedKey();

  if (!key) {
    clearConversation(ctx.userId);
    ctx.send("La bóveda se cerró antes de terminar. Vuelve a empezar desde ⚙️ Ajustes.", [[button("🏠 Menú", "m")]]);
    return;
  }

  if (conversation.step === "password") {
    const problem = masterPasswordProblem(text);

    if (problem) {
      ctx.send(`❌ ${problem} Escribe otra.`);
      return;
    }

    setConversation(ctx.userId, { type: "newMaster", step: "confirm", reason: conversation.reason, firstHash: sha256Hex(text) });
    ctx.send("Escríbela otra vez para confirmar.");
    return;
  }

  if (sha256Hex(text) !== conversation.firstHash) {
    setConversation(ctx.userId, { type: "newMaster", step: "password", reason: conversation.reason });
    ctx.send("No coinciden. Escribe de nuevo la contraseña maestra nueva.");
    return;
  }

  await changeMasterPassword(key, text);
  clearConversation(ctx.userId);
  await audit("master_changed");

  if (conversation.reason === "recovery") {
    const code = await rotateRecoveryCode(key);
    await audit("recovery_rotated");
    const view = views.recoveryCodeView(
      code,
      "✅ <b>Contraseña maestra nueva guardada.</b> Como usaste tu código de recuperación, aquí tienes uno nuevo (el anterior ya no sirve)."
    );
    ctx.sendSecret(view.text, view.keyboard, RECOVERY_CODE_TTL_SECONDS);
  } else {
    ctx.send("✅ Contraseña maestra cambiada. Tus contraseñas no se tocaron: solo cambió la llave que las abre.");
  }

  return mainMenu(ctx);
}

// --- Create -----------------------------------------------------------------------------

async function startCreate(ctx: BotContext): Promise<void> {
  setConversation(ctx.userId, { type: "create", step: "category", draft: {} });
  const categories = groupCategories(await listCredentials()).slice(0, 12);
  const rows = [];

  for (let i = 0; i < categories.length; i += 2) {
    rows.push(categories.slice(i, i + 2).map((category) => button(category.name, `nc:${category.key}`)));
  }

  ctx.send(
    "➕ <b>Nueva credencial</b>\n¿En qué categoría va? Elige una o escribe una nueva.",
    [...rows, [button("✖️ Cancelar", "cancel")]]
  );
}

async function createButton(ctx: BotContext, action: string, argument: string): Promise<void> {
  const conversation = getConversation(ctx.userId);

  if (conversation?.type !== "create") {
    ctx.send("⌛ Ese paso ya expiró. Empieza de nuevo.", [[button("➕ Nueva", "new"), button("🏠 Menú", "m")]]);
    return;
  }

  if (action === "nc" && conversation.step === "category") {
    const category = await findCategory(argument);
    return continueCreate(ctx, conversation, category ?? DEFAULT_IMPORT_CATEGORY);
  }

  if (action === "ns" && conversation.step === "service" && conversation.draft.category) {
    return continueCreate(ctx, conversation, conversation.draft.category);
  }

  if (action === "np" && conversation.step === "password") {
    const password = generatePassword({ length: 20, symbols: true });
    const credential = await saveDraft(ctx, conversation.draft, password);

    if (credential) {
      const view = views.revealView(credential, password, null);
      ctx.send("Generé una contraseña segura. Cópiala en el sitio:");
      ctx.sendSecret(view.text, view.keyboard);
    }
    return;
  }

  ctx.toast("Ese botón ya no aplica en este paso");
}

async function continueCreate(
  ctx: BotContext,
  conversation: Conversation & { type: "create" },
  text: string
): Promise<void> {
  const draft: CreateDraft = { ...conversation.draft };

  if (text === "") {
    ctx.send("No puede ir vacío. Intenta de nuevo o escribe cancelar.");
    return;
  }

  switch (conversation.step) {
    case "category":
      draft.category = await canonicalCategory(text);
      setConversation(ctx.userId, { type: "create", step: "service", draft });
      ctx.send(`📂 ${escapeHtml(draft.category)}\n¿De qué servicio es? (ej. Netflix, Gmail, BBVA)`, [
        [button("Igual que la categoría", "ns")],
        [button("✖️ Cancelar", "cancel")]
      ]);
      return;

    case "service":
      draft.service = text;
      setConversation(ctx.userId, { type: "create", step: "email", draft });
      ctx.send("¿Usuario o correo?", views.cancelKeyboard());
      return;

    case "email":
      draft.email = text;
      setConversation(ctx.userId, { type: "create", step: "password", draft });
      ctx.send("¿Contraseña? (borraré tu mensaje en cuanto lo reciba)", views.cancelKeyboard([button("🎲 Generar una", "np")]));
      return;

    case "password": {
      const credential = await saveDraft(ctx, draft, text);

      if (credential) {
        ctx.send("✅ Guardada y cifrada. Ya borré tu mensaje con la contraseña.");
      }
      return;
    }
  }
}

async function saveDraft(ctx: BotContext, draft: CreateDraft, password: string): Promise<CredentialSummary | undefined> {
  const credential = await createCredential({
    category: draft.category ?? "",
    service: draft.service ?? draft.category ?? "",
    email: draft.email ?? "",
    password
  });

  clearConversation(ctx.userId);
  const view = views.credentialView(credential);
  ctx.send(view.text, view.keyboard);
  return credential;
}

// --- Edit -------------------------------------------------------------------------------

function promptEdit(ctx: BotContext, credential: CredentialSummary, field: EditField): void {
  setConversation(ctx.userId, { type: "edit", id: credential.id, field });

  const prompts: Record<EditField, string> = {
    service: `Escribe el nuevo nombre del servicio (ahora: ${escapeHtml(credential.service)}).`,
    email: `Escribe el nuevo usuario o correo (ahora: ${escapeHtml(credential.email)}).`,
    category: `Escribe la nueva categoría (ahora: ${escapeHtml(credential.category)}).`,
    password: "Escribe la nueva contraseña (borraré tu mensaje). La anterior queda en el historial.",
    notes: "Escribe las notas (borraré tu mensaje). Escribe <b>-</b> para quitarlas.",
    totp: "Mándame el secreto 2FA: el texto que te da el sitio, el enlace otpauth:// o una <b>foto del código QR</b>. Lo borro del chat en cuanto lo lea."
  };

  ctx.send(`✏️ <b>${escapeHtml(credential.service)}</b>\n${prompts[field]}`, views.cancelKeyboard());
}

async function continueEdit(ctx: BotContext, conversation: Conversation & { type: "edit" }, text: string): Promise<void> {
  if (!unlockedKey()) {
    clearConversation(ctx.userId);
    ctx.send("La bóveda se cerró antes de guardar el cambio. Ábrela y vuelve a intentarlo.", [
      [button("🔓 Abrir bóveda", "unlock")]
    ]);
    return;
  }

  const update: CredentialUpdate = {};

  switch (conversation.field) {
    case "notes":
      update.notes = text === "-" ? null : text;
      break;
    case "totp":
      update.totp = text;
      break;
    default:
      update[conversation.field] = text;
  }

  let credential: CredentialSummary;

  try {
    credential = await updateCredential(conversation.id, update);
  } catch (error) {
    if (isVaultError(error, "invalid")) {
      // Keep the step open so the user can fix the value.
      ctx.send(`❌ ${escapeHtml(error.message)} Intenta de nuevo o escribe cancelar.`);
      return;
    }
    throw error;
  }

  clearConversation(ctx.userId);
  ctx.send(conversation.field === "totp" ? "✅ 2FA guardado. Ya puedes pedir códigos." : "✅ Actualizado.");
  const view = views.credentialView(credential);
  ctx.send(view.text, view.keyboard);
}

// --- Import & restore -------------------------------------------------------------------

async function importItems(ctx: BotContext, format: string, items: ImportedCredential[], invalid: number): Promise<void> {
  const existing = await listCredentials();
  const keyOf = (service: string, email: string) => `${foldText(service)}\u0000${foldText(email)}`;
  const seen = new Set(existing.map((credential) => keyOf(credential.service, credential.email)));
  let added = 0;
  let duplicates = 0;
  let failed = 0;
  let totpDropped = 0;

  for (const item of items) {
    const key = keyOf(item.service, item.email);

    if (seen.has(key)) {
      duplicates++;
      continue;
    }

    try {
      await createCredential(item, { audit: false });
    } catch (error) {
      if (item.totp && isVaultError(error, "invalid")) {
        try {
          await createCredential({ ...item, totp: null }, { audit: false });
          totpDropped++;
        } catch {
          failed++;
          continue;
        }
      } else {
        failed++;
        continue;
      }
    }

    seen.add(key);
    added++;
  }

  await audit("import", null, `${added} desde ${format}`);

  const lines = [`📥 <b>Importación desde ${escapeHtml(format)}</b>`, `✅ ${plural(added, "credencial importada", "credenciales importadas")}`];
  if (duplicates > 0) lines.push(`↩️ ${plural(duplicates, "ya existía", "ya existían")} (mismo servicio y usuario)`);
  if (invalid > 0) lines.push(`⏭ ${plural(invalid, "fila omitida", "filas omitidas")} (sin contraseña o no es un login)`);
  if (totpDropped > 0) lines.push(`⚠️ ${plural(totpDropped, "2FA no se pudo", "2FA no se pudieron")} leer; la credencial sí se guardó`);
  if (failed > 0) lines.push(`❌ ${plural(failed, "fila falló", "filas fallaron")}`);
  lines.push("", "Ya borré el archivo del chat. Bórralo también de tu dispositivo: trae tus contraseñas sin cifrar.");

  ctx.send(lines.join("\n"), [[button("📂 Categorías", "cats:0"), button("🩺 Revisar salud", "hl")]]);
}

async function startRestore(ctx: BotContext, content: string): Promise<void> {
  const file = parseBackup(content);

  if (await isVaultReady()) {
    const current = await vaultKeyRow();

    if (current.publicKey !== file.vault.publicKey) {
      ctx.send("Este respaldo es de otra bóveda. Solo puedo restaurarlo en esta misma bóveda o en una base de datos vacía.");
      return;
    }
  }

  setConversation(ctx.userId, { type: "restore", backup: content });
  ctx.send(
    [
      `💾 Respaldo del ${escapeHtml(file.createdAt.slice(0, 10))} recibido.`,
      "Escribe la contraseña maestra con la que se hizo, o tu código de recuperación (borraré tu mensaje).",
      "Si este servidor tiene otro VAULT_MASTER_KEY, solo funcionará el código de recuperación."
    ].join("\n"),
    views.cancelKeyboard()
  );
}

async function continueRestore(ctx: BotContext, conversation: Conversation & { type: "restore" }, text: string): Promise<void> {
  const file = parseBackup(conversation.backup);
  let opened: { key: KeyObject; via: "master" | "recovery" };

  if (await isVaultReady()) {
    // The secret must open the vault as it is NOW. The backup's own key material may hold an
    // old master password or a rotated recovery code that must not work anymore.
    const result = await attemptUnlock(ctx.userId, text);

    if (!result.ok) {
      return reportFailedUnlock(ctx, result, conversation);
    }

    opened = result;
  } else {
    // Empty database: only the backup's key material exists. Same lockout rules apply.
    const result = await serializeAttempts(ctx.userId, async () => {
      const lockedUntil = await currentLock(ctx.userId);

      if (lockedUntil) {
        return { ok: false as const, reason: "locked" as const, lockedUntil };
      }

      const backupKey = await openBackupKey(file, text);

      if (!backupKey) {
        return registerFailure(ctx.userId);
      }

      await resetFailures(ctx.userId);
      return { ok: true as const, ...backupKey };
    });

    if (!result.ok) {
      return reportFailedUnlock(ctx, result, conversation);
    }

    opened = result;
  }

  clearConversation(ctx.userId);
  const { added, skipped } = await restoreBackup(file, opened.key);
  unlockVault(opened.key);

  ctx.send(
    `✅ Respaldo restaurado: ${plural(added, "credencial agregada", "credenciales agregadas")}` +
      (skipped > 0 ? `, ${skipped} ya existían.` : ".")
  );

  if (opened.via === "recovery") {
    setConversation(ctx.userId, { type: "newMaster", step: "password", reason: "recovery" });
    ctx.send(
      `Como usaste tu código de recuperación, elige ahora una <b>contraseña maestra nueva</b> (mínimo ${MIN_MASTER_PASSWORD_LENGTH} caracteres).`
    );
    return;
  }

  return mainMenu(ctx);
}

// =======================================================================================
// Helpers
// =======================================================================================

/** Runs a handler; expected vault errors become friendly messages, bugs a generic one. */
async function guarded(ctx: BotContext, run: () => Promise<void>, retryAction?: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isVaultError(error, "vault_locked")) {
      // The vault locked itself between the check and the use.
      setConversation(ctx.userId, { type: "unlock", then: retryAction });
      const view = views.unlockPromptView();
      ctx.send(view.text, view.keyboard);
      return;
    }

    if (isVaultError(error, "vault_not_ready")) {
      startSetup(ctx);
      return;
    }

    if (isVaultError(error)) {
      ctx.toast(error.message);
      ctx.send(`❌ ${escapeHtml(error.message)}`, [[button("🏠 Menú", "m")]]);
      return;
    }

    console.error("Bot error", error);
    clearConversation(ctx.userId);
    ctx.send("Hubo un error procesando tu mensaje. Intenta de nuevo desde el menú.", [[button("🏠 Menú", "m")]]);
  }
}

function parseCommand(text: string): { word: string; action?: string; argument?: string } {
  const folded = text.trim().toLocaleLowerCase("es");
  // "/buscar netflix", "/start@MiBot"
  const [head, ...rest] = folded.split(/\s+/);
  const command = head.replace(/^\//, "").replace(/@\w+$/, "");

  if ((command === "buscar" || command === "generar") && rest.length > 0) {
    return { word: folded, action: TEXT_COMMANDS[command], argument: text.trim().split(/\s+/).slice(1).join(" ") };
  }

  const action = TEXT_COMMANDS[folded] ?? (head.startsWith("/") ? TEXT_COMMANDS[command] : undefined);
  return { word: folded, action };
}

function notice(ctx: BotContext, text: string): void {
  ctx.outputs.push({ kind: "send", text, ttlSeconds: NOTICE_TTL_SECONDS });
}

function expiredText(expired: Conversation): string {
  const lines = ["⌛ Ese paso expiró por inactividad y no se guardó nada."];

  if (expectsSecret(expired)) {
    lines.push("Por seguridad borré el mensaje que acabas de mandar.");
  }

  lines.push("Escribe menu para empezar de nuevo.");
  return lines.join("\n");
}

function toInt(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

