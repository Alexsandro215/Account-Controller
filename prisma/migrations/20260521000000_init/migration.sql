CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "passwordCiphertext" TEXT NOT NULL,
    "passwordIv" TEXT NOT NULL,
    "passwordAuthTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Credential_service_idx" ON "Credential"("service");
CREATE INDEX "Credential_email_idx" ON "Credential"("email");
CREATE INDEX "Credential_category_idx" ON "Credential"("category");
