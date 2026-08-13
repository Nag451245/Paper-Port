-- Protective stop-loss resting at the broker (LIVE mode only).
--
-- Tracked on the position rather than as a row in "orders" because
-- TradeService.matchPendingOrders fills every PENDING/SUBMITTED order it finds,
-- which would spuriously trigger a resting protective stop in paper mode.
ALTER TABLE "positions" ADD COLUMN "broker_stop_order_id" TEXT;
ALTER TABLE "positions" ADD COLUMN "broker_stop_trigger_price" DECIMAL(65,30);
ALTER TABLE "positions" ADD COLUMN "broker_stop_qty" INTEGER;
ALTER TABLE "positions" ADD COLUMN "broker_stop_placed_at" TIMESTAMP(3);

-- Reconciliation looks up open positions that have a stop resting at the broker.
CREATE INDEX "positions_broker_stop_order_id_idx" ON "positions"("broker_stop_order_id");
