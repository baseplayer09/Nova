-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_encryption_keys" (
    "profile_id" UUID NOT NULL,
    "wrapped_data_key" BYTEA NOT NULL,
    "wrap_nonce" BYTEA NOT NULL,
    "wrap_auth_tag" BYTEA NOT NULL,
    "kek_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_encryption_keys_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pin_credentials" (
    "profile_id" UUID NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "failed_attempts" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_credentials_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(6),

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connected_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_refresh_token" BYTEA NOT NULL,
    "token_nonce" BYTEA NOT NULL,
    "token_auth_tag" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connected_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "prompt_ciphertext" BYTEA NOT NULL,
    "prompt_nonce" BYTEA NOT NULL,
    "prompt_auth_tag" BYTEA NOT NULL,
    "timezone" TEXT NOT NULL,
    "local_time" TEXT NOT NULL,
    "schedule_days" INTEGER[],
    "next_run_at" TIMESTAMPTZ(6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routine_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "routine_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "routine_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_profile_created_at_idx" ON "conversations"("profile_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_profile_id_key" ON "conversations"("id", "profile_id");

-- CreateIndex
CREATE INDEX "messages_profile_conversation_created_at_idx" ON "messages"("profile_id", "conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "memories_profile_status_created_at_idx" ON "memories"("profile_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "connected_accounts_profile_provider_key" ON "connected_accounts"("profile_id", "provider");

-- CreateIndex
CREATE INDEX "routines_enabled_next_run_at_idx" ON "routines"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "routines_profile_created_at_idx" ON "routines"("profile_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "routines_id_profile_id_key" ON "routines"("id", "profile_id");

-- CreateIndex
CREATE INDEX "routine_runs_profile_status_scheduled_idx" ON "routine_runs"("profile_id", "status", "scheduled_for" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "routine_runs_routine_scheduled_for_key" ON "routine_runs"("routine_id", "scheduled_for");

-- AddForeignKey
ALTER TABLE "profile_encryption_keys" ADD CONSTRAINT "profile_encryption_keys_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_profile_id_fkey" FOREIGN KEY ("conversation_id", "profile_id") REFERENCES "conversations"("id", "profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin_credentials" ADD CONSTRAINT "pin_credentials_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routines" ADD CONSTRAINT "routines_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_profile_id_fkey" FOREIGN KEY ("routine_id", "profile_id") REFERENCES "routines"("id", "profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
