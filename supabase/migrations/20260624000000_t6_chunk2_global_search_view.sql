-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine T6-2 — Global Search view + RPC
--
-- Exposes a single search endpoint over all 11 entities that T6-1 instrumented
-- with `search_doc tsvector` columns. The UI calls one RPC (`global_search`)
-- and renders heterogeneous results with title + subtitle.
--
-- Components:
--   1. View `v_global_search` — UNION ALL across 11 entities, projecting a
--      uniform (entity_type, entity_id, title, subtitle, search_doc,
--      route_hint) tuple per row.
--   2. Function `global_search(q text, max_results int)` — SECURITY INVOKER
--      so the per-table RLS that the caller is subject to applies
--      transparently: results are intersected with the rows the user can
--      already SELECT from each underlying table.
--
-- Column-name substitutions vs the original arch §3 brief (verified against
-- CURRENT-SCHEMA.md + the T6-1 trigger code):
--   - T6-1 named the tsvector `search_doc` (NOT `tsv` as the brief draft
--     said). All downstream code uses `search_doc`.
--   - gl_accounts uses `code`/`name` (not `account_number`/`account_name`).
--   - sales_reps uses `display_name`/`email` (not `rep_name`/`rep_code`).
--   - ar_invoices/invoices store money in `total_amount_cents` (bigint cents,
--     not dollar numeric `total_amount`). We format as dollars in the
--     subtitle for display.
--   - bank_transactions has no `description`/`posted_at` columns — use
--     `merchant_name` / `external_txn_id` for title and `amount_cents` /
--     `created_at` for subtitle.
--   - style_master.title prefers `style_code`; subtitle prefers `style_name`
--     and falls back to `description` (style_name is nullable).
--
-- Architecture: docs/tangerine/T6-global-search-architecture.md §4.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────── v_global_search ───────────────────────────
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
SELECT
  'style'::text,
  id::text,
  style_code,
  coalesce(style_name, description),
  search_doc,
  '/pim/styles/' || id::text
FROM style_master
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
FROM bank_transactions;

COMMENT ON VIEW v_global_search IS
  'T6-2 — UNION ALL projection of every entity carrying a search_doc tsvector. Use the global_search() RPC to query; querying this view directly is fine too but the RPC handles ranking + LIMIT.';

-- ─────────────────────────────── global_search RPC ─────────────────────────
-- SECURITY INVOKER: the caller's existing per-table RLS applies, so the user
-- only sees results from rows they can already SELECT from each entity.
CREATE OR REPLACE FUNCTION global_search(q text, max_results int DEFAULT 30)
RETURNS TABLE (
  entity_type text,
  entity_id   text,
  title       text,
  subtitle    text,
  rank        real,
  route_hint  text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    entity_type,
    entity_id,
    title,
    subtitle,
    ts_rank(search_doc, plainto_tsquery('simple', q)) AS rank,
    route_hint
  FROM v_global_search
  WHERE search_doc @@ plainto_tsquery('simple', q)
  ORDER BY rank DESC, title ASC
  LIMIT LEAST(GREATEST(coalesce(max_results, 30), 1), 100);
$$;

COMMENT ON FUNCTION global_search(text, int) IS
  'T6-2 — global full-text search across the 11 v1 entities. SECURITY INVOKER so per-entity RLS still applies. Caps max_results at 100 (default 30).';

-- ─────────────────────────────── grants ────────────────────────────────────
GRANT SELECT ON v_global_search TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION global_search(text, int) TO anon, authenticated, service_role;

-- ─────────────────────────────── PostgREST schema reload ───────────────────
NOTIFY pgrst, 'reload schema';
