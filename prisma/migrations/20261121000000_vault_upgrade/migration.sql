-- AlterTable
ALTER TABLE "Credential" ADD COLUMN     "notesSealed" TEXT,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "passwordSealed" TEXT,
ADD COLUMN     "totpSealed" TEXT,
ALTER COLUMN "passwordCiphertext" DROP NOT NULL,
ALTER COLUMN "passwordIv" DROP NOT NULL,
ALTER COLUMN "passwordAuthTag" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CredentialHistory" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "passwordSealed" TEXT NOT NULL,
    "replacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultKey" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publicKey" TEXT NOT NULL,
    "masterSalt" TEXT NOT NULL,
    "masterKdf" TEXT NOT NULL,
    "masterWrap" TEXT NOT NULL,
    "recoverySalt" TEXT NOT NULL,
    "recoveryKdf" TEXT NOT NULL,
    "recoveryWrap" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "credentialId" TEXT,
    "label" TEXT,
    "detail" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PendingDeletion" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "deleteAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnlockGuard" (
    "userId" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnlockGuard_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "CredentialHistory_credentialId_idx" ON "CredentialHistory"("credentialId");

-- CreateIndex
CREATE INDEX "AuditEvent_at_idx" ON "AuditEvent"("at");

-- CreateIndex
CREATE INDEX "PendingDeletion_deleteAt_idx" ON "PendingDeletion"("deleteAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingDeletion_chatId_messageId_key" ON "PendingDeletion"("chatId", "messageId");

-- AddForeignKey
ALTER TABLE "CredentialHistory" ADD CONSTRAINT "CredentialHistory_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data fixes for credentials created before this version
-- The real "last changed" date of existing passwords is when they were created.
UPDATE "Credential" SET "passwordChangedAt" = "createdAt";
-- The old bot stored the email as the service name; the category was acting as the service.
UPDATE "Credential" SET "service" = "category" WHERE "service" = "email";
