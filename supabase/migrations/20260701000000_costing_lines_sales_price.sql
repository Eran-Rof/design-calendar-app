-- Costing Module — add weighted sales-price columns to costing_lines
--
-- Operator ask: surface "LY Sls Prc" (last-year weighted average sales
-- price) + "T3 Sls Prc" (trailing-3-month equivalent) alongside the
-- existing cost columns. The comp endpoints already compute these (sum
-- of net_amount / sum of qty over ip_sales_history_wholesale), they
-- just weren't being persisted.
--
-- Margin auto-calc in the grid uses (sls_prc - cost) / sls_prc — both
-- columns must be persisted server-side so a row reload doesn't lose
-- the snapshot.

ALTER TABLE costing_lines
  ADD COLUMN IF NOT EXISTS ly_unit_price numeric(12,4),
  ADD COLUMN IF NOT EXISTS t3_unit_price numeric(12,4);

COMMENT ON COLUMN costing_lines.ly_unit_price IS 'LY weighted-average sales price (sum(net_amount) / sum(qty)) over the comp period. Stamped by /api/internal/costing/comp/ly. Pairs with ly_unit_cost for the auto-calc Margin column.';
COMMENT ON COLUMN costing_lines.t3_unit_price IS 'T3 (trailing 3 months) weighted-average sales price. Stamped by /api/internal/costing/comp/t3. Pairs with t3_unit_cost for the auto-calc Margin column.';

NOTIFY pgrst, 'reload schema';
