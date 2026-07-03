-- 20260950000000_build_conversion_po_mode.sql
--
-- M11 (conversion PO) — configurable GL mode for a build's conversion PO.
--
-- A build's conversion PO (mfg_build_orders.conversion_po_id) represents the
-- outsourced cut-make-trim (CMT) sent to a contractor. Its accounting behavior
-- is chosen PER BUILD:
--
--   'procurement' (DEFAULT, SAFE): the PO is a commitment/document only. It
--       posts NO GL by itself. WIP is still built the normal way (parts issued
--       + services capitalized manually); receiving the PO completes the build
--       (existing M5 path, unchanged).
--
--   'capitalize': the conversion PO carries the CMT charge and its AP bill
--       capitalizes that charge into WIP (DR 1305 WIP / CR AP), so the operator
--       does not manually capitalize each service. (Its GL wiring is reviewed
--       separately — see the PR that adds this column.)
--
-- Idempotent: safe to re-run.

ALTER TABLE mfg_build_orders
  ADD COLUMN IF NOT EXISTS conversion_po_mode text NOT NULL DEFAULT 'procurement';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mfg_build_orders_conversion_po_mode_chk'
  ) THEN
    ALTER TABLE mfg_build_orders
      ADD CONSTRAINT mfg_build_orders_conversion_po_mode_chk
      CHECK (conversion_po_mode IN ('procurement','capitalize'));
  END IF;
END $$;

COMMENT ON COLUMN mfg_build_orders.conversion_po_mode IS
  'GL mode for the conversion PO: procurement (document only, no GL) or capitalize (AP bill capitalizes CMT into WIP).';
