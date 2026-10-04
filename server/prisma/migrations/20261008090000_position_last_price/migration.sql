-- One saved valuation price per open position, shared by every page.
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "last_price" DECIMAL(65,30);
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "last_price_at" TIMESTAMP(3);
