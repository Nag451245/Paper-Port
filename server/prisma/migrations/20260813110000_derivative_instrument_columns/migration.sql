-- Derivative (F&O / commodity) contract identity as real columns.
--
-- Previously the only place a strike or expiry could live was the `strategy_tag`
-- string, encoded as "OPT:CE:24000:2026-08-28". That was unworkable for two
-- reasons beyond the obvious fragility:
--
--   1. `strategy_tag` is simultaneously the strategy-attribution key used by the
--      learning engine (Thompson sampling, Bayesian updates, alpha decay,
--      allocation caps, analytics grouping). A position could carry contract
--      metadata OR a strategy name, never both, so every option trade was
--      invisible to attribution.
--   2. Product type (INTRADAY vs DELIVERY) was encoded in that same string, so
--      `convertToDelivery` did a `replace('INTRADAY','DELIVERY')` that was a
--      no-op for any tag not containing the word INTRADAY — it reported success
--      while leaving the position eligible for EOD square-off. `product` is now
--      its own column.
--
-- Every column here is NULLABLE and no backfill happens in this migration:
-- equity rows legitimately leave them unset, existing rows predate them, and a
-- separate idempotent script migrates legacy "OPT:" tags while flagging (never
-- guessing) anything it cannot parse.
--
-- Note on units: `qty` stays in UNITS (contracts) everywhere. `lot_size` records
-- units-per-lot so that lots remain a display/input concern only. Redefining
-- `qty` as lots would silently change the meaning of every cost, P&L, NAV and
-- position-sizing calculation in the codebase.

-- ── positions ──
ALTER TABLE "positions" ADD COLUMN "segment" TEXT;
ALTER TABLE "positions" ADD COLUMN "instrument_type" TEXT;
ALTER TABLE "positions" ADD COLUMN "underlying" TEXT;
ALTER TABLE "positions" ADD COLUMN "expiry" TIMESTAMP(3);
ALTER TABLE "positions" ADD COLUMN "strike" DECIMAL(65,30);
ALTER TABLE "positions" ADD COLUMN "option_type" TEXT;
ALTER TABLE "positions" ADD COLUMN "lot_size" INTEGER;
ALTER TABLE "positions" ADD COLUMN "product" TEXT;
ALTER TABLE "positions" ADD COLUMN "meta_needs_review" BOOLEAN NOT NULL DEFAULT false;

-- ── orders ──
ALTER TABLE "orders" ADD COLUMN "segment" TEXT;
ALTER TABLE "orders" ADD COLUMN "instrument_type" TEXT;
ALTER TABLE "orders" ADD COLUMN "underlying" TEXT;
ALTER TABLE "orders" ADD COLUMN "expiry" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "strike" DECIMAL(65,30);
ALTER TABLE "orders" ADD COLUMN "option_type" TEXT;
ALTER TABLE "orders" ADD COLUMN "lot_size" INTEGER;
ALTER TABLE "orders" ADD COLUMN "product" TEXT;

-- ── trades ──
ALTER TABLE "trades" ADD COLUMN "segment" TEXT;
ALTER TABLE "trades" ADD COLUMN "instrument_type" TEXT;
ALTER TABLE "trades" ADD COLUMN "underlying" TEXT;
ALTER TABLE "trades" ADD COLUMN "expiry" TIMESTAMP(3);
ALTER TABLE "trades" ADD COLUMN "strike" DECIMAL(65,30);
ALTER TABLE "trades" ADD COLUMN "option_type" TEXT;
ALTER TABLE "trades" ADD COLUMN "lot_size" INTEGER;
ALTER TABLE "trades" ADD COLUMN "product" TEXT;

-- Position netting looks up {portfolio_id, symbol, side, status} and was served
-- only by the single-column index on "symbol". The lookup now additionally
-- discriminates on expiry/strike/option_type; those are left out of the index
-- because the four-column prefix is already selective down to a handful of rows.
CREATE INDEX "positions_portfolio_id_symbol_side_status_idx"
  ON "positions"("portfolio_id", "symbol", "side", "status");
