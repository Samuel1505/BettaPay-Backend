-- Migration: add-idempotency-key
-- Adds two nullable columns to the Payment table for idempotency support.
--
--   idempotency_key           — the client-supplied opaque key (max 255 chars).
--                               The UNIQUE constraint is the DB-level guard that
--                               prevents duplicate inserts under concurrent load.
--
--   idempotency_key_expires_at — TTL timestamp (created_at + 24 h).
--                               The application checks this at lookup time; no
--                               hard deletes are required for correctness.
--
-- The partial index on idempotency_key_expires_at speeds up the periodic
-- cleanup query that prunes expired rows (run offline / via cron as needed).

ALTER TABLE "Payment"
  ADD COLUMN "idempotencyKey"          TEXT UNIQUE,
  ADD COLUMN "idempotencyKeyExpiresAt" TIMESTAMP(3);

-- Partial index: only index rows that still have an active key.
-- Keeps the index small as expired rows accumulate.
CREATE INDEX "Payment_idempotencyKeyExpiresAt_idx"
  ON "Payment" ("idempotencyKeyExpiresAt")
  WHERE "idempotencyKeyExpiresAt" IS NOT NULL;
