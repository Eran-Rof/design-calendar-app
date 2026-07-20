-- Production-Manager approval gate for planning-pushed purchase orders.
--
-- A PO created from a planning buy plan (api/internal/planning/buy-plan-to-po,
-- h601) is stamped requires_production_approval=true + production_approval_status
-- ='pending'. It cannot be ISSUED (draft->issued in purchase-orders/[id].js)
-- until the Production Manager approves it. The Production Manager is resolved
-- data-first as the active employee titled "Production Manager"
-- (api/_lib/internal-recipients.js resolveProductionManager). Manually-created
-- procurement POs are unaffected (the flag defaults false).
--
-- Idempotent: guarded ADD COLUMN IF NOT EXISTS.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS requires_production_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS production_approval_status text,
  ADD COLUMN IF NOT EXISTS production_approval_note text,
  ADD COLUMN IF NOT EXISTS production_approval_by text,
  ADD COLUMN IF NOT EXISTS production_approval_at timestamptz,
  ADD COLUMN IF NOT EXISTS production_requested_by text;

-- Status is null for POs that don't need approval; otherwise pending/approved/rejected.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_production_approval_status_check'
  ) THEN
    ALTER TABLE purchase_orders
      ADD CONSTRAINT purchase_orders_production_approval_status_check
      CHECK (production_approval_status IS NULL
             OR production_approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

-- Fast lookup for the "Pending production approval" worklist.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_production_pending
  ON purchase_orders (entity_id)
  WHERE requires_production_approval AND production_approval_status = 'pending';

COMMENT ON COLUMN purchase_orders.requires_production_approval IS
  'True for POs created from a planning buy plan; they need Production Manager sign-off before they can be issued.';
COMMENT ON COLUMN purchase_orders.production_approval_status IS
  'pending | approved | rejected (null when approval is not required).';
COMMENT ON COLUMN purchase_orders.production_requested_by IS
  'Email of the planner who pushed this PO from the buy plan (notified of the approve/reject outcome).';
