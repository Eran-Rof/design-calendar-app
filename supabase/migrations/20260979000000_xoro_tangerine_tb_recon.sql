-- ════════════════════════════════════════════════════════════════════════════
-- Monthly Xoro-vs-Tangerine trial-balance reconciliation (#xoro-gl-truth)
--
-- CEO headline deliverable: prove Tangerine equals Xoro account-by-account,
-- month-by-month, to the cent. Sources:
--   Xoro side  = xoro_gl_transactions (the GL mirror). amount_home is SIGNED
--                (+ = debit, - = credit; every txn nets to 0), so SUM(amount_home)
--                per (month, account) IS the net debit.
--   Tang side  = journal_entry_lines (posted, ROF entity) rolled to the account's
--                gl_accounts.code; net debit = SUM(debit) - SUM(credit).
--
-- Xoro account NAMES are colon-paths ("5006 General and Administrative:Rent
-- Expense"); Tangerine uses COA codes. The bridge is `xoro_account_map`
-- (xoro_accounting_name -> gl_account_id/code), populated by
-- scripts/build-xoro-account-map.mjs which runs the SAME deterministic resolver
-- as the AP feed (api/_lib/accounting/xoroAccountMap.js). Unresolved names carry
-- gl_code = NULL and are surfaced by v_xoro_tb_unmapped (never silently dropped).
--
-- KNOWN, EXPECTED variances (NOT errors — the recon quantifies them):
--   * Balance-sheet accounts (code 1xxx/2xxx/3xxx) differ by the 2024-08-31
--     OPENING balance Tangerine has never booked — the cumulative variance on a
--     BS account through any month IS the opening JE that account needs. P&L
--     accounts (4/5/6/7xxx) should match closely month-by-month.
--   * The 2025 discounted-line defect (~$113,921 on AR 1107/1108).
--   * In-flight AP reclasses / corrections already posted to Tangerine.
--
-- RLS: financial data — service-role only, no anon policies.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS xoro_account_map (
  xoro_accounting_name  text PRIMARY KEY,   -- e.g. '5006 General and Administrative:Rent Expense'
  gl_account_id         uuid REFERENCES gl_accounts(id),
  gl_code               text,               -- resolved ROF COA code (NULL = unmapped)
  gl_name               text,
  via                   text,               -- map | code+name | name | leaf | unmapped
  xoro_type_name        text,               -- last-seen F_AccountingTypeName (context)
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE xoro_account_map IS 'Bridge: Xoro GL account path (colon leaf+code) -> ROF gl_accounts. Populated by scripts/build-xoro-account-map.mjs via the deterministic xoroAccountMap.js resolver. gl_code NULL = unmapped (surfaced, never guessed).';

ALTER TABLE xoro_account_map ENABLE ROW LEVEL SECURITY;

-- Monthly TB comparison per (month, ROF COA code). FULL OUTER JOIN so accounts
-- present on only one side still surface (with the other side = 0).
CREATE OR REPLACE VIEW v_xoro_tangerine_tb_recon AS
WITH xoro AS (
  SELECT date_trunc('month', g.txn_date)::date AS month,
         m.gl_code,
         round(sum(g.amount_home)::numeric, 2) AS xoro_net_debit
  FROM xoro_gl_transactions g
  JOIN xoro_account_map m ON m.xoro_accounting_name = g.accounting_name
  WHERE g.txn_date IS NOT NULL AND m.gl_code IS NOT NULL
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
  (COALESCE(x.gl_code, t.gl_code) ~ '^[4567]') AS is_pl,   -- P&L should match; BS offset by missing opener
  CASE WHEN COALESCE(x.gl_code, t.gl_code) ~ '^[4567]' THEN 'P&L' ELSE 'BS' END AS statement
FROM xoro x
FULL OUTER JOIN tang t ON t.month = x.month AND t.gl_code = x.gl_code
LEFT JOIN gl_accounts ga ON ga.code = COALESCE(x.gl_code, t.gl_code) AND ga.entity_id = rof_entity_id();

COMMENT ON VIEW v_xoro_tangerine_tb_recon IS 'Monthly Xoro (mirror) vs Tangerine (posted JE) net-debit per ROF COA code. variance = xoro - tangerine; P&L should match near-0 month-by-month, BS offset by the un-booked 2024-08-31 opening. #xoro-gl-truth.';

-- Xoro account names with NO Tangerine mapping, by month (the mapping worklist).
CREATE OR REPLACE VIEW v_xoro_tb_unmapped AS
SELECT date_trunc('month', g.txn_date)::date AS month,
       g.accounting_name,
       g.accounting_type_name,
       count(*) AS legs,
       round(sum(g.amount_home)::numeric, 2) AS net_debit
FROM xoro_gl_transactions g
LEFT JOIN xoro_account_map m ON m.xoro_accounting_name = g.accounting_name
WHERE g.txn_date IS NOT NULL AND (m.gl_code IS NULL)
GROUP BY 1, 2, 3;

COMMENT ON VIEW v_xoro_tb_unmapped IS 'Xoro GL account names with no ROF COA mapping (xoro_account_map.gl_code NULL), by month — the CEO/controller mapping worklist. #xoro-gl-truth.';

NOTIFY pgrst, 'reload schema';
