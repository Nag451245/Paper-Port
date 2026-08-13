-- Idempotency key for order placement.
--
-- The UNIQUE constraint is the enforcement mechanism, not the application-level
-- lookup: two concurrent requests carrying the same key both attempt the insert
-- and exactly one wins, so a retry cannot become a second live order.
ALTER TABLE "orders" ADD COLUMN "client_order_id" TEXT;

CREATE UNIQUE INDEX "orders_client_order_id_key" ON "orders"("client_order_id");
