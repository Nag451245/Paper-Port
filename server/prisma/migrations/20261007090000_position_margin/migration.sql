-- Realistic margins: each position records what was blocked for it.
-- Existing rows stay NULL and keep the old flat rule, so no cash moves on deploy.
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "margin_blocked" DECIMAL(65,30);
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "margin_link_id" TEXT;
