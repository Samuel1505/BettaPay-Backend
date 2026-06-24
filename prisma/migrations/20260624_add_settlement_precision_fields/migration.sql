-- Migration: add_settlement_precision_fields
--
-- Changes:
--   1. Drop the Decimal totalAmount column (replaces with TEXT to avoid precision loss)
--   2. Add grossAmount, feeAmount, netAmount as TEXT (full-precision decimal strings)
--   3. Add feeBps as INTEGER
--
-- Strategy: string-based storage for all monetary amounts preserves full decimal
-- precision for 6-decimal assets (e.g. USDC) without floating-point rounding.

ALTER TABLE "Settlement"
  ALTER COLUMN "totalAmount" TYPE TEXT USING "totalAmount"::TEXT,
  ADD COLUMN "grossAmount" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "feeAmount"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "netAmount"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "feeBps"      INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows: treat legacy totalAmount as gross, zero fee/net
UPDATE "Settlement"
   SET "grossAmount" = "totalAmount",
       "feeAmount"   = '0',
       "netAmount"   = "totalAmount"
 WHERE "grossAmount" = '';

-- Drop defaults (enforce application-level writes going forward)
ALTER TABLE "Settlement"
  ALTER COLUMN "grossAmount" DROP DEFAULT,
  ALTER COLUMN "feeAmount"   DROP DEFAULT,
  ALTER COLUMN "netAmount"   DROP DEFAULT,
  ALTER COLUMN "feeBps"      DROP DEFAULT;
