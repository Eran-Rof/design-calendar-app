-- 20260710030000_p15_c1d_channel_id_columns.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P15 Brand Master — wire the `channel_id` axis (sales route) onto the
-- sales/order tables. Unlike brand (one universal ROF default), the channel is
-- KNOWN per table — a Shopify order is always DTC, an FBA order is always FBA —
-- so each table is defaulted + backfilled to its own channel.
--
-- Additive + backfill-safe (nullable FK, per-table DEFAULT, backfill NULLs,
-- index). No NOT NULL (that's the C4 required-tagging flip). Zero behavior change.
--
-- Scope = SALES/ORDER tables only. Channel is a *sales* axis, so it is
-- deliberately NOT added to purchasing (tanda_pos / po_line_items — those carry
-- brand_id from the prior chunk; a PO has no sales channel). AP is vendor-facing
-- → no channel. Inventory partitions handle stock destination separately.
--
-- Backfill mapping (table → channel code):
--   shopify_orders / shopify_order_lines      → DTC
--   fba_orders                                → FBA
--   walmart_orders                            → WALMART
--   faire_orders                              → FAIRE
--   ip_sales_history_ecom                     → DTC      (ecom = Shopify/DTC)
--   ip_sales_history_wholesale                → WHOLESALE
--   ar_invoices / ar_invoice_lines / ar_receipts → WHOLESALE  (B2B invoicing default)
--
-- Idempotent. channel_id_by_code() resolves a channel uuid by its code.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION channel_id_by_code(p_code text) RETURNS uuid
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT id FROM channel_master WHERE code = p_code LIMIT 1;
$$;

DO $$
DECLARE
  m text[][] := ARRAY[
    ['shopify_orders',             'DTC'],
    ['shopify_order_lines',        'DTC'],
    ['fba_orders',                 'FBA'],
    ['walmart_orders',             'WALMART'],
    ['faire_orders',               'FAIRE'],
    ['ip_sales_history_ecom',      'DTC'],
    ['ip_sales_history_wholesale', 'WHOLESALE'],
    ['ar_invoices',                'WHOLESALE'],
    ['ar_invoice_lines',           'WHOLESALE'],
    ['ar_receipts',                'WHOLESALE']
  ];
  i int;
  t text;
  code text;
BEGIN
  FOR i IN 1 .. array_length(m, 1) LOOP
    t    := m[i][1];
    code := m[i][2];
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'P15 channel_id: table % not found, skipping', t;
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES channel_master(id) ON DELETE RESTRICT', t);
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN channel_id SET DEFAULT channel_id_by_code(%L)', t, code);
    EXECUTE format(
      'UPDATE public.%I SET channel_id = channel_id_by_code(%L) WHERE channel_id IS NULL', t, code);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (channel_id)', 'idx_' || t || '_channel', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
