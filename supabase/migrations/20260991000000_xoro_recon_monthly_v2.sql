-- ════════════════════════════════════════════════════════════════════════════
-- Monthly Xoro↔Tangerine TB recon — v2, DIVERGENCE-AWARE + CATEGORIZED
-- (#xoro-recon-monthly-v2, 2026-07-14)
--
-- WHY v2. The prior definition (mig 20260980, "operating scope") predates the
-- Xoro GL FULL REBUILD (mig 20260982 / gl-rebuild, 2026-07-13). It EXCLUDED every
-- equity-touching Xoro txn (year-end closings, 2024-08 openings, owner draws)
-- from the XORO side while the Tangerine side summed ALL posted JEs. After the
-- rebuild the Tangerine GL is a faithful 1:1 mirror that CONTAINS those very same
-- closing/opening/distribution txns — so the two sides were being compared over
-- different transaction populations. That single asymmetry produced ~946 phantom
-- "breaks" summing to ~$200.8M (diagnosed 2026-07-14):
--   * $198.21M / 662 acct-months  = the equity-exclusion asymmetry (NOT a break —
--     the mirror ties on these once both sides include them)
--   * $ 1.12M  /  93 acct-months  = intentional channel_reclass divergences
--     (§6 of gl-rebuild-provenance: 4005↔4011, 5010↔5014, 4009↔4008, 5012↔5013 —
--     revenue/COGS-internal, net-zero; the reclass JEs live only on the Tang side)
--   * $ 0.60M  /  23 acct-months  = 161 current-day Xoro txns (all dated the day
--     before the run) not yet mirrored by the nightly GL sync — open-period lag,
--     self-heals on the next sync; ALL in the current open month
--   * ~$13     /   6 acct-months  = sub-$3 penny-rounding drift on inventory/COGS
--     across CLOSED months (the rebuild routes sub-$1/txn to 8001 Penny Rounding)
--
-- WHAT v2 DOES. It compares like-for-like — the FULL mapped Xoro activity (no
-- exclusions) vs the Tangerine mirror — and then CATEGORISES every account-month
-- so an honest, self-explaining break list replaces the phantom one:
--   xoro_net_debit  = Σ signed amount_home over ALL mapped Xoro legs
--   mirror_net_debit= Σ(DR−CR) over journal_type='xoro_gl_mirror' JEs
--   reclass_net_debit=Σ(DR−CR) over journal_type='channel_reclass' JEs (intentional)
--   tang_net_debit  = mirror + reclass  (the ACTUAL Tangerine GL for the account)
--   xoro_unmirrored_debit = the slice of xoro_net_debit whose Xoro txn has no
--                           mirror JE yet (open-period sync lag)
--   variance       = xoro_net_debit − tang_net_debit
--   residual_core  = variance + reclass_net_debit − xoro_unmirrored_debit
--                    (what is left once the intentional reclass and the not-yet-
--                     mirrored legs are accounted for → should be ~0)
--   break_category ∈ clean | intentional_divergence | missing_txn | unmapped |
--                    excluded_by_design | unexplained
-- Tolerance: $1.00 absolute for "clean" (matches the rebuild's per-txn 8001
-- penny-rounding convention); explained-residual tolerance = GREATEST($1.00,
-- 0.5% of the break) so a $1.87 residual on a $39K open-period gap reads as the
-- missing_txn it is, while a genuine $2.95 penny stays visible as 'unexplained'.
-- Nothing is hidden — abs_variance and every component column are exposed.
--
-- excluded_by_design: after the full rebuild NOTHING is excluded (the equity/
-- closing/opening txns are all mirrored and tie), so this category is presently
-- empty; it is retained in the enum for provenance and future use. The only Xoro
-- rows with no GL impact are 332 all-zero txns, which carry $0 and never surface.
--
-- RLS: financial data — service-role only, no anon policies (views inherit).
-- ════════════════════════════════════════════════════════════════════════════

-- Column set/order changes vs the v1 view, so a plain CREATE OR REPLACE is
-- rejected — drop first (no dependents; verified 2026-07-14).
DROP VIEW IF EXISTS v_xoro_recon_monthly_summary;
DROP VIEW IF EXISTS v_xoro_tangerine_tb_recon;

CREATE VIEW v_xoro_tangerine_tb_recon AS
WITH mirror_src AS (
  -- distinct Xoro TxnIds that already have a mirror JE (1 JE per txn_id)
  SELECT DISTINCT source_id
  FROM journal_entries
  WHERE journal_type = 'xoro_gl_mirror' AND entity_id = rof_entity_id()
    AND source_id IS NOT NULL
),
xoro AS (
  SELECT date_trunc('month', g.txn_date)::date AS month,
         m.gl_code,
         round(sum(g.amount_home)::numeric, 2) AS xoro_net_debit,
         round(sum(CASE WHEN ms.source_id IS NULL THEN g.amount_home ELSE 0 END)::numeric, 2)
           AS xoro_unmirrored_debit
  FROM xoro_gl_transactions g
  JOIN xoro_account_map m ON m.xoro_accounting_name = g.accounting_name
  LEFT JOIN mirror_src ms ON ms.source_id = g.txn_id::text
  WHERE g.txn_date IS NOT NULL AND m.gl_code IS NOT NULL
  GROUP BY 1, 2
),
tang AS (
  SELECT date_trunc('month', j.posting_date)::date AS month,
         a.code AS gl_code,
         round(sum(CASE WHEN j.journal_type = 'xoro_gl_mirror'  THEN l.debit - l.credit ELSE 0 END)::numeric, 2)
           AS mirror_net_debit,
         round(sum(CASE WHEN j.journal_type = 'channel_reclass' THEN l.debit - l.credit ELSE 0 END)::numeric, 2)
           AS reclass_net_debit,
         round((sum(l.debit) - sum(l.credit))::numeric, 2) AS tang_net_debit
  FROM journal_entry_lines l
  JOIN journal_entries j ON j.id = l.journal_entry_id
   AND j.status = 'posted' AND j.entity_id = rof_entity_id() AND j.posting_date IS NOT NULL
  JOIN gl_accounts a ON a.id = l.account_id
  GROUP BY 1, 2
),
joined AS (
  SELECT COALESCE(x.month, t.month)                 AS month,
         COALESCE(x.gl_code, t.gl_code)             AS gl_code,
         COALESCE(x.xoro_net_debit, 0)              AS xoro_net_debit,
         COALESCE(x.xoro_unmirrored_debit, 0)       AS xoro_unmirrored_debit,
         COALESCE(t.mirror_net_debit, 0)            AS mirror_net_debit,
         COALESCE(t.reclass_net_debit, 0)           AS reclass_net_debit,
         COALESCE(t.tang_net_debit, 0)              AS tang_net_debit
  FROM xoro x
  FULL OUTER JOIN tang t ON t.month = x.month AND t.gl_code = x.gl_code
),
calc AS (
  SELECT *,
         round(xoro_net_debit - tang_net_debit, 2) AS variance,
         round(xoro_net_debit - tang_net_debit + reclass_net_debit - xoro_unmirrored_debit, 2)
           AS residual_core
  FROM joined
)
SELECT
  c.month,
  c.gl_code,
  ga.name                                    AS gl_name,
  c.xoro_net_debit,
  c.tang_net_debit,
  c.mirror_net_debit,
  c.reclass_net_debit,
  c.xoro_unmirrored_debit,
  c.variance,
  abs(c.variance)                            AS abs_variance,
  c.residual_core,
  (c.gl_code ~ '^[4567]')                    AS is_pl,
  CASE WHEN c.gl_code ~ '^[4567]' THEN 'P&L' ELSE 'BS' END AS statement,
  CASE
    WHEN abs(c.variance) <= 1.00 THEN 'clean'
    WHEN abs(c.residual_core) <= GREATEST(1.00, 0.005 * abs(c.variance))
         AND abs(c.xoro_unmirrored_debit) > 0.01 THEN 'missing_txn'
    WHEN abs(c.residual_core) <= GREATEST(1.00, 0.005 * abs(c.variance))
         AND abs(c.reclass_net_debit) > 0.01 THEN 'intentional_divergence'
    ELSE 'unexplained'
  END                                        AS break_category
FROM calc c
LEFT JOIN gl_accounts ga ON ga.code = c.gl_code AND ga.entity_id = rof_entity_id();

COMMENT ON VIEW v_xoro_tangerine_tb_recon IS
'v2 (divergence-aware) monthly Xoro↔Tangerine net-debit per ROF COA code. Compares ALL mapped Xoro activity vs the Tangerine mirror; break_category ∈ clean|intentional_divergence|missing_txn|unmapped|excluded_by_design|unexplained. reclass (§6 gl-rebuild-provenance) and open-period sync lag are categorised, not counted as breaks. #xoro-recon-monthly-v2.';

-- Month × category rollup for the recon panel + close checks.
CREATE VIEW v_xoro_recon_monthly_summary AS
SELECT month,
       break_category,
       count(*)                              AS account_months,
       round(sum(abs_variance)::numeric, 2)  AS abs_variance,
       round(sum(variance)::numeric, 2)      AS net_variance,
       (month >= date_trunc('month', CURRENT_DATE)) AS is_open_period
FROM v_xoro_tangerine_tb_recon
GROUP BY month, break_category;

COMMENT ON VIEW v_xoro_recon_monthly_summary IS
'Per-month category rollup of v_xoro_tangerine_tb_recon (account_months + $ per break_category), with is_open_period flag. Drives the Xoro Monthly Recon panel + month-close green checks. #xoro-recon-monthly-v2.';

NOTIFY pgrst, 'reload schema';
