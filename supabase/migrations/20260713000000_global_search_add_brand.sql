-- ════════════════════════════════════════════════════════════════════════════
-- Chunk L — Add `brand` to global search
--
-- Extends the T6-2 global-search view (20260624000000) with two changes:
--
--   1. A new `brand` UNION branch over brand_master so typing a brand code or
--      name returns the brand itself as a navigable/informational result.
--      brand_master has no `search_doc` tsvector column (it predates T6-1), so
--      we build the document inline with to_tsvector('simple', code || name).
--      brand_master already grants anon SELECT (anon_read_brand_master policy),
--      so the SECURITY INVOKER RPC returns brand rows without extra grants.
--
--   2. The `style` branch's searchable document is widened to include the
--      style's brand name + code (via LEFT JOIN brand_master) so searching a
--      brand also surfaces that brand's styles. style_master.brand_id is the
--      FK (p15 c1c). Styles with a NULL brand_id keep their original doc.
--
-- route_hint for brand points at the Product Catalog module (where brand is a
-- filterable column) — there is no standalone brand-admin panel, so this is the
-- most sensible existing destination. routeFor() in GlobalSearchPalette.tsx
-- prefers a non-null route_hint, so this lands the operator correctly without a
-- new front-end route.
--
-- CREATE OR REPLACE VIEW keeps the exact column list / order / types of the
-- existing view (entity_type, entity_id, title, subtitle, search_doc,
-- route_hint), which is required for a replace.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_global_search AS
SELECT
  'customer'::text                                       AS entity_type,
  id::text                                               AS entity_id,
  name                                                   AS title,
  code                                                   AS subtitle,
  search_doc                                             AS search_doc,
  '/customers/' || id::text                              AS route_hint
FROM customers
UNION ALL
SELECT
  'vendor'::text,
  id::text,
  name,
  code,
  search_doc,
  '/vendors/' || id::text
FROM vendors
UNION ALL
SELECT
  'ar_invoice'::text,
  id::text,
  'AR ' || invoice_number,
  '$' || to_char(total_amount_cents / 100.0, 'FM999,999,990.00'),
  search_doc,
  '/ar-invoices/' || id::text
FROM ar_invoices
UNION ALL
SELECT
  'ap_invoice'::text,
  id::text,
  'AP ' || invoice_number,
  '$' || to_char(total_amount_cents / 100.0, 'FM999,999,990.00'),
  search_doc,
  '/ap-invoices/' || id::text
FROM invoices
UNION ALL
SELECT
  'po'::text,
  id::text,
  'PO ' || po_number,
  vendor,
  search_doc,
  '/tanda/' || id::text
FROM tanda_pos
UNION ALL
-- Style branch: brand name/code folded into the searchable document so a brand
-- query surfaces its styles. Title/subtitle unchanged.
SELECT
  'style'::text,
  s.id::text,
  s.style_code,
  coalesce(s.style_name, s.description),
  s.search_doc
    || to_tsvector('simple', coalesce(b.name, '') || ' ' || coalesce(b.code, '')) AS search_doc,
  '/pim/styles/' || s.id::text
FROM style_master s
LEFT JOIN brand_master b ON b.id = s.brand_id
UNION ALL
SELECT
  'sku'::text,
  id::text,
  sku_code,
  style_code,
  search_doc,
  '/items/' || id::text
FROM ip_item_master
UNION ALL
SELECT
  'gl_account'::text,
  id::text,
  code || ' ' || name,
  account_type,
  search_doc,
  '/gl-accounts/' || id::text
FROM gl_accounts
UNION ALL
SELECT
  'case'::text,
  id::text,
  case_number,
  subject,
  search_doc,
  '/cases/' || id::text
FROM cases
UNION ALL
SELECT
  'sales_rep'::text,
  id::text,
  display_name,
  email,
  search_doc,
  '/sales-reps/' || id::text
FROM sales_reps
UNION ALL
SELECT
  'bank_txn'::text,
  id::text,
  coalesce(merchant_name, external_txn_id, 'Bank txn'),
  '$' || to_char(amount_cents / 100.0, 'FM999,999,990.00')
    || ' on ' || to_char(created_at, 'YYYY-MM-DD'),
  search_doc,
  '/bank-transactions/' || id::text
FROM bank_transactions
UNION ALL
-- Brand branch: brand_master has no precomputed search_doc, so build it inline.
SELECT
  'brand'::text,
  id::text,
  name,
  'Brand ' || code,
  to_tsvector('simple', coalesce(code, '') || ' ' || coalesce(name, '')) AS search_doc,
  '/tangerine?module=pim_catalog'                        AS route_hint
FROM brand_master;

COMMENT ON VIEW v_global_search IS
  'T6-2 + Chunk L — UNION ALL projection of every searchable entity. Adds brand_master (inline tsvector) and folds brand name/code into the style search_doc. Use the global_search() RPC to query.';

-- global_search() RPC body is unchanged (it just queries the view) — no need to
-- recreate it. Reload PostgREST so the refreshed view is picked up.
NOTIFY pgrst, 'reload schema';
