import { prisma } from "../db/prisma.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";
import { isValidPin } from "../security/auth.js";
import { clearSession, getSession, setSession, type SaveDraft } from "./sessions.js";
import { menuText } from "./menu.js";

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

  if (session?.type === "choosingCategory") {
    return chooseCategory(from, text);
  }

  if (session?.type === "unlockingCategory") {
    return unlockCategory(from, text, session.category);
  }

  if (["categorias", "ver categorias", "1"].includes(normalized)) {
    return listCategoryTree();
  }

  if (["crear", "crear credencial", "guardar", "2"].includes(normalized)) {
    setSession(from, { type: "saving", step: "category", draft: {} });
    return "Categoria?";
  }

  if (["ver categoria", "ver credenciales", "ver credenciales de categoria", "3"].includes(normalized)) {
    setSession(from, { type: "choosingCategory" });
    return listCategoriesForUnlock();
  }

  return menuText();
}

async function continueSaveFlow(
  from: string,
  text: string,
  step: "category" | "email" | "password",
  draft: SaveDraft
): Promise<string> {
  if (normalize(text) === "cancelar") {
    clearSession(from);
    return "Cancelado.";
  }

  if (step === "category") {
    setSession(from, { type: "saving", step: "email", draft: { ...draft, category: text } });
    return "Correo/User?";
  }

  if (step === "email") {
    setSession(from, { type: "saving", step: "password", draft: { ...draft, email: text } });
    return "Contrasena?";
  }

  await saveCredential({ ...draft, password: text });
  clearSession(from);

  return "Credencial guardada. La contrasena quedo cifrada.";
}

async function saveCredential(draft: SaveDraft): Promise<void> {
  if (!draft.email || !draft.password || !draft.category) {
    throw new Error("Incomplete credential draft");
  }

  const encrypted = encryptSecret(draft.password);

  await prisma.credential.create({
    data: {
      service: draft.email,
      email: draft.email,
      category: draft.category,
      aliases: [],
      passwordCiphertext: encrypted.ciphertext,
      passwordIv: encrypted.iv,
      passwordAuthTag: encrypted.authTag
    }
  });
}

async function listCategoryTree(): Promise<string> {
  const credentials = await prisma.credential.findMany({
    select: { category: true, email: true },
    orderBy: [{ category: "asc" }, { email: "asc" }]
  });

  if (credentials.length === 0) {
    return "Aun no hay categorias guardadas.";
  }

  const lines = ["Categorias:"];
  let currentCategory = "";

  for (const credential of credentials) {
    if (credential.category !== currentCategory) {
      currentCategory = credential.category;
      lines.push("", `-----${currentCategory}-----`);
    }

    lines.push(credential.email);
  }

  return lines.join("\n");
}

async function chooseCategory(from: string, category: string): Promise<string> {
  const exists = await prisma.credential.findFirst({
    where: { category: { equals: category, mode: "insensitive" } },
    select: { category: true }
  });

  if (!exists) {
    return "No encontre esa categoria. Escribe otra categoria o menu.";
  }

  setSession(from, { type: "unlockingCategory", category: exists.category });
  return `Categoria ${exists.category} seleccionada. Escribe tu PIN para ver las contrasenas.`;
}

async function listCategoriesForUnlock(): Promise<string> {
  const categories = await prisma.credential.findMany({
    distinct: ["category"],
    select: { category: true },
    orderBy: { category: "asc" }
  });

  if (categories.length === 0) {
    return "Aun no hay categorias guardadas.";
  }

  return [
    "Que categoria quieres desbloquear?",
    "",
    ...categories.map((item) => `-----${item.category}-----`)
  ].join("\n");
}

async function unlockCategory(from: string, pin: string, category: string): Promise<string> {
  if (!isValidPin(pin)) {
    clearSession(from);
    return "PIN incorrecto. Sesion cerrada.";
  }

  const credentials = await prisma.credential.findMany({
    where: { category },
    orderBy: { email: "asc" }
  });

  clearSession(from);

  if (credentials.length === 0) {
    return "No encontre credenciales en esa categoria.";
  }

  const lines = [`Credenciales de ${category}:`, ""];

  for (const credential of credentials) {
    const password = decryptSecret({
      ciphertext: credential.passwordCiphertext,
      iv: credential.passwordIv,
      authTag: credential.passwordAuthTag
    });

    lines.push(`${credential.email}`);
    lines.push(`Contrasena: ${password}`);
    lines.push("");
  }

  lines.push("Tip: borra este mensaje cuando termines de usarlo.");

  return lines.join("\n");
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
