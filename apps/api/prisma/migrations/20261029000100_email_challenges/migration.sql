CREATE TYPE "EmailChallengePurpose" AS ENUM ('REGISTER', 'RESET_PASSWORD');

CREATE TABLE "EmailChallenge" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" VARCHAR(254) NOT NULL,
  "purpose" "EmailChallengePurpose" NOT NULL,
  "userId" UUID,
  "codeHash" CHAR(64) NOT NULL,
  "passwordHash" VARCHAR(255),
  "displayName" VARCHAR(100),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "resendAvailableAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailChallenge_email_check" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  CONSTRAINT "EmailChallenge_hash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EmailChallenge_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5),
  CONSTRAINT "EmailChallenge_times_check" CHECK ("expiresAt" > "createdAt" AND "resendAvailableAt" >= "createdAt" AND "resendAvailableAt" <= "expiresAt"),
  CONSTRAINT "EmailChallenge_purpose_check" CHECK (
    ("purpose" = 'REGISTER' AND "userId" IS NULL AND ("passwordHash" IS NOT NULL OR "consumedAt" IS NOT NULL))
    OR ("purpose" = 'RESET_PASSWORD' AND "passwordHash" IS NULL AND "displayName" IS NULL)
  )
);

CREATE INDEX "EmailChallenge_email_purpose_createdAt_idx" ON "EmailChallenge" ("email", "purpose", "createdAt" DESC);
CREATE INDEX "EmailChallenge_expiresAt_idx" ON "EmailChallenge" ("expiresAt");
CREATE INDEX "EmailChallenge_userId_idx" ON "EmailChallenge" ("userId");
ALTER TABLE "EmailChallenge" ADD CONSTRAINT "EmailChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
