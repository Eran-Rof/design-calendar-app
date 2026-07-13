-- ════════════════════════════════════════════════════════════════════════════
-- Xoro-vs-Tangerine TB recon — OPERATING scope (exclude closing/opening JEs)
-- (#xoro-gl-truth, 2026-07-12)
--
-- The first cut of v_xoro_tangerine_tb_recon (mig 20260979) compared ALL Xoro
-- GL activity to Tangerine. That surfaced enormous, misleading variances because
-- the Xoro mirror contains entries Tangerine has NEVER had and never should for
-- an OPERATING P&L comparison:
--   * YEAR-END CLOSING entries — every Dec, Xoro debits all revenue / credits
--     all COGS to Retained Earnings (e.g. 4005 shows +$26.6M of Journal-Entry
--     DEBITS closing the year, on top of −$38.6M of real Invoice revenue).
--   * 8/31/2024 OPENING balances — Xoro's opening JEs set up Inventory / AR / AP
--     / Bank / Factor against Opening Balance Equity + owner Capital.
--   * Owner DISTRIBUTION / draw entries.
-- All three touch an EQUITY account (Retained Earnings / Opening Balance Equity /
-- Capital / Distribution) and none flow through an AR/AP subledger, so Tangerine
-- has none of them. Excluding any transaction that touches equity isolates the
-- OPERATING activity — proven: operating 4005 = −$38,638,190 = exactly the
-- Invoice revenue total.
--
-- This migration REDEFINES v_xoro_tangerine_tb_recon to the operating scope and
-- adds v_xoro_opening_balances (the excluded equity-touching entries, by month /
-- account — the raw material for booking Tangerine's missing 8/31/2024 opening
-- balances + reconciling year-end closes).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_xoro_tangerine_tb_recon AS
WITH equity_txns AS (
  -- transactions that touch an equity account = closing / opening / distribution
  SELECT DISTINCT txn_id FROM xoro_gl_transactions
  WHERE accounting_type_name = 'Equity'
     OR accounting_name ILIKE '%retained earnings%'
     OR accounting_name ILIKE '%opening balance equity%'
     OR accounting_name ILIKE '%capital acco%'
     OR accounting_name ILIKE '%distribution%'
),
xoro AS (
  SELECT date_trunc('month', g.txn_date)::date AS month,
         m.gl_code,
         round(sum(g.amount_home)::numeric, 2) AS xoro_net_debit
  FROM xoro_gl_transactions g
  JOIN xoro_account_map m ON m.xoro_accounting_name = g.accounting_name
  WHERE g.txn_date IS NOT NULL AND m.gl_code IS NOT NULL
    AND g.txn_id NOT IN (SELECT txn_id FROM equity_txns)
  GROUP BY 1, 2
),
tang AS (
  SELECT date_trunc('month', j.posting_date)::date AS month,
         a.code AS gl_code,
         round((sum(l.debit) - sum(l.credit))::numeric, 2) AS tang_net_debit
  FROM journal_entry_lines l
  JOIN journal_entries j ON j.id = l.journal_entry_id
   AND j.status = 'posted' AND j.entity_id = rof_entity_id()
  JOIN gl_accounts a ON a.id = l.account_id
  WHERE j.posting_date IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  COALESCE(x.month, t.month)               AS month,
  COALESCE(x.gl_code, t.gl_code)           AS gl_code,
  ga.name                                  AS gl_name,
  COALESCE(x.xoro_net_debit, 0)            AS xoro_net_debit,
  COALESCE(t.tang_net_debit, 0)            AS tang_net_debit,
  round(COALESCE(x.xoro_net_debit, 0) - COALESCE(t.tang_net_debit, 0), 2) AS variance,
  abs(round(COALESCE(x.xoro_net_debit, 0) - COALESCE(t.tang_net_debit, 0), 2)) AS abs_variance,
  (COALESCE(x.gl_code, t.gl_code) ~ '^[4567]') AS is_pl,
  CASE WHEN COALESCE(x.gl_code, t.gl_code) ~ '^[4567]' THEN 'P&L' ELSE 'BS' END AS statement
FROM xoro x
FULL OUTER JOIN tang t ON t.month = x.month AND t.gl_code = x.gl_code
LEFT JOIN gl_accounts ga ON ga.code = COALESCE(x.gl_code, t.gl_code) AND ga.entity_id = rof_entity_id();

COMMENT ON VIEW v_xoro_tangerine_tb_recon IS 'OPERATING monthly Xoro-vs-Tangerine net-debit per ROF COA code (excludes equity-touching closing/opening/distribution txns). variance = xoro - tangerine. #xoro-gl-truth.';

-- The excluded equity-touching entries, by month/account — Xoro's opening
-- balances (2024-08) + year-end closes + distributions. Source material for
-- booking Tangerine's missing 8/31/2024 opening balances.
CREATE OR REPLACE VIEW v_xoro_opening_balances AS
WITH equity_txns AS (
  SELECT DISTINCT txn_id FROM xoro_gl_transactions
  WHERE accounting_type_name = 'Equity'
     OR accounting_name ILIKE '%retained earnings%'
     OR accounting_name ILIKE '%opening balance equity%'
     OR accounting_name ILIKE '%capital acco%'
     OR accounting_name ILIKE '%distribution%'
)
SELECT date_trunc('month', g.txn_date)::date AS month,
       COALESCE(m.gl_code, '(unmapped)')     AS gl_code,
       g.accounting_name,
       g.accounting_type_name,
       count(*)                              AS legs,
       round(sum(g.amount_home)::numeric, 2) AS net_debit
FROM xoro_gl_transactions g
JOIN equity_txns e ON e.txn_id = g.txn_id
LEFT JOIN xoro_account_map m ON m.xoro_accounting_name = g.accounting_name
WHERE g.txn_date IS NOT NULL
GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW v_xoro_opening_balances IS 'Xoro equity-touching entries (opening balances 2024-08 + year-end closes + distributions), by month/account — excluded from the operating recon; the raw material for Tangerine opening-balance backfill. #xoro-gl-truth.';

NOTIFY pgrst, 'reload schema';
