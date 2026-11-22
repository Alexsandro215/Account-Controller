import { TEST_USER_ID } from "./support/env.js";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BotContext, type Output } from "../src/bot/context.js";
import { handleCallback, handleDocument, handlePhoto, handleText } from "../src/bot/router.js";
import { setConversation } from "../src/bot/sessions.js";
import { db, useStore } from "../src/db/index.js";
import { listCredentials, revealSecrets } from "../src/vault/credentials.js";
import { parseTotpInput, totpCode } from "../src/vault/totp.js";
import { isUnlocked, lockVault } from "../src/vault/unlock.js";
import { qrJpeg } from "./support/qr.js";
import { closeStores, freshStore } from "./support/stores.js";

const CHAT = 42;
const MASTER = "frase maestra del bot";
let messageId = 0;
let recoveryCode = "";
let firstRecoveryCode = "";
let oldBackup: Buffer | undefined;

async function say(text: string): Promise<BotContext> {
  const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
  await handleText(ctx, text);
  return ctx;
}

async function press(data: string): Promise<BotContext> {
  const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "callback", callbackId: "cb", messageId: 999 });
  await handleCallback(ctx, data);
  return ctx;
}

const textOf = (ctx: BotContext) =>
  ctx.outputs.map((output) => ("text" in output ? output.text : "")).join("\n---\n");

const buttonsOf = (ctx: BotContext) =>
  ctx.outputs.flatMap((output) => ("keyboard" in output && output.keyboard ? output.keyboard.flat() : []));

function dataOf(ctx: BotContext, label: string): string {
  const found = buttonsOf(ctx).find((button) => button.text.includes(label));
  assert.ok(found && "callback_data" in found, `button "${label}" in ${JSON.stringify(buttonsOf(ctx).map((b) => b.text))}`);
  return found.callback_data;
}

