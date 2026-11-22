// Everything the app reads or writes goes through this interface, so the whole bot can be
// exercised in tests against an in-memory implementation (see test/support/memoryStore.ts).

export type CredentialRow = {
  id: string;
  service: string;
  email: string;
  category: string;
  aliases: string[];
  passwordSealed: string | null;
  notesSealed: string | null;
  totpSealed: string | null;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  // Legacy fields (pre master password).
  notes: string | null;
  passwordCiphertext: string | null;
  passwordIv: string | null;
  passwordAuthTag: string | null;
};

export type NewCredential = {
  id: string;
  service: string;
  email: string;
  category: string;
  aliases?: string[];
  passwordSealed: string;
  notesSealed?: string | null;
  totpSealed?: string | null;
  passwordChangedAt?: Date;
  createdAt?: Date;
};

export type CredentialPatch = Partial<
  Pick<
    CredentialRow,
    | "service"
    | "email"
    | "category"
    | "aliases"
    | "passwordSealed"
    | "notesSealed"
    | "totpSealed"
    | "passwordChangedAt"
    | "notes"
    | "passwordCiphertext"
    | "passwordIv"
    | "passwordAuthTag"
  >
>;

export type HistoryRow = {
  id: string;
  credentialId: string;
  passwordSealed: string;
  replacedAt: Date;
};

export type VaultKeyRow = {
  publicKey: string;
  masterSalt: string;
  masterKdf: string;
  masterWrap: string;
  recoverySalt: string;
  recoveryKdf: string;
  recoveryWrap: string;
};

export type AuditRow = {
  id: string;
  at: Date;
  action: string;
  credentialId: string | null;
  label: string | null;
  detail: string | null;
};

export type NewAuditEvent = {
  action: string;
  credentialId?: string | null;
  label?: string | null;
  detail?: string | null;
};

export type GuardRow = {
  userId: string;
  failedAttempts: number;
  lockedUntil: Date | null;
};

export type PendingDeletionRow = {
  chatId: number;
  messageId: number;
  deleteAt: Date;
};

export interface Store {
  credentials: {
    list(): Promise<CredentialRow[]>;
    get(id: string): Promise<CredentialRow | null>;
    create(data: NewCredential): Promise<CredentialRow>;
    update(id: string, patch: CredentialPatch): Promise<CredentialRow>;
    remove(id: string): Promise<void>;
  };
  history: {
    add(credentialId: string, passwordSealed: string, replacedAt?: Date): Promise<void>;
    /** Newest first. */
    list(credentialId: string): Promise<HistoryRow[]>;
  };
  vaultKey: {
    get(): Promise<VaultKeyRow | null>;
    save(row: VaultKeyRow): Promise<void>;
  };
  audit: {
    add(event: NewAuditEvent): Promise<void>;
    /** Newest first. */
    recent(limit: number): Promise<AuditRow[]>;
  };
  settings: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  unlockGuard: {
    get(userId: string): Promise<GuardRow | null>;
    /** Adds one failed attempt (creating the row if needed) and returns the new state. */
    increment(userId: string): Promise<GuardRow>;
    setLock(userId: string, lockedUntil: Date): Promise<void>;
    reset(userId: string): Promise<void>;
  };
  pendingDeletions: {
    upsert(row: PendingDeletionRow): Promise<void>;
    listAll(): Promise<PendingDeletionRow[]>;
    listForChat(chatId: number): Promise<PendingDeletionRow[]>;
    remove(chatId: number, messageId: number): Promise<void>;
    purgeBefore(date: Date): Promise<void>;
  };
  /** Throws if the database is unreachable. */
  ping(): Promise<void>;
}
