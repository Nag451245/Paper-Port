-- Sign-ups wait for the admin's approval; the admin can block users.
-- Everyone who already has an account stays ACTIVE.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE';
