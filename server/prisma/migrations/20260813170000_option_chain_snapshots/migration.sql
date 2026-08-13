-- Historical option-chain snapshots.
--
-- Nothing persisted option-chain data before this, which blocked two things.
--
-- 1. An options backtest was impossible. There was no premium, IV or open-interest
--    history to replay, and `backtest-engine.service.ts` has no concept of a
--    chain at all — so "does this options strategy have an edge" was not an
--    answerable question.
--
-- 2. `calculateIVPercentile(currentIV, historicalIVs)` was being handed the IVs
--    across strikes in the CURRENT chain, because there was no history to hand
--    it. That measures where ATM IV sits within today's volatility SMILE rather
--    than within its own past. The wings of a smile carry higher IV than ATM, so
--    it reported a systematically LOW percentile regardless of the actual vol
--    regime — meaning a rule gated on "IV percentile is high" would essentially
--    never fire. It fed both bot decisions and the LLM prompts.
--
-- The unique constraint is what makes the writer idempotent: a retried or
-- overlapping snapshot job cannot double-count a strike within one capture.
--
-- Retention is a real concern and is NOT handled here: a full NIFTY chain is
-- roughly 100 strikes x 2 rights, so one capture per minute per underlying is
-- ~72k rows/day. Decide a capture cadence and a pruning policy before running
-- this continuously in production.
CREATE TABLE "option_chain_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "underlying" TEXT NOT NULL,
    "expiry" TIMESTAMP(3) NOT NULL,
    "strike" DECIMAL(65,30) NOT NULL,
    "option_type" TEXT NOT NULL,
    "underlying_value" DECIMAL(65,30),
    "ltp" DECIMAL(65,30),
    "iv" DECIMAL(65,30),
    "oi" BIGINT,
    "oi_change" BIGINT,
    "volume" BIGINT,
    "bid_price" DECIMAL(65,30),
    "ask_price" DECIMAL(65,30),
    "captured_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_chain_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "option_chain_snapshots_underlying_expiry_captured_at_idx" ON "option_chain_snapshots"("underlying", "expiry", "captured_at");

CREATE INDEX "option_chain_snapshots_underlying_captured_at_idx" ON "option_chain_snapshots"("underlying", "captured_at");

CREATE UNIQUE INDEX "option_chain_snapshots_underlying_expiry_strike_option_type_key" ON "option_chain_snapshots"("underlying", "expiry", "strike", "option_type", "captured_at");