/** The text inside the last <code> of a message, with HTML entities decoded. */
function lastCode(text: string): string {
  const matches = [...text.matchAll(/<code>([^<]*)<\/code>/g)];
  assert.ok(matches.length > 0, `no <code> in ${text}`);
  return matches[matches.length - 1][1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const secretOutputs = (ctx: BotContext) =>
  ctx.outputs.filter(
    (output): output is Extract<Output, { kind: "send" | "show" }> =>
      (output.kind === "send" || output.kind === "show") && !!output.ttlSeconds
  );

describe("bot", () => {
  before(async () => {
    useStore(await freshStore());
    lockVault();
  });

  after(async () => {
    await closeStores();
  });

  it("sets up the vault on first contact", async () => {
    let ctx = await say("hola");
    assert.match(textOf(ctx), /Configura tu bóveda/);
    assert.equal(ctx.deleteIncoming, false, "'hola' is not a secret");

    ctx = await say("corta");
    assert.equal(ctx.deleteIncoming, true, "anything typed at this step is deleted");
    assert.match(textOf(ctx), /al menos 10/);

    await say(MASTER);
    ctx = await say("otra cosa distinta");
    assert.match(textOf(ctx), /No coinciden/);

    await say(MASTER);
    ctx = await say(MASTER);
    assert.equal(ctx.deleteIncoming, true);
    const [codeMessage] = secretOutputs(ctx);
    assert.match(codeMessage.text, /Código de recuperación/);
    assert.match(codeMessage.text, /<code>[0-9A-Z]{5}(-[0-9A-Z]{5}){4}<\/code>/);
    assert.equal(codeMessage.ttlSeconds, 600);
    recoveryCode = /<code>([0-9A-Z-]{29})<\/code>/.exec(codeMessage.text)![1];
    assert.match(textOf(ctx), /Tu bóveda/);
    assert.equal(isUnlocked(), true, "open right after setup");
  });

  it("creates a credential step by step and deletes only the password message", async () => {
    let ctx = await say("crear");
    assert.match(textOf(ctx), /categoría/);

    ctx = await say("Bancos");
    assert.equal(ctx.deleteIncoming, false);
    ctx = await press(dataOf(ctx, "Igual que la categoría"));
    assert.match(textOf(ctx), /Usuario o correo/);

    ctx = await say("cliente@bbva.mx");
    assert.equal(ctx.deleteIncoming, false);

    ctx = await say("Cl4ve<Segura>");
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /Guardada y cifrada/);
    assert.match(textOf(ctx), /🔑 <b>Bancos<\/b>/);

    const [credential] = await listCredentials();
    assert.equal(credential.service, "Bancos");
    assert.equal((await revealSecrets(credential.id)).password, "Cl4ve<Segura>");
  });

  it("generates the password when asked while creating", async () => {
    await say("2");
    let ctx = await say("bancos");
    assert.match(textOf(ctx), /📂 Bancos/, "reuses the existing category spelling");
    await say("BBVA");
    await say("otro@bbva.mx");
    ctx = await press("np");

    const [reveal] = secretOutputs(ctx);
    assert.match(reveal.text, /<code>otro@bbva\.mx<\/code>/);
    assert.equal(lastCode(reveal.text).length, 20);
  });

  it("finds credentials by forgiving search and opens a single match directly", async () => {
    let ctx = await say("bbav");
    assert.ok(buttonsOf(ctx)[0].text.startsWith("BBVA"), "a typo in the service name ranks first");

    ctx = await say("otro@bbva");
    assert.match(textOf(ctx), /🔑 <b>BBVA<\/b>/, "a single match opens directly");

    ctx = await say("/buscar bancos");
    assert.match(textOf(ctx), /2 resultados/);

    ctx = await say("zzzz");
    assert.match(textOf(ctx), /No encontré nada/);
    assert.equal(ctx.deleteIncoming, false, "an ordinary word stays");
  });

  it("never echoes a search, and deletes one that looks like a password", async () => {
    const ctx = await say("Xk9#mP2$vL7q");
    assert.equal(ctx.deleteIncoming, true);
    assert.ok(!textOf(ctx).includes("Xk9"), "the text is not repeated back");
    assert.match(textOf(ctx), /borré tu mensaje/);
  });

  it("asks for the master password when closed and resumes the action", async () => {
    const [credential] = (await listCredentials()).filter((item) => item.service === "Bancos");
    await press("lock");
    assert.equal(isUnlocked(), false);

    let ctx = await press(`rv:${credential.id}`);
    assert.match(textOf(ctx), /contraseña maestra/);

    ctx = await say("no es la buena");
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /Te quedan 2 intentos/);

    ctx = await say(MASTER);
    assert.equal(ctx.deleteIncoming, true);
    const [notice, reveal] = secretOutputs(ctx);
    assert.match(notice.text, /Bóveda abierta/);
    assert.match(reveal.text, /<code>Cl4ve&lt;Segura&gt;<\/code>/, "escaped HTML");
    assert.equal(reveal.ttlSeconds, 60);
  });

  it("edits a password, keeps the old one in history and adds 2FA", async () => {
    const [credential] = (await listCredentials()).filter((item) => item.service === "Bancos");

    let ctx = await press(`ed:${credential.id}`);
    ctx = await press(dataOf(ctx, "Contraseña"));
    ctx = await say("NuevaClave#2026");
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /Actualizado/);

    ctx = await press(`hs:${credential.id}`);
    assert.match(secretOutputs(ctx)[0].text, /Cl4ve&lt;Segura&gt;/);

    ctx = await press(`ef:${credential.id}:t`);
    ctx = await say("JBSW Y3DP EHPK 3PXP");
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /2FA guardado/);

    ctx = await press(`otp:${credential.id}`);
    const expected = totpCode(parseTotpInput("JBSWY3DPEHPK3PXP")).code;
    assert.match(secretOutputs(ctx)[0].text, new RegExp(`${expected.slice(0, 3)} ${expected.slice(3)}`));
  });

  it("keeps the step open on invalid input", async () => {
    const [credential] = (await listCredentials()).filter((item) => item.service === "Bancos");
    await press(`ef:${credential.id}:t`);
    let ctx = await say("esto no es base32 !!");
    assert.match(textOf(ctx), /base32/);
    ctx = await say("cancelar");
    assert.match(textOf(ctx), /Cancelado/);
  });

  it("deletes a credential after confirmation", async () => {
    const [credential] = (await listCredentials()).filter((item) => item.service === "BBVA");
    let ctx = await press(`del:${credential.id}`);
    assert.match(textOf(ctx), /¿Borrar/);
    ctx = await press(dataOf(ctx, "Sí, borrar"));
    assert.match(textOf(ctx), /Borré/);
    assert.equal((await listCredentials()).some((item) => item.id === credential.id), false);
  });

  it("explains an expired step and deletes a late secret", async () => {
    setConversation(
      TEST_USER_ID,
      { type: "create", step: "password", draft: { category: "X", service: "X", email: "x" } },
      Date.now() - 6 * 60_000
    );
    const ctx = await say("mi-clave-tardia");
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /expiró/);
    assert.equal((await listCredentials()).some((item) => item.service === "X"), false);
  });

  it("imports a CSV, deletes it from the chat and skips duplicates", async () => {
    const csv = "name,url,username,password\nNetflix,https://netflix.com,yo@mail.com,pw1\nSpotify,https://spotify.com,yo,pw2\n";
    const file = { fileName: "Chrome Passwords.csv", size: csv.length, download: async () => Buffer.from(csv) };

    let ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
    await handleDocument(ctx, file);
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /2 credenciales importadas/);

    ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
    await handleDocument(ctx, file);
    assert.match(textOf(ctx), /0 credenciales importadas/);
    assert.match(textOf(ctx), /2 ya existían/);
  });

  it("sends an encrypted backup and restores it from the chat", async () => {
    let ctx = await press("bk");
    const document = ctx.outputs.find((output) => output.kind === "document");
    assert.ok(document && document.kind === "document");
    assert.match(document.filename, /^boveda-\d{4}-\d{2}-\d{2}\.json$/);
    assert.ok(await db().settings.get("lastBackupAt"));

    const backup = document.content;
    oldBackup = backup;
    ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
    await handleDocument(ctx, { fileName: document.filename, size: backup.length, download: async () => backup });
    assert.equal(ctx.deleteIncoming, false, "the encrypted backup can stay in the chat");
    assert.match(textOf(ctx), /Respaldo del/);

    ctx = await say(MASTER);
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /Respaldo restaurado: 0 credenciales agregadas, 3 ya existían/);
  });

  it("adds 2FA from a photo of the QR code and deletes the photo", async () => {
    const credential = (await listCredentials()).find((item) => item.service === "Netflix")!;
    await press(`ef:${credential.id}:t`);

    const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
    const photo = qrJpeg("otpauth://totp/Netflix:yo?secret=JBSWY3DPEHPK3PXP&issuer=Netflix");
    await handlePhoto(ctx, async () => photo);

    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /2FA guardado/);
    assert.equal((await listCredentials()).find((item) => item.id === credential.id)!.hasTotp, true);
  });

  it("deletes an uploaded file even if downloading it fails", async () => {
    const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
    await handleDocument(ctx, {
      fileName: "passwords.csv",
      size: 100,
      download: async () => {
        throw new Error("network down");
      }
    });
    assert.equal(ctx.deleteIncoming, true);
  });

  it("deletes photos that are not expected and explains how to add 2FA", async () => {
    const ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
    await handlePhoto(ctx, async () => Buffer.alloc(0));
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /Agregar 2FA/);
  });

  it("generates passwords and regenerates them in place", async () => {
    let ctx = await say("/generar 24");
    assert.equal(lastCode(secretOutputs(ctx)[0].text).length, 24);

    ctx = await press("g:32:0");
    const [output] = ctx.outputs;
    assert.equal(output.kind, "show");
    assert.ok("ttlSeconds" in output && output.ttlSeconds, "still self-destructs");
    assert.match((output as { text: string }).text, /<code>[A-Za-z2-9]{32}<\/code>/);
  });

  it("reports password health", async () => {
    const ctx = await press("hl");
    assert.match(textOf(ctx), /Salud de tus contraseñas: \d+\/100/);
  });

  it("shows the activity log", async () => {
    const ctx = await press("act");
    assert.match(textOf(ctx), /Actividad reciente/);
    assert.match(textOf(ctx), /Contrasena vista|Contraseña vista/);
  });

  it("asks for the current master password before changing it or rotating the recovery code", async () => {
    let ctx = await press("chm");
    assert.match(textOf(ctx), /contraseña maestra <b>actual<\/b>/);
    ctx = await say("no es la actual");
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /No es correcta/);

    ctx = await say(MASTER);
    assert.match(textOf(ctx), /Escribe tu <b>nueva<\/b>/);
    await say("frase maestra cambiada");
    ctx = await say("frase maestra cambiada");
    assert.match(textOf(ctx), /Contraseña maestra cambiada/);

    await press("rot");
    ctx = await say("frase maestra cambiada");
    const [codeMessage] = secretOutputs(ctx);
    firstRecoveryCode = recoveryCode;
    recoveryCode = /<code>([0-9A-Z-]{29})<\/code>/.exec(codeMessage.text)![1];
    assert.notEqual(recoveryCode, firstRecoveryCode);
  });

  it("never lets an old backup reopen the vault with a replaced password or recovery code", async () => {
    await press("lock");
    let ctx = new BotContext(TEST_USER_ID, CHAT, { kind: "message", messageId: ++messageId });
    await handleDocument(ctx, { fileName: "old.json", size: oldBackup!.length, download: async () => oldBackup! });
    assert.match(textOf(ctx), /Respaldo del/);

    ctx = await say(firstRecoveryCode);
    assert.match(textOf(ctx), /No es correcta/, "the rotated recovery code is dead");
    ctx = await say(MASTER);
    assert.match(textOf(ctx), /No es correcta/, "so is the old master password");
    assert.equal(isUnlocked(), false);

    ctx = await say("frase maestra cambiada");
    assert.match(textOf(ctx), /Respaldo restaurado/, "the current password still works");
    await press("lock");
  });

  it("recovers access with the recovery code and issues a new one", async () => {
    await press("lock");
    let ctx = await press("rec");
    assert.match(textOf(ctx), /código de recuperación/);

    ctx = await say("no parece un codigo");
    assert.match(textOf(ctx), /no parece/);

    ctx = await say(recoveryCode);
    assert.equal(ctx.deleteIncoming, true);
    assert.match(textOf(ctx), /contraseña maestra nueva/);

    await say("frase maestra renovada");
    ctx = await say("frase maestra renovada");
    assert.match(secretOutputs(ctx)[0].text, /Código de recuperación/);

    await press("lock");
    await press("unlock");
    ctx = await say("frase maestra renovada");
    assert.equal(isUnlocked(), true);
  });

  it("locks the vault after three wrong attempts, even for the right password", async () => {
    await press("lock");
    await press("unlock");
    await say("mal 1");
    await say("mal 2");
    let ctx = await say("mal 3");
    assert.match(textOf(ctx), /bloqueada/);

    ctx = await press("unlock");
    assert.match(textOf(ctx), /bloqueada/);
  });
});
