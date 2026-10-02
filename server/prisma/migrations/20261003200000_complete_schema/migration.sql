-- Completes the migration history: tables and columns that exist in schema.prisma
-- but were never created by a migration (they were added to the live database
-- outside the migration history). Every statement is skip-if-present, so this
-- is a no-op where they already exist and creates them on a fresh database.

-- Columns first: indexes below refer to them.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ideal_price" DECIMAL(65,30);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "slippage_bps" DECIMAL(65,30);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fill_latency_ms" INTEGER;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "spread_cost_bps" DECIMAL(65,30);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "impact_cost" DECIMAL(65,30);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "broker_order_id" TEXT;

CREATE TABLE IF NOT EXISTS "candle_store" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "interval" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(65,30) NOT NULL,
    "high" DECIMAL(65,30) NOT NULL,
    "low" DECIMAL(65,30) NOT NULL,
    "close" DECIMAL(65,30) NOT NULL,
    "volume" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candle_store_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "trading_universe" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "sector" TEXT,
    "reason" TEXT,
    "avg_volume" DECIMAL(65,30),
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_universe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "alpha_decay" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sharpe_30d" DOUBLE PRECISION,
    "sharpe_60d" DOUBLE PRECISION,
    "sharpe_90d" DOUBLE PRECISION,
    "hit_rate_30d" DOUBLE PRECISION,
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "avg_time_to_profit" DOUBLE PRECISION,
    "is_decaying" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alpha_decay_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "regime_history" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "regime" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration_days" INTEGER NOT NULL DEFAULT 1,
    "nifty_change" DOUBLE PRECISION,
    "vix" DOUBLE PRECISION,
    "transition_from" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regime_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ticks" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "ltp" DOUBLE PRECISION NOT NULL,
    "bid" DOUBLE PRECISION,
    "ask" DOUBLE PRECISION,
    "bidQty" INTEGER,
    "askQty" INTEGER,
    "volume" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "historical_bars" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "timeframe" TEXT NOT NULL DEFAULT '1d',
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL,
    "adj_close" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "historical_bars_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "corporate_actions" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "ratio" DOUBLE PRECISION,
    "ex_date" TIMESTAMP(3) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corporate_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "audit_trail" (
    "id" BIGSERIAL NOT NULL,
    "order_id" TEXT,
    "position_id" TEXT,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "margin_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "segment" TEXT NOT NULL DEFAULT 'EQ',
    "var_margin" DOUBLE PRECISION NOT NULL,
    "elm_margin" DOUBLE PRECISION NOT NULL,
    "span_margin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_required" DOUBLE PRECISION NOT NULL,
    "peak_util_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "margin_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "contract_notes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "trade_date" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "brokerage" DOUBLE PRECISION NOT NULL,
    "stt" DOUBLE PRECISION NOT NULL,
    "exchange_charges" DOUBLE PRECISION NOT NULL,
    "gst" DOUBLE PRECISION NOT NULL,
    "sebi_charges" DOUBLE PRECISION NOT NULL,
    "stamp_duty" DOUBLE PRECISION NOT NULL,
    "total_cost" DOUBLE PRECISION NOT NULL,
    "net_amount" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "guardian_state" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mood" TEXT NOT NULL DEFAULT 'COMPOSED',
    "mood_intensity" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "awareness" JSONB NOT NULL DEFAULT '{}',
    "current_focus" TEXT,
    "market_stance" TEXT,
    "personality_data" JSONB NOT NULL DEFAULT '{}',
    "last_thought" TEXT,
    "last_thought_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardian_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "guardian_memories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "memory_type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sentiment" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardian_memories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "market_memory" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "nifty_level" DOUBLE PRECISION NOT NULL,
    "nifty_band" TEXT NOT NULL,
    "vix_level" DOUBLE PRECISION NOT NULL,
    "regime" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "hour_of_day" INTEGER NOT NULL,
    "gap_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "signal_strategy" TEXT NOT NULL,
    "signal_direction" TEXT NOT NULL,
    "signal_confidence" DOUBLE PRECISION NOT NULL,
    "outcome" TEXT,
    "pnl_pct" DOUBLE PRECISION,
    "holding_minutes" INTEGER,
    "fingerprint" TEXT NOT NULL,
    "key_levels" JSONB,
    "market_snapshot" JSONB,
    "lessons_learned" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "market_memory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "orders_client_order_id_key" ON "orders"("client_order_id");

CREATE INDEX IF NOT EXISTS "orders_portfolio_id_status_idx" ON "orders"("portfolio_id", "status");

CREATE INDEX IF NOT EXISTS "orders_broker_order_id_idx" ON "orders"("broker_order_id");

CREATE INDEX IF NOT EXISTS "orders_symbol_created_at_idx" ON "orders"("symbol", "created_at");

CREATE INDEX IF NOT EXISTS "candle_store_symbol_interval_timestamp_idx" ON "candle_store"("symbol", "interval", "timestamp");

CREATE UNIQUE INDEX IF NOT EXISTS "candle_store_symbol_exchange_interval_timestamp_key" ON "candle_store"("symbol", "exchange", "interval", "timestamp");

CREATE INDEX IF NOT EXISTS "trading_universe_user_id_idx" ON "trading_universe"("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "trading_universe_user_id_symbol_key" ON "trading_universe"("user_id", "symbol");

CREATE INDEX IF NOT EXISTS "alpha_decay_user_id_strategy_id_idx" ON "alpha_decay"("user_id", "strategy_id");

CREATE UNIQUE INDEX IF NOT EXISTS "alpha_decay_user_id_strategy_id_date_key" ON "alpha_decay"("user_id", "strategy_id", "date");

CREATE INDEX IF NOT EXISTS "regime_history_regime_idx" ON "regime_history"("regime");

CREATE INDEX IF NOT EXISTS "regime_history_date_idx" ON "regime_history"("date");

CREATE UNIQUE INDEX IF NOT EXISTS "regime_history_date_key" ON "regime_history"("date");

CREATE INDEX IF NOT EXISTS "ticks_symbol_timestamp_idx" ON "ticks"("symbol", "timestamp");

CREATE INDEX IF NOT EXISTS "historical_bars_symbol_timestamp_idx" ON "historical_bars"("symbol", "timestamp");

CREATE UNIQUE INDEX IF NOT EXISTS "historical_bars_symbol_exchange_timeframe_timestamp_key" ON "historical_bars"("symbol", "exchange", "timeframe", "timestamp");

CREATE INDEX IF NOT EXISTS "corporate_actions_symbol_ex_date_idx" ON "corporate_actions"("symbol", "ex_date");

CREATE INDEX IF NOT EXISTS "audit_trail_user_id_created_at_idx" ON "audit_trail"("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "audit_trail_order_id_idx" ON "audit_trail"("order_id");

CREATE INDEX IF NOT EXISTS "margin_records_user_id_snapshot_at_idx" ON "margin_records"("user_id", "snapshot_at");

CREATE INDEX IF NOT EXISTS "margin_records_symbol_idx" ON "margin_records"("symbol");

CREATE INDEX IF NOT EXISTS "contract_notes_user_id_trade_date_idx" ON "contract_notes"("user_id", "trade_date");

CREATE INDEX IF NOT EXISTS "contract_notes_order_id_idx" ON "contract_notes"("order_id");

CREATE UNIQUE INDEX IF NOT EXISTS "guardian_state_user_id_key" ON "guardian_state"("user_id");

CREATE INDEX IF NOT EXISTS "guardian_memories_user_id_memory_type_idx" ON "guardian_memories"("user_id", "memory_type");

CREATE INDEX IF NOT EXISTS "guardian_memories_user_id_subject_idx" ON "guardian_memories"("user_id", "subject");

CREATE INDEX IF NOT EXISTS "guardian_memories_user_id_created_at_idx" ON "guardian_memories"("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "market_memory_user_id_regime_nifty_band_idx" ON "market_memory"("user_id", "regime", "nifty_band");

CREATE INDEX IF NOT EXISTS "market_memory_symbol_outcome_idx" ON "market_memory"("symbol", "outcome");

CREATE INDEX IF NOT EXISTS "market_memory_user_id_created_at_idx" ON "market_memory"("user_id", "created_at");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guardian_state_user_id_fkey') THEN
    ALTER TABLE "guardian_state" ADD CONSTRAINT "guardian_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guardian_memories_user_id_fkey') THEN
    ALTER TABLE "guardian_memories" ADD CONSTRAINT "guardian_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Indexes in schema.prisma that no migration created.
CREATE INDEX IF NOT EXISTS "bot_messages_from_bot_id_message_type_idx" ON "bot_messages"("from_bot_id", "message_type");
CREATE INDEX IF NOT EXISTS "bot_messages_user_id_created_at_idx" ON "bot_messages"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "bot_tasks_bot_id_created_at_idx" ON "bot_tasks"("bot_id", "created_at");
CREATE INDEX IF NOT EXISTS "bot_tasks_user_id_status_idx" ON "bot_tasks"("user_id", "status");
