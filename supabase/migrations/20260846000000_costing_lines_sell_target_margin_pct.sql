-- Costing — "Sell Tgt Frm Mrgn" column.
--
-- A per-line target gross-margin % the operator types to AUTO-DERIVE the Sell
-- Tgt (sell = cost basis / (1 - margin/100)). Stored so the grid can show the
-- margin that produced the current Sell Tgt. Cleared (set NULL) the moment the
-- operator overrides Sell Tgt by hand — at which point the column renders blank.
--
-- Distinct from the existing editable "Margin %" column, which back-solves the
-- COST from a margin (holding Sell Tgt fixed). This one back-solves the SELL.

ALTER TABLE costing_lines
  ADD COLUMN IF NOT EXISTS sell_target_margin_pct numeric(8,4);

COMMENT ON COLUMN costing_lines.sell_target_margin_pct IS 'Target gross-margin % the operator entered to derive sell_target (sell = cost/(1-m/100)). NULL when sell_target was set/overridden directly — the "Sell Tgt Frm Mrgn" cell then shows blank.';

NOTIFY pgrst, 'reload schema';
