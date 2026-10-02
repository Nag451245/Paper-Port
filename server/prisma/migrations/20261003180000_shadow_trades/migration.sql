-- CreateTable
CREATE TABLE "shadow_trades" (
    "id" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "signal_at" TIMESTAMP(3) NOT NULL,
    "signal_price" DOUBLE PRECISION NOT NULL,
    "stop_dist" DOUBLE PRECISION NOT NULL,
    "target_dist" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "entry_at" TIMESTAMP(3),
    "entry" DOUBLE PRECISION,
    "exit_at" TIMESTAMP(3),
    "exit_price" DOUBLE PRECISION,
    "exit_reason" TEXT,
    "r_multiple" DOUBLE PRECISION,
    "net_return" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shadow_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shadow_trades_status_day_idx" ON "shadow_trades"("status", "day");

-- CreateIndex
CREATE INDEX "shadow_trades_strategy_status_idx" ON "shadow_trades"("strategy", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shadow_trades_strategy_symbol_side_day_key" ON "shadow_trades"("strategy", "symbol", "side", "day");

