-- ════════════════════════════════════════════════════════════════════════════
-- part_inventory_consumption — reversal markers (for build-order cancel).
--
-- Cancelling an ISSUED manufacturing build must return the parts it consumed
-- into WIP back to part inventory. The style side already has this: mig
-- 20260930000000 added reversed_at / reversed_by_user_id to inventory_consumption
-- so restoreInvoiceConsumption can put units back and stamp the draw reversed.
-- The parts ledger (part_inventory_consumption) had no such markers — this adds
-- them so a build-cancel part-restore can be a true, idempotent reversal (add the
-- qty back to the source layer, stamp the draw reversed) rather than a delete.
--
-- Additive + idempotent. The table is append-only from the app (SELECT+INSERT
-- RLS); the restore runs under the service role, which bypasses RLS, so no new
-- UPDATE policy is required.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE part_inventory_consumption
  ADD COLUMN IF NOT EXISTS reversed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Live (un-reversed) build-issue draws for a given build — the exact query the
-- part restore runs. Partial index keeps the lookup cheap as the ledger grows.
CREATE INDEX IF NOT EXISTS idx_part_inventory_consumption_build_live
  ON part_inventory_consumption (consumer_build_order_id)
  WHERE consumer_kind = 'build_issue' AND reversed_at IS NULL;

COMMENT ON COLUMN part_inventory_consumption.reversed_at IS 'Set when a build-issue draw is reversed (build-order cancel returns the parts to inventory). NULL = live draw.';

NOTIFY pgrst, 'reload schema';
