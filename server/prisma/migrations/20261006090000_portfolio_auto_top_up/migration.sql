-- Automatic capital top-up (up to 50 lakh) when the user's own order needs it.
ALTER TABLE "portfolios" ADD COLUMN IF NOT EXISTS "auto_top_up" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "portfolios" ADD COLUMN IF NOT EXISTS "auto_topped_up" DECIMAL(65,30) NOT NULL DEFAULT 0;
