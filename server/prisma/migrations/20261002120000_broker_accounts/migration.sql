-- AlterTable
ALTER TABLE "users" ADD COLUMN     "active_broker" TEXT NOT NULL DEFAULT 'breeze';

-- CreateTable
CREATE TABLE "broker_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "broker" TEXT NOT NULL,
    "encrypted_api_key" TEXT,
    "encrypted_api_secret" TEXT,
    "encrypted_client_id" TEXT,
    "encrypted_access_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broker_accounts_user_id_broker_key" ON "broker_accounts"("user_id", "broker");

-- AddForeignKey
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

