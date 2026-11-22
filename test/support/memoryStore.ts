import { randomUUID } from "node:crypto";
import type {
  AuditRow,
  CredentialRow,
  GuardRow,
  HistoryRow,
  PendingDeletionRow,
  Store,
  VaultKeyRow
} from "../../src/db/store.js";

/** In-memory Store with the same semantics as the Prisma one. */
export function createMemoryStore() {
  const credentials = new Map<string, CredentialRow>();
  const history: HistoryRow[] = [];
  const audit: AuditRow[] = [];
  const settings = new Map<string, string>();
  const guards = new Map<string, GuardRow>();
  const pending = new Map<string, PendingDeletionRow>();
  let vaultKey: VaultKeyRow | null = null;
  let clock = Date.now();
  const tick = () => new Date(++clock);

  const store: Store = {
    credentials: {
      list: async () => [...credentials.values()].map((row) => ({ ...row })),
      get: async (id) => (credentials.has(id) ? { ...credentials.get(id)! } : null),
      create: async (data) => {
        if (credentials.has(data.id)) throw new Error(`Duplicate id ${data.id}`);
        const now = tick();
        const row: CredentialRow = {
          id: data.id,
          service: data.service,
          email: data.email,
          category: data.category,
          aliases: data.aliases ?? [],
          passwordSealed: data.passwordSealed,
          notesSealed: data.notesSealed ?? null,
          totpSealed: data.totpSealed ?? null,
          passwordChangedAt: data.passwordChangedAt ?? now,
          createdAt: data.createdAt ?? now,
          updatedAt: now,
          notes: null,
          passwordCiphertext: null,
          passwordIv: null,
          passwordAuthTag: null
        };
        credentials.set(row.id, row);
        return { ...row };
      },
      update: async (id, patch) => {
        const row = credentials.get(id);
        if (!row) throw new Error(`No credential ${id}`);
        const updated = { ...row, ...patch, updatedAt: tick() };
        credentials.set(id, updated);
        return { ...updated };
      },
      remove: async (id) => {
        if (!credentials.delete(id)) throw new Error(`No credential ${id}`);
        // ON DELETE CASCADE
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].credentialId === id) history.splice(i, 1);
        }
      }
    },
    history: {
      add: async (credentialId, passwordSealed, replacedAt) => {
        history.push({ id: randomUUID(), credentialId, passwordSealed, replacedAt: replacedAt ?? tick() });
      },
      list: async (credentialId) =>
        history
          .filter((entry) => entry.credentialId === credentialId)
          .sort((a, b) => b.replacedAt.getTime() - a.replacedAt.getTime())
    },
    vaultKey: {
      get: async () => (vaultKey ? { ...vaultKey } : null),
      save: async (row) => {
        vaultKey = { ...row };
      }
    },
    audit: {
      add: async (event) => {
        audit.push({
          id: randomUUID(),
          at: tick(),
          action: event.action,
          credentialId: event.credentialId ?? null,
          label: event.label ?? null,
          detail: event.detail ?? null
        });
      },
      recent: async (limit) => [...audit].reverse().slice(0, limit)
    },
    settings: {
      get: async (key) => settings.get(key) ?? null,
      set: async (key, value) => {
        settings.set(key, value);
      }
    },
    unlockGuard: {
      get: async (userId) => (guards.has(userId) ? { ...guards.get(userId)! } : null),
      increment: async (userId) => {
        const guard = guards.get(userId) ?? { userId, failedAttempts: 0, lockedUntil: null };
        const updated = { ...guard, failedAttempts: guard.failedAttempts + 1 };
        guards.set(userId, updated);
        return { ...updated };
      },
      setLock: async (userId, lockedUntil) => {
        const guard = guards.get(userId);
        if (guard) guards.set(userId, { ...guard, lockedUntil });
      },
      reset: async (userId) => {
        guards.delete(userId);
      }
    },
    pendingDeletions: {
      upsert: async (row) => {
        pending.set(`${row.chatId}:${row.messageId}`, { ...row });
      },
      listAll: async () => [...pending.values()],
      listForChat: async (chatId) => [...pending.values()].filter((row) => row.chatId === chatId),
      remove: async (chatId, messageId) => {
        pending.delete(`${chatId}:${messageId}`);
      },
      purgeBefore: async (date) => {
        for (const [key, row] of pending) {
          if (row.deleteAt < date) pending.delete(key);
        }
      }
    },
    ping: async () => {}
  };

  return {
    store,
    /** Direct access for assertions and for simulating attacks/legacy data. */
    raw: { credentials, history, audit, settings, guards, pending, getVaultKey: () => vaultKey }
  };
}
