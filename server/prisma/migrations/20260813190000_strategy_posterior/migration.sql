-- Persistent Bayesian posterior per strategy — the bandit's memory.
--
-- This lived only in Redis, under `cg:thompson:{userId}:{strategyTag}`, written
-- with `EX 24*3600`. Two defects, and the first means the learning did not
-- accumulate at all:
--
--   1. A 24-HOUR TTL. The posterior expired daily and reset to
--      {alpha:1, beta:1, emaWinRate:0.5, totalTrades:0} — a uniform prior, i.e.
--      total ignorance. A strategy with two hundred trades of history became
--      indistinguishable from one that had never traded.
--
--   2. The writer opened with `if (!redis) return`, so with Redis absent or down
--      the update was silently discarded — no error, no fallback.
--
-- It was also a read-modify-write with no transaction, so two outcomes settling
-- concurrently could lose an increment. The writer is now a single atomic upsert.
--
-- Why this went unnoticed: a bandit that resets to a uniform prior does not look
-- broken, it looks cautious. It explores and allocates evenly, which reads as
-- sensible risk behaviour rather than amnesia — and totalTrades starting at 0
-- looks like a fresh day rather than lost history.
--
-- Postgres is the system of record. Redis may cache reads; its absence must never
-- lose a recorded outcome.
CREATE TABLE "strategy_posteriors" (
    "user_id" TEXT NOT NULL,
    "strategy_tag" TEXT NOT NULL,
    "alpha" INTEGER NOT NULL DEFAULT 1,
    "beta" INTEGER NOT NULL DEFAULT 1,
    "ema_win_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "total_trades" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategy_posteriors_pkey" PRIMARY KEY ("user_id","strategy_tag")
);
