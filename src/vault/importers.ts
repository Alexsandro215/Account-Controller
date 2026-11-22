import { foldText } from "./search.js";

// Imports CSV exports from Chrome/Edge/Brave, Firefox, Bitwarden, 1Password and similar.
// Columns are recognized by name, so most password managers work without special cases.

export type ImportedCredential = {
  category: string;
  service: string;
  email: string;
  password: string;
  notes: string | null;
  totp: string | null;
};

export type ImportResult = {
  format: string;
  items: ImportedCredential[];
  skipped: number;
};

export const DEFAULT_IMPORT_CATEGORY = "Importadas";

const COLUMN_ALIASES = {
  service: ["name", "title", "service", "servicio", "nombre", "site", "sitio"],
  url: ["url", "website", "login_uri", "uri", "sitio web", "web site", "origin_url"],
  email: ["username", "login_username", "user", "usuario", "email", "correo", "login", "user name"],
  password: ["password", "login_password", "contrasena", "pass", "clave"],
  notes: ["note", "notes", "notas", "extra", "comments"],
  totp: ["totp", "login_totp", "otp", "otpauth", "2fa", "one-time password"],
  category: ["folder", "category", "categoria", "group", "grouping", "carpeta", "collections", "tags"],
  type: ["type"]
} as const;

type Column = keyof typeof COLUMN_ALIASES;

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const input = text.replace(/^﻿/, "");

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export function importCsv(text: string): ImportResult {
  const rows = parseCsv(text);

  if (rows.length < 2) {
    return { format: "desconocido", items: [], skipped: 0 };
  }

  const header = rows[0].map((cell) => foldText(cell));
  const columns = locateColumns(header);

  if (columns.password === undefined) {
    throw new Error("No encontré una columna de contraseñas en el CSV.");
  }

  const items: ImportedCredential[] = [];
  let skipped = 0;

  for (const cells of rows.slice(1)) {
    const get = (column: Column) => {
      const index = columns[column];
      return index === undefined ? "" : (cells[index] ?? "").trim();
    };

    const type = get("type").toLowerCase();
    const password = columns.password === undefined ? "" : cells[columns.password] ?? "";

    // Bitwarden exports cards, notes and identities too; only logins have passwords.
    if ((type !== "" && type !== "login" && type !== "1") || password.trim() === "") {
      skipped++;
      continue;
    }

    const url = get("url");
    const named = get("service");
    // When the name came from its own column, keep the URL in the notes so it is not lost.
    const notes = [get("notes"), named && url ? `Sitio: ${url}` : ""].filter(Boolean).join("\n");

    items.push({
      category: firstCategory(get("category")) || DEFAULT_IMPORT_CATEGORY,
      service: named || hostnameOf(url) || "Sin nombre",
      email: get("email") || "(sin usuario)",
      password,
      notes: notes || null,
      totp: get("totp") || null
    });
  }

  return { format: detectFormat(header), items, skipped };
}

function locateColumns(header: string[]): Partial<Record<Column, number>> {
  const result: Partial<Record<Column, number>> = {};

  for (const column of Object.keys(COLUMN_ALIASES) as Column[]) {
    for (const alias of COLUMN_ALIASES[column]) {
      const index = header.indexOf(alias);

      if (index !== -1) {
        result[column] = index;
        break;
      }
    }
  }

  return result;
}

function detectFormat(header: string[]): string {
  if (header.includes("login_password")) return "Bitwarden";
  if (header.includes("httprealm") || header.includes("formactionorigin")) return "Firefox";
  if (header.includes("otpauth") || header.includes("archived")) return "1Password";
  if (header.includes("name") && header.includes("url") && header.includes("username")) return "Chrome/Edge";
  return "CSV";
}

function hostnameOf(url: string): string {
  if (!url) {
    return "";
  }

  try {
    const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "";
  }
}

function firstCategory(value: string): string {
  // "tags"/"collections" can hold several values; keep the first one.
  return value.split(/[;,|]/)[0]?.trim() ?? "";
}
