import { prisma } from "./prisma.js";
import type { Store } from "./store.js";

export const prismaStore: Store = {
  credentials: {
    list: () => prisma.credential.findMany({ orderBy: [{ category: "asc" }, { service: "asc" }] }),
    get: (id) => prisma.credential.findUnique({ where: { id } }),
    create: (data) => prisma.credential.create({ data }),
    update: (id, patch) => prisma.credential.update({ where: { id }, data: patch }),
    remove: async (id) => {
      await prisma.credential.delete({ where: { id } });
    }
  },

  history: {
    add: async (credentialId, passwordSealed, replacedAt) => {
      await prisma.credentialHistory.create({ data: { credentialId, passwordSealed, replacedAt } });
    },
    list: (credentialId) =>
      prisma.credentialHistory.findMany({ where: { credentialId }, orderBy: { replacedAt: "desc" } })
  },

  vaultKey: {
    get: () => prisma.vaultKey.findUnique({ where: { id: 1 } }),
    save: async (row) => {
      await prisma.vaultKey.upsert({ where: { id: 1 }, create: { id: 1, ...row }, update: row });
    }
  },

  audit: {
    add: async (event) => {
      await prisma.auditEvent.create({ data: event });
    },
    recent: (limit) => prisma.auditEvent.findMany({ orderBy: { at: "desc" }, take: limit })
  },

  settings: {
    get: async (key) => (await prisma.setting.findUnique({ where: { key } }))?.value ?? null,
    set: async (key, value) => {
      await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
  },

  unlockGuard: {
    get: (userId) => prisma.unlockGuard.findUnique({ where: { userId } }),
    increment: (userId) =>
      prisma.unlockGuard.upsert({
        where: { userId },
        create: { userId, failedAttempts: 1 },
        update: { failedAttempts: { increment: 1 } }
      }),
    setLock: async (userId, lockedUntil) => {
      await prisma.unlockGuard.update({ where: { userId }, data: { lockedUntil } });
    },
    reset: async (userId) => {
      await prisma.unlockGuard.deleteMany({ where: { userId } });
    }
  },

  pendingDeletions: {
    upsert: async ({ chatId, messageId, deleteAt }) => {
      await prisma.pendingDeletion.upsert({
        where: { chatId_messageId: { chatId: BigInt(chatId), messageId } },
        create: { chatId: BigInt(chatId), messageId, deleteAt },
        update: { deleteAt }
      });
    },
    listAll: async () => toPending(await prisma.pendingDeletion.findMany()),
    listForChat: async (chatId) =>
      toPending(await prisma.pendingDeletion.findMany({ where: { chatId: BigInt(chatId) } })),
    remove: async (chatId, messageId) => {
      await prisma.pendingDeletion.deleteMany({ where: { chatId: BigInt(chatId), messageId } });
    },
    purgeBefore: async (date) => {
      await prisma.pendingDeletion.deleteMany({ where: { deleteAt: { lt: date } } });
    }
  },

  ping: async () => {
    await prisma.$queryRaw`SELECT 1`;
  }
};

function toPending(rows: { chatId: bigint; messageId: number; deleteAt: Date }[]) {
  return rows.map((row) => ({ chatId: Number(row.chatId), messageId: row.messageId, deleteAt: row.deleteAt }));
}
