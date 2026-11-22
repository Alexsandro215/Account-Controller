import type { Store } from "../../src/db/store.js";
import { createMemoryStore } from "./memoryStore.js";

/**
 * A clean store for an end-to-end test: PostgreSQL through Prisma when TEST_DATABASE_URL is
 * set (CI, or a local database), the in-memory store otherwise.
 */
export async function freshStore(): Promise<Store> {
  if (!process.env.TEST_DATABASE_URL) {
    return createMemoryStore().store;
  }

  const { prisma } = await import("../../src/db/prisma.js");
  const { prismaStore } = await import("../../src/db/prismaStore.js");
  await prisma.$executeRawUnsafe(
    'TRUNCATE "CredentialHistory", "Credential", "VaultKey", "AuditEvent", "Setting", "PendingDeletion", "UnlockGuard" CASCADE'
  );
  return prismaStore;
}

export async function closeStores(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) {
    const { prisma } = await import("../../src/db/prisma.js");
    await prisma.$disconnect();
  }
}
