export type SaveDraft = {
  email?: string;
  password?: string;
  category?: string;
};

export type Session =
  | { type: "saving"; step: "category" | "email" | "password"; draft: SaveDraft; expiresAt: number }
  | { type: "choosingCategory"; expiresAt: number }
  | { type: "unlockingCategory"; category: string; expiresAt: number };

export type SessionInput =
  | { type: "saving"; step: "category" | "email" | "password"; draft: SaveDraft }
  | { type: "choosingCategory" }
  | { type: "unlockingCategory"; category: string };

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
