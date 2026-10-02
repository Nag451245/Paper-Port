-- CreateTable
CREATE TABLE "stock_alerts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "details" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_alerts_user_id_created_at_idx" ON "stock_alerts"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_alerts_user_id_symbol_day_key" ON "stock_alerts"("user_id", "symbol", "day");

-- AddForeignKey
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

