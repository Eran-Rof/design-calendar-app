-- 20260898000000_drop_consumer_invoice_id_fk.sql
--
-- REPO CAPTURE of a prod hotfix already applied live (the original migration
-- file, briefly numbered 20260895000000, was lost when a concurrent shared
-- checkout switched branches before it was committed; 20260895000000 was then
-- taken by color_master_nrf_code on main). Re-issued here under a fresh number.
-- Idempotent (DROP ... IF EXISTS), so re-running against prod is a no-op.
--
-- FIX: AR invoice posting failed with
--   insert or update on table "inventory_consumption" violates foreign key
--   constraint "inventory_consumption_consumer_invoice_id_fkey"
--
-- Root cause: inventory_consumption.consumer_invoice_id was created in P3-3
-- (20260527070000_p3_chunk3_fifo_schema.sql) referencing the legacy P3-era
-- `invoices(id)` table. Since P4 the FIFO consume RPC writes a *per-line*
-- consumer reference into this column, and that reference is polymorphic:
--
--   consumer_kind='ar_invoice'  via AR posting   -> ar_invoice_lines.id
--   consumer_kind='ar_invoice'  via Shopify COGS -> shopify_order_lines.id
--
-- Neither id lives in `invoices`, so the FK fails on every sale that actually
-- draws a FIFO layer. Because the reference is polymorphic (two possible
-- parent tables) no single FK can model it — mirroring the sibling column
-- `consumer_adjustment_id`, which has been intentionally FK-less since P3-3.

ALTER TABLE inventory_consumption
  DROP CONSTRAINT IF EXISTS inventory_consumption_consumer_invoice_id_fkey;

COMMENT ON COLUMN inventory_consumption.consumer_invoice_id IS
  'Polymorphic, FK-less per-line consumer reference for consumer_kind=ar_invoice: '
  'ar_invoice_lines.id (AR posting) or shopify_order_lines.id (Shopify COGS). '
  'FK to legacy invoices(id) dropped — see migration 20260898000000.';
