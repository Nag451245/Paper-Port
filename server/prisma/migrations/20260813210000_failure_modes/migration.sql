-- Known execution failures — the deterministic half of "learn from failure".
--
-- Strategy losses are mostly noise and belong to the statistical layer: a
-- profitable system loses 40-50% of the time, so suppressing the setups that
-- produced individual losses would destroy the edge. EXECUTION failures are the
-- opposite — a malformed payload, a missing expiry, an unbalanced spread. One
-- identifiable cause, recurs identically, and "never do this again" is literally
-- correct.
--
-- `fingerprint` deliberately EXCLUDES strike, expiry, order id, quantity and
-- amounts. A fingerprint containing next week's expiry would never match itself
-- again, which would make the registry useless. The cause is normalised for the
-- same reason: "need 216000, have 184000" and the same message with other amounts
-- are ONE defect.
--
-- Whether a recorded failure BLOCKS is decided by its CLASS, not by an occurrence
-- count. A count cannot tell the two cases apart: a malformed order can never
-- succeed and must be blocked on the first occurrence, while a broker timeout
-- must never block however often it happens — turning a five-minute outage into a
-- permanent halt would be a worse failure than the one being recorded.
CREATE TABLE "failure_modes" (
    "fingerprint" TEXT NOT NULL,
    "failure_class" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "instrument_type" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "normalized_cause" TEXT NOT NULL,
    "sample_cause" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "failure_modes_pkey" PRIMARY KEY ("fingerprint")
);

CREATE INDEX "failure_modes_blocked_idx" ON "failure_modes"("blocked");

CREATE INDEX "failure_modes_failure_class_last_seen_at_idx" ON "failure_modes"("failure_class", "last_seen_at");
