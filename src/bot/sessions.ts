export type SaveDraft = {
  service?: string;
  email?: string;
  password?: string;
  category?: string;
  aliases?: string[];
  notes?: string;
};

export type Session =
  | { type: "saving"; step: "service" | "email" | "password" | "category" | "aliases" | "notes"; draft: SaveDraft; expiresAt: number }
  | { type: "choosing"; credentialIds: string[]; expiresAt: number }
  | { type: "unlocking"; credentialId: string; expiresAt: number };

export type SessionInput =
  | { type: "saving"; step: "service" | "email" | "password" | "category" | "aliases" | "notes"; draft: SaveDraft }
  | { type: "choosing"; credentialIds: string[] }
  | { type: "unlocking"; credentialId: string };

const ttlMs = 60_000;
const sessions = new Map<string, Session>();

export function setSession(phone: string, session: SessionInput): void {
  sessions.set(phone, { ...session, expiresAt: Date.now() + ttlMs } as Session);
}

export function getSession(phone: string): Session | undefined {
  const session = sessions.get(phone);

  if (!session) {
    return undefined;
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(phone);
    return undefined;
  }

  return session;
}

export function clearSession(phone: string): void {
  sessions.delete(phone);
}
