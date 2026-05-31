-- 20260710020000_p15_c1c_brand_id_columns.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P15 Brand Master — wire the `brand_id` axis onto the transactional + master
-- tables (the universal brand dimension). Additive + backfill-safe:
--   • adds a NULLABLE brand_id FK to each table (instant metadata change),
--   • sets DEFAULT rof_default_brand_id() so NEW inserts auto-tag the ROF brand,
--   • backfills existing NULL rows to the ROF default brand.
-- No NOT-NULL constraint yet (that's the C4 "required tagging" flip, and only on
-- the §2 account categories). So zero behavior change — brand is purely
-- informational until enforcement chunks turn it on.
--
-- Backfill target = the ROF default brand for ALL legacy rows (CEO: no historical
-- per-brand mapping exists; proper attribution would need a Shopify API pull —
-- future). `channel_id` (sales axis) and inventory `partition_id` are separate
-- follow-on chunks. `ip_item_avg_cost` is DELIBERATELY EXCLUDED here — it already
-- carries real per-brand data in its `brand_name` column, so a naive ROF backfill
-- would be wrong; it gets the brand_name→brand_id mapping + partition_id in its
-- own chunk (operator approves the DISTINCT brand_name map first).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / SET DEFAULT / UPDATE …WHERE NULL /
-- CREATE INDEX IF NOT EXISTS — safe to re-apply.
-- ════════════════════════════════════════════════════════════════════════════

-- ROF default brand id (STABLE) — mirrors rof_entity_id(). Resolves the
-- is_default brand under the ROF entity (seeded in 20260710000000).
CREATE OR REPLACE FUNCTION rof_default_brand_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT id FROM brand_master
  WHERE entity_id = rof_entity_id() AND is_default = true
  LIMIT 1;
$$;

-- Apply the same treatment to every target table. (DO loop keeps the 20 tables
-- in one reviewable list and guarantees identical, idempotent handling.)
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    -- master data
    'style_master', 'ip_item_master',
    -- procurement
    'tanda_pos', 'po_line_items',
    -- GL
    'journal_entries', 'journal_entry_lines',
    -- AR
    'ar_invoices', 'ar_invoice_lines', 'ar_receipts',
    -- AP
    'invoices', 'payments',
    -- marketplace orders
    'shopify_orders', 'shopify_order_lines', 'fba_orders', 'walmart_orders', 'faire_orders',
    -- sales history
    'ip_sales_history_wholesale', 'ip_sales_history_ecom',
    -- inventory adjustments
    'inventory_adjustments',
    -- GS1 label batches
    'label_batches'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    -- Only act if the table actually exists (defensive — names verified, but a
    -- missing table must not abort the whole atomic migration).
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'P15 brand_id: table % not found, skipping', t;
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master(id) ON DELETE RESTRICT', t);
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN brand_id SET DEFAULT rof_default_brand_id()', t);
    EXECUTE format(
      'UPDATE public.%I SET brand_id = rof_default_brand_id() WHERE brand_id IS NULL', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (brand_id)', 'idx_' || t || '_brand', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
