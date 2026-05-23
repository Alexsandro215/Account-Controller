import { prisma } from "../db/prisma.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";
import { isValidPin } from "../security/auth.js";
import { clearSession, getSession, setSession, type SaveDraft } from "./sessions.js";
import { menuText } from "./menu.js";

const maxResults = 8;

export async function handleBotMessage(from: string, rawText: string): Promise<string> {
  const text = rawText.trim();
  const normalized = normalize(text);
  const session = getSession(from);

  if (["menu", "hola", "inicio", "0"].includes(normalized)) {
    clearSession(from);
    return menuText();
  }

  if (session?.type === "saving") {
    return continueSaveFlow(from, text, session.step, session.draft);
  }

  if (session?.type === "choosing") {
    return chooseCredential(from, text, session.credentialIds);
  }

  if (session?.type === "unlocking") {
    return unlockCredential(from, text);
  }

  if (["guardar", "1"].includes(normalized)) {
    setSession(from, { type: "saving", step: "service", draft: {} });
    return "Servicio o app?";
  }

  if (["buscar", "2"].includes(normalized)) {
    return "Escribe: buscar nombre_del_servicio";
  }

  if (normalized.startsWith("buscar ")) {
    return searchCredential(from, text.slice(7).trim());
  }

  if (["categorias", "3"].includes(normalized)) {
    return listCategories();
  }

  return menuText();
}

async function continueSaveFlow(
  from: string,
  text: string,
  step: "service" | "email" | "password" | "category" | "aliases" | "notes",
  draft: SaveDraft
): Promise<string> {
  if (normalize(text) === "cancelar") {
    clearSession(from);
    return "Cancelado.";
  }

  if (step === "service") {
    setSession(from, { type: "saving", step: "email", draft: { ...draft, service: text } });
    return "Correo?";
  }

  if (step === "email") {
    setSession(from, { type: "saving", step: "password", draft: { ...draft, email: text } });
    return "Contrasena?";
  }

  if (step === "password") {
    setSession(from, { type: "saving", step: "category", draft: { ...draft, password: text } });
    return "Categoria?";
  }

  if (step === "category") {
    setSession(from, { type: "saving", step: "aliases", draft: { ...draft, category: text } });
    return "Alias separados por coma? Escribe ninguno si no quieres agregar.";
  }

  if (step === "aliases") {
    const aliases = normalize(text) === "ninguno"
      ? []
      : text.split(",").map((alias) => alias.trim()).filter(Boolean);
    setSession(from, { type: "saving", step: "notes", draft: { ...draft, aliases } });
    return "Notas? Escribe ninguna si no quieres agregar.";
  }

  const notes = normalize(text) === "ninguna" ? undefined : text;
  await saveCredential({ ...draft, notes });
  clearSession(from);

  return "Credencial guardada. La contrasena quedo cifrada.";
}

async function saveCredential(draft: SaveDraft): Promise<void> {
  if (!draft.service || !draft.email || !draft.password || !draft.category) {
    throw new Error("Incomplete credential draft");
  }

  const encrypted = encryptSecret(draft.password);

  await prisma.credential.create({
    data: {
      service: draft.service,
      email: draft.email,
      category: draft.category,
      aliases: draft.aliases ?? [],
      notes: draft.notes,
      passwordCiphertext: encrypted.ciphertext,
      passwordIv: encrypted.iv,
      passwordAuthTag: encrypted.authTag
    }
  });
}

async function searchCredential(from: string, term: string): Promise<string> {
  if (!term) {
    return "Escribe: buscar nombre_del_servicio";
  }

  const credentials = await prisma.credential.findMany({
    where: {
      OR: [
        { service: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { category: { contains: term, mode: "insensitive" } },
        { aliases: { has: term } }
      ]
    },
    orderBy: { updatedAt: "desc" },
    take: maxResults
  });

  if (credentials.length === 0) {
    return "No encontre credenciales con esa busqueda.";
  }

  if (credentials.length === 1) {
    setSession(from, { type: "unlocking", credentialId: credentials[0].id });
    return `Encontre ${credentials[0].service} (${credentials[0].email}). Escribe tu PIN para mostrarla.`;
  }

  const lines = credentials.map((credential, index) =>
    `${index + 1}. ${credential.service} - ${credential.email} [${credential.category}]`
  );

  setSession(from, { type: "choosing", credentialIds: credentials.map((credential) => credential.id) });

  return [
    "Encontre varias opciones:",
    ...lines,
    "",
    "Responde con el numero."
  ].join("\n");
}

async function chooseCredential(from: string, text: string, credentialIds: string[]): Promise<string> {
  const selected = Number.parseInt(text.trim(), 10);

  if (!Number.isInteger(selected) || selected < 1 || selected > credentialIds.length) {
    return "Numero invalido. Responde con una opcion de la lista o escribe menu.";
  }

  const credentialId = credentialIds[selected - 1];
  const credential = await prisma.credential.findUnique({
    where: { id: credentialId },
    select: { service: true, email: true }
  });

  if (!credential) {
    clearSession(from);
    return "No encontre esa credencial.";
  }

  setSession(from, { type: "unlocking", credentialId });
  return `Seleccionaste ${credential.service} (${credential.email}). Escribe tu PIN para mostrarla.`;
}

async function unlockCredential(from: string, pin: string): Promise<string> {
  const session = getSession(from);

  if (session?.type !== "unlocking") {
    return menuText();
  }

  if (!isValidPin(pin)) {
    clearSession(from);
    return "PIN incorrecto. Sesion cerrada.";
  }

  const credential = await prisma.credential.findUnique({
    where: { id: session.credentialId }
  });

  clearSession(from);

  if (!credential) {
    return "No encontre esa credencial.";
  }

  const password = decryptSecret({
    ciphertext: credential.passwordCiphertext,
    iv: credential.passwordIv,
    authTag: credential.passwordAuthTag
  });

  return [
    credential.service,
    `Correo: ${credential.email}`,
    `Contrasena: ${password}`,
    credential.notes ? `Notas: ${credential.notes}` : undefined,
    "",
    "La sesion expira en 1 minuto. En la API oficial no puedo borrar tu chat remotamente; usa mensajes temporales en WhatsApp como capa extra."
  ].filter(Boolean).join("\n");
}

async function listCategories(): Promise<string> {
  const categories = await prisma.credential.findMany({
    distinct: ["category"],
    select: { category: true },
    orderBy: { category: "asc" }
  });

  if (categories.length === 0) {
    return "Aun no hay categorias guardadas.";
  }

  return ["Categorias:", ...categories.map((item) => `- ${item.category}`)].join("\n");
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
