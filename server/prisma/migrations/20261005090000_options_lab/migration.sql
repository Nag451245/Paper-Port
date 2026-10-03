-- Strategy Builder exit plans and options backtest runs.
CREATE TABLE IF NOT EXISTS "strategy_exit_plans" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "strategy_tag" TEXT NOT NULL,
    "target_rupees" DOUBLE PRECISION,
    "stop_rupees" DOUBLE PRECISION,
    "exit_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "closed_pnl" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "strategy_exit_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_exit_plans_user_id_strategy_tag_key" ON "strategy_exit_plans"("user_id", "strategy_tag");
CREATE INDEX IF NOT EXISTS "strategy_exit_plans_status_idx" ON "strategy_exit_plans"("status");

CREATE TABLE IF NOT EXISTS "option_backtest_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "date_from" TEXT NOT NULL,
    "date_to" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "trades" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "option_backtest_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "option_backtest_runs_user_id_created_at_idx" ON "option_backtest_runs"("user_id", "created_at");
