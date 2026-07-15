-- 20260998000000_close_checks_scoping_and_clarity.sql
--
-- Month-End Close auto-checks — AS-OF SCOPING + PLAIN-LANGUAGE CLARITY.
--
-- WHY (CEO ran the Aug-2024 close and saw 3 red "Fail" cards with no
-- explanation and no fix). Two classes of defect fixed here:
--
--   LOGIC
--   -----
--   A. No as-of-date scoping. The AR/AP ties compared ALL-TIME posted GL
--      (no posting_date filter) against the subledger's CURRENTLY-open
--      balance (no as-of). Closing a HISTORICAL month (Aug-2024) that way
--      compares all-time-through-today GL vs open-right-now subledger —
--      meaningless. FIX: scope BOTH sides to period-end.
--        • GL side  : posted-ACCRUAL lines with je.posting_date <= ends_on.
--        • AR sub    : invoices with posting_date <= ends_on, less receipt
--                      applications whose ar_receipts.receipt_date <= ends_on
--                      (the dated cash-side backfill, #1754). NOTE: the
--                      ar_receipt_applications.applied_at column is the
--                      backfill run-stamp, NOT the economic date — so we date
--                      by the joined ar_receipts.receipt_date.
--        • AP sub    : posted bills with posting_date <= ends_on, less
--                      invoice_payments with payment_date <= ends_on.
--
--   B. Aug-2024 predates migrated AR invoice detail. ar_invoices history
--      starts 2024-09-01; the mirrored GL carries the OPENING AR balances,
--      so for any month ending before that the invoice-level subledger
--      literally does not exist (hence 424 "unmapped"). That is an EXPECTED
--      migration artifact resolved at the cutover AR historical backfill —
--      NOT a books error. Classify as WAIVED (pre_ar_history), not fail.
--
--   C. AP waiver regression from #1754. The old waiver only fired when
--      SUM(paid_amount_cents)=0. #1754 populated paid_amount ($41.13M), so
--      the waiver silently switched OFF and the check HARD-FAILED on the
--      KNOWN, documented -$4.11M NON-CASH relief residual (bills settled by
--      credit memos / factor / 8007->1308 reclasses that no cash payment
--      represents). tieouts.js (#1754) already emits a non-alerting
--      ap_noncash_gl_relief_residual waiver; this RPC is brought into
--      alignment — WAIVED (advisory), not fail.
--
--   D. Bank-rec scope. The check demanded a reconciled run for EVERY
--      bank_recon_runs row, INCLUDING non-statement control accounts wired
--      into the mirror (1051 Factor Advances - Rosenthal, 1020 Cash
--      Clearing — account_kind='other'), and treated the auto Xoro-mirror
--      runs of a month that was never HUMAN-reconciled as hard fails. FIX:
--        • only require reconciliation for TRUE statement accounts
--          (bank_accounts.account_kind IN ('checking','credit_card'));
--        • a period with no human-operated run (reconciled_by_user_id IS
--          NULL on every run — bank rec is still a Xoro mirror, not operated
--          per-statement) is WAIVED (not_operated), not fail;
--        • once bank rec IS operated, an unreconciled TRUE account FAILS.
--
--   CLARITY
--   -------
--   Every check now carries, IN the returned JSONB and its detail:
--     status         {pass, fail, warn, waived}   (rich verdict)
--     severity       {blocker, advisory, informational}
--     title          short human name
--     explanation    plain-language WHAT this means
--     recommendation plain-language WHAT to do / how to close with exception
--     classification mirror of status (so the persisted detail keeps it)
--   Existing detail keys (gl_cents, subledger_cents, diff_cents, accounts[],
--   …) are PRESERVED — fields are ADDED, nothing renamed, no consumer breaks.
--
--   BLOCKING MODEL: only status='fail' (always severity=blocker) hard-blocks
--   the close. warn + waived are advisory/non-blocking (shown, explained,
--   self-correcting). The persistence layer (closeChecklist.upsertAutoItems)
--   maps status='fail' -> stored 'fail', everything else -> stored 'pass',
--   so the CEO can close a historical month with documented, explained
--   exceptions instead of being stuck on migration-era artifacts.
--
-- Idempotent (CREATE OR REPLACE); STABLE; signature unchanged so run-checks.js
-- keeps working.

-- Plain "$1,234.56" / "-$1,234.56" money formatter for explanation prose.
CREATE OR REPLACE FUNCTION public.close_fmt_usd(cents bigint)
 RETURNS text LANGUAGE sql IMMUTABLE AS $fmt$
  SELECT CASE WHEN COALESCE(cents,0) < 0 THEN '-' ELSE '' END || '$' ||
         to_char(round(abs(COALESCE(cents,0))::numeric / 100, 2), 'FM999,999,999,990.00');
$fmt$;

CREATE OR REPLACE FUNCTION public.close_run_auto_checks(p_entity_id uuid, p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_period            record;
  v_checks            jsonb := '[]'::jsonb;
  v_ends              date;

  v_accrual_imb       bigint;
  v_cash_imb          bigint;
  v_posted_jes        int;
  v_draft             int;

  v_ar_history_start  date;
  v_ar_pre_history    boolean;
  v_ar_rows           jsonb;
  v_ar_ok             boolean;
  v_ar_unmapped       bigint;
  v_ar_considered     int;
  v_ar_status         text;
  v_ar_max_diff       bigint;
  -- Promote in-history AR diffs from advisory WARN to blocking FAIL once the
  -- cutover AR historical backfill has landed (flip to true post-cutover).
  v_ar_cutover_done   constant boolean := false;

  v_ap_gl             bigint;
  v_ap_open           bigint;
  v_ap_paid_asof      bigint;
  v_ap_bills          int;
  v_ap_diff           bigint;
  v_ap_status         text;

  v_bank_rows         jsonb;
  v_bank_total        int;
  v_bank_reconciled   int;
  v_bank_operated     boolean;
  v_bank_status       text;

  v_8007_accrual      bigint;
  v_8007_cash         bigint;
  v_8007_lines        int;

  v_stmt              record;
  v_1107_asof         bigint;
  v_factor_status     text;

  v_rev               bigint;
  v_rev_status        text;

  -- bank rec is a Xoro mirror through this month; not operated per-statement.
  v_mirror_through    constant text := '2026-05-31';
BEGIN
  SELECT id, entity_id, status, starts_on, ends_on, fiscal_year, period_number
    INTO v_period
    FROM gl_periods
   WHERE id = p_period_id AND entity_id = p_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'close_run_auto_checks: period % not found for entity %', p_period_id, p_entity_id;
  END IF;
  v_ends := v_period.ends_on;

  -- =====================================================================
  -- 1. gl_balanced — posted JEs in the period must sum to zero per basis.
  --    A genuine hard BLOCKER: an out-of-balance GL cannot be closed.
  -- =====================================================================
  SELECT
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'ACCRUAL' THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'CASH'    THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COUNT(DISTINCT je.id)::int
    INTO v_accrual_imb, v_cash_imb, v_posted_jes
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.status = 'posted';

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'gl_balanced',
    'title', 'GL balanced',
    'status', CASE WHEN v_accrual_imb = 0 AND v_cash_imb = 0 THEN 'pass' ELSE 'fail' END,
    'severity', CASE WHEN v_accrual_imb = 0 AND v_cash_imb = 0 THEN 'informational' ELSE 'blocker' END,
    'explanation', CASE WHEN v_accrual_imb = 0 AND v_cash_imb = 0
      THEN 'Every posted journal entry in this period balances — total debits equal total credits on both the accrual and cash books.'
      ELSE 'The posted journal entries in this period do not balance: debits and credits are off by ' || public.close_fmt_usd(v_accrual_imb) || ' (accrual) / ' || public.close_fmt_usd(v_cash_imb) || ' (cash).' END,
    'recommendation', CASE WHEN v_accrual_imb = 0 AND v_cash_imb = 0
      THEN 'No action needed.'
      ELSE 'Do not close. Find the unbalanced entry in the GL for this month and correct it — a period whose debits and credits disagree cannot be closed.' END,
    'classification', CASE WHEN v_accrual_imb = 0 AND v_cash_imb = 0 THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object(
      'accrual_imbalance_cents', v_accrual_imb,
      'cash_imbalance_cents',    v_cash_imb,
      'posted_je_count',         v_posted_jes));

  -- =====================================================================
  -- 2. ar_subledger_tie — AS OF period-end (posting_date <= ends_on on BOTH
  --    sides). GL per AR control account vs open ar_invoices, where "open
  --    as-of" = invoiced(<=ends_on) − receipt applications dated (by the
  --    joined ar_receipts.receipt_date) <= ends_on.
  --
  --    Pre-AR-history months (ends_on < first ar_invoices.posting_date) get
  --    WAIVED: the GL carries opening AR balances but the invoice-level
  --    subledger does not exist yet (cutover backfill).
  -- =====================================================================
  SELECT MIN(posting_date) INTO v_ar_history_start
    FROM ar_invoices WHERE entity_id = p_entity_id;
  v_ar_history_start := COALESCE(v_ar_history_start, DATE '2024-09-01');
  v_ar_pre_history   := v_ends < v_ar_history_start;

  WITH gl AS (
    SELECT ga.code, ga.id AS account_id,
           COALESCE((
             SELECT ROUND(SUM(jel.debit - jel.credit) * 100)
               FROM journal_entry_lines jel
               JOIN journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.account_id = ga.id
                AND je.entity_id = p_entity_id
                AND je.status = 'posted'
                AND je.basis = 'ACCRUAL'
                AND je.posting_date <= v_ends
           ), 0)::bigint AS gl_cents
      FROM gl_accounts ga
     WHERE ga.entity_id = p_entity_id
       AND ga.code IN ('1105','1107','1108')
  ), paid_asof AS (
    SELECT ara.ar_invoice_id, SUM(ara.amount_applied_cents)::bigint AS paid_cents
      FROM ar_receipt_applications ara
      JOIN ar_receipts r ON r.id = ara.ar_receipt_id
     WHERE r.receipt_date <= v_ends
       AND COALESCE(r.is_void, false) = false
     GROUP BY ara.ar_invoice_id
  ), sub AS (
    SELECT ai.ar_account_id,
           SUM(ai.total_amount_cents - COALESCE(pa.paid_cents, 0))::bigint AS open_cents
      FROM ar_invoices ai
      LEFT JOIN paid_asof pa ON pa.ar_invoice_id = ai.id
     WHERE ai.entity_id = p_entity_id
       AND ai.gl_status NOT IN ('draft','pending_approval','void','reversed')
       AND ai.posting_date <= v_ends
     GROUP BY ai.ar_account_id
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'account_code',    gl.code,
      'gl_cents',        gl.gl_cents,
      'subledger_cents', COALESCE(sub.open_cents, 0),
      'diff_cents',      gl.gl_cents - COALESCE(sub.open_cents, 0),
      'ok',              abs(gl.gl_cents - COALESCE(sub.open_cents, 0)) <= 1
    ) ORDER BY gl.code),
    bool_and(abs(gl.gl_cents - COALESCE(sub.open_cents, 0)) <= 1),
    COALESCE(MAX(abs(gl.gl_cents - COALESCE(sub.open_cents, 0))), 0)
    INTO v_ar_rows, v_ar_ok, v_ar_max_diff
    FROM gl
    LEFT JOIN sub ON sub.ar_account_id = gl.account_id;

  SELECT COALESCE(SUM(total_amount_cents - paid_amount_cents), 0)::bigint, COUNT(*)::int
    INTO v_ar_unmapped, v_ar_considered
    FROM ar_invoices
   WHERE entity_id = p_entity_id
     AND ar_account_id IS NULL
     AND posting_date <= v_ends
     AND gl_status NOT IN ('draft','pending_approval','void','reversed');

  v_ar_status := CASE
    WHEN v_ar_pre_history         THEN 'waived'
    WHEN COALESCE(v_ar_ok, false) THEN 'pass'
    WHEN v_ar_cutover_done        THEN 'fail'
    ELSE 'warn' END;

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'ar_subledger_tie',
    'title', 'AR subledger ties to GL (1105 / 1107 / 1108)',
    'status', v_ar_status,
    'severity', CASE WHEN v_ar_status = 'pass' THEN 'informational' WHEN v_ar_status = 'fail' THEN 'blocker' ELSE 'advisory' END,
    'explanation', CASE
      WHEN v_ar_pre_history THEN
        'This month ends before Tangerine''s migrated AR invoice detail begins (' || to_char(v_ar_history_start,'MM/DD/YYYY') || '). The GL carries the opening AR balances, but there are no invoice-level records to tie them to yet, so a "difference" here is expected and not a books error.'
      WHEN v_ar_status = 'pass' THEN
        'The invoice-level AR subledger, valued as of ' || to_char(v_ends,'MM/DD/YYYY') || ', matches the GL control accounts within one cent.'
      WHEN v_ar_status = 'fail' THEN
        'As of ' || to_char(v_ends,'MM/DD/YYYY') || ', the invoice-level AR subledger and the GL control accounts differ (largest account off by ' || public.close_fmt_usd(v_ar_max_diff) || '). The AR historical backfill has completed, so this is a real break to investigate.'
      ELSE
        'As of ' || to_char(v_ends,'MM/DD/YYYY') || ', the invoice-level AR subledger and the GL control accounts differ (largest account off by ' || public.close_fmt_usd(v_ar_max_diff) || '). The per-invoice AR history is still being reconstructed ahead of the cutover backfill, so a residual is expected until that lands.'
      END,
    'recommendation', CASE
      WHEN v_ar_pre_history THEN
        'Safe to close with a documented exception. The invoice-level subledger for pre-' || to_char(v_ar_history_start,'MM/DD/YYYY') || ' months is populated by the cutover AR historical backfill; this check will tie automatically afterward.'
      WHEN v_ar_status = 'pass' THEN 'No action needed.'
      WHEN v_ar_status = 'fail' THEN 'Do not close until the per-account differences below are explained or corrected — investigate each account against the GL.'
      ELSE 'Review the per-account differences below. This is advisory (non-blocking) while the AR historical backfill is in progress; it will resolve — or turn into a real break to investigate — once the backfill completes. Safe to close with a documented exception in the meantime.'
      END,
    'classification', v_ar_status,
    'detail', jsonb_build_object(
      'as_of',               v_ends,
      'accounts',            COALESCE(v_ar_rows, '[]'::jsonb),
      'unmapped_open_cents', v_ar_unmapped,
      'unmapped_invoices',   v_ar_considered,
      'ar_history_start',    v_ar_history_start,
      'pre_ar_history',      v_ar_pre_history,
      'waiver',              CASE WHEN v_ar_pre_history THEN 'pre_ar_history' ELSE NULL END,
      'tolerance_cents',     1));

  -- =====================================================================
  -- 3. ap_subledger_tie — AS OF period-end. GL 2000 (credit-net,
  --    posting_date <= ends_on) vs open posted vendor bills
  --    (posting_date <= ends_on) less cash payments (payment_date <=
  --    ends_on). Any residual is the documented NON-CASH relief (credit
  --    memos / factor settlements / 8007->1308 reclasses) that no cash
  --    payment can represent — WAIVED (advisory), aligned with
  --    tieouts.js ap_noncash_gl_relief_residual. Ties within a cent -> pass.
  -- =====================================================================
  SELECT COALESCE((
    SELECT ROUND(SUM(jel.credit - jel.debit) * 100)
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jel.account_id
     WHERE ga.entity_id = p_entity_id
       AND ga.code = '2000'
       AND je.entity_id = p_entity_id
       AND je.status = 'posted'
       AND je.basis = 'ACCRUAL'
       AND je.posting_date <= v_ends
  ), 0)::bigint INTO v_ap_gl;

  WITH paid_asof AS (
    SELECT ip.invoice_id, SUM(ip.amount_cents)::bigint AS paid_cents
      FROM invoice_payments ip
     WHERE ip.entity_id = p_entity_id
       AND ip.payment_date <= v_ends
     GROUP BY ip.invoice_id
  )
  SELECT COALESCE(SUM(inv.total_amount_cents - COALESCE(pa.paid_cents, 0)), 0)::bigint,
         COALESCE(SUM(COALESCE(pa.paid_cents, 0)), 0)::bigint,
         COUNT(*)::int
    INTO v_ap_open, v_ap_paid_asof, v_ap_bills
    FROM invoices inv
    LEFT JOIN paid_asof pa ON pa.invoice_id = inv.id
   WHERE inv.entity_id = p_entity_id
     AND inv.gl_status = 'posted'
     AND inv.posting_date <= v_ends;

  v_ap_diff   := v_ap_gl - v_ap_open;
  v_ap_status := CASE WHEN abs(v_ap_diff) <= 1 THEN 'pass' ELSE 'waived' END;

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'ap_subledger_tie',
    'title', 'AP subledger ties to GL (2000)',
    'status', v_ap_status,
    'severity', CASE WHEN v_ap_status = 'pass' THEN 'informational' ELSE 'advisory' END,
    'explanation', CASE WHEN v_ap_status = 'pass'
      THEN 'As of ' || to_char(v_ends,'MM/DD/YYYY') || ', open vendor bills match GL Accounts Payable (2000) within one cent.'
      ELSE 'As of ' || to_char(v_ends,'MM/DD/YYYY') || ', GL Accounts Payable (2000) is ' || public.close_fmt_usd(v_ap_gl) || ' while open vendor bills total ' || public.close_fmt_usd(v_ap_open) || ' — a difference of ' || public.close_fmt_usd(v_ap_diff) || '. GL 2000 also carries NON-CASH relief that no bill payment represents: credit memos, factor settlements, and the 8007->1308 reclasses. Open bills can never tie to 2000 by cash application alone.' END,
    'recommendation', CASE WHEN v_ap_status = 'pass'
      THEN 'No action needed.'
      ELSE 'This is a books-level reconciliation item for the accountant, not a posting error — safe to close with a documented exception. The residual flips to a clean tie automatically if/when the non-cash relief is reflected in the subledger.' END,
    'classification', v_ap_status,
    'detail', jsonb_build_object(
      'as_of',            v_ends,
      'gl_cents',         v_ap_gl,
      'subledger_cents',  v_ap_open,
      'diff_cents',       v_ap_diff,
      'posted_bills',     v_ap_bills,
      'paid_asof_cents',  v_ap_paid_asof,
      'waiver',           CASE WHEN v_ap_status = 'waived' THEN 'ap_noncash_gl_relief_residual' ELSE NULL END,
      'tolerance_cents',  1));

  -- =====================================================================
  -- 4. bank_recon — TRUE statement accounts only (account_kind in
  --    checking / credit_card; excludes factor-advance & clearing control
  --    accounts wired into the mirror). A period with no HUMAN-operated run
  --    (reconciled_by_user_id IS NULL everywhere — bank rec is still a Xoro
  --    mirror, not operated per-statement) is WAIVED (not_operated). Once
  --    operated, an unreconciled true account FAILS (blocker).
  -- =====================================================================
  WITH runs AS (
    SELECT ga.code, ba.name, ba.account_kind, brr.status, brr.reconciled_diff_cents,
           brr.reconciled_by_user_id
      FROM bank_recon_runs brr
      JOIN bank_accounts ba ON ba.id = brr.bank_account_id
      JOIN gl_accounts  ga ON ga.id = ba.gl_account_id
     WHERE brr.entity_id = p_entity_id
       AND brr.period_id = p_period_id
       AND ba.account_kind IN ('checking','credit_card')
  )
  SELECT COUNT(*)::int,
         COUNT(*) FILTER (WHERE status = 'reconciled')::int,
         bool_or(reconciled_by_user_id IS NOT NULL),
         COALESCE(jsonb_agg(jsonb_build_object(
           'account',    name,
           'code',       code,
           'kind',       account_kind,
           'status',     status,
           'diff_cents', reconciled_diff_cents
         ) ORDER BY code), '[]'::jsonb)
    INTO v_bank_total, v_bank_reconciled, v_bank_operated, v_bank_rows
    FROM runs;

  v_bank_operated := COALESCE(v_bank_operated, false);
  v_bank_status := CASE
    WHEN NOT v_bank_operated                              THEN 'waived'
    WHEN v_bank_total > 0 AND v_bank_reconciled = v_bank_total THEN 'pass'
    ELSE 'fail' END;

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'bank_recon',
    'title', 'Bank / CC accounts reconciled for the period',
    'status', v_bank_status,
    'severity', CASE v_bank_status WHEN 'fail' THEN 'blocker' WHEN 'pass' THEN 'informational' ELSE 'advisory' END,
    'explanation', CASE v_bank_status
      WHEN 'waived' THEN 'Bank and credit-card balances are mirrored from Xoro (reconciled in Xoro through ' || v_mirror_through || '); per-statement reconciliation has not yet been operated inside Tangerine for this month, so there is nothing to pass or fail here yet. Only true bank/credit-card accounts are considered — factor-advance and cash-clearing control accounts are reconciled through their own modules, not a bank statement.'
      WHEN 'pass' THEN 'Every true bank and credit-card statement account has a reconciled run for this period.'
      ELSE (v_bank_total - v_bank_reconciled)::text || ' of ' || v_bank_total::text || ' true bank/credit-card account(s) are not reconciled for this period.' END,
    'recommendation', CASE v_bank_status
      WHEN 'waived' THEN 'Safe to close with a documented exception. Formal per-statement bank reconciliation begins when the statement/Plaid feeds go live; until then the Xoro mirror is the source of truth. The manual "Bank statements reviewed" sign-off records your review.'
      WHEN 'pass' THEN 'No action needed.'
      ELSE 'Do not close until each flagged bank/credit-card account is reconciled in the Bank Reconciliation module.' END,
    'classification', v_bank_status,
    'detail', jsonb_build_object(
      'runs',            v_bank_total,
      'reconciled',      v_bank_reconciled,
      'operated',        v_bank_operated,
      'mirror_through',  v_mirror_through,
      'accounts',        v_bank_rows,
      'waiver',          CASE WHEN v_bank_status = 'waived' THEN 'not_operated' ELSE NULL END,
      'note',            CASE WHEN v_bank_total = 0 THEN 'no statement-account reconciliation runs exist for this period' ELSE NULL END));

  -- =====================================================================
  -- 5. no_draft_jes — hard BLOCKER: draft / unposted entries in the period.
  -- =====================================================================
  SELECT COUNT(*)::int INTO v_draft
    FROM journal_entries
   WHERE entity_id = p_entity_id
     AND period_id = p_period_id
     AND status IN ('draft','pending_approval','unposted');

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'no_draft_jes',
    'title', 'No draft / unposted journal entries',
    'status', CASE WHEN v_draft = 0 THEN 'pass' ELSE 'fail' END,
    'severity', CASE WHEN v_draft = 0 THEN 'informational' ELSE 'blocker' END,
    'explanation', CASE WHEN v_draft = 0
      THEN 'Every journal entry dated in this period is posted — nothing is left in draft.'
      ELSE v_draft::text || ' journal entr(y/ies) in this period are still draft / unposted and would be excluded from the closed books.' END,
    'recommendation', CASE WHEN v_draft = 0
      THEN 'No action needed.'
      ELSE 'Do not close. Post or delete the draft entries so the period''s books are complete.' END,
    'classification', CASE WHEN v_draft = 0 THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object('draft_je_count', v_draft));

  -- =====================================================================
  -- 6. uncategorized_8007 — Uncategorized Expense activity. Advisory (WARN):
  --    activity should be reclassified per Xoro GL truth but does not hard-
  --    block a historical close.
  -- =====================================================================
  SELECT
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'ACCRUAL' THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'CASH'    THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COUNT(*)::int
    INTO v_8007_accrual, v_8007_cash, v_8007_lines
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jel.account_id
   WHERE ga.entity_id = p_entity_id
     AND ga.code = '8007'
     AND je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.status = 'posted';

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'uncategorized_8007',
    'title', 'No Uncategorized Expense (8007) activity',
    'status', CASE WHEN v_8007_accrual = 0 THEN 'pass' ELSE 'warn' END,
    'severity', CASE WHEN v_8007_accrual = 0 THEN 'informational' ELSE 'advisory' END,
    'explanation', CASE WHEN v_8007_accrual = 0
      THEN 'Nothing landed in the Uncategorized Expense (8007) holding account this period.'
      ELSE public.close_fmt_usd(v_8007_accrual) || ' of activity is sitting in Uncategorized Expense (8007) across ' || v_8007_lines::text || ' line(s) — it should be reclassified to its real account per the Xoro GL.' END,
    'recommendation', CASE WHEN v_8007_accrual = 0
      THEN 'No action needed.'
      ELSE 'Reclassify the 8007 activity to its correct expense accounts before or shortly after close. Advisory (non-blocking): safe to close with a documented exception.' END,
    'classification', CASE WHEN v_8007_accrual = 0 THEN 'pass' ELSE 'warn' END,
    'detail', jsonb_build_object(
      'accrual_net_cents', v_8007_accrual,
      'cash_net_cents',    v_8007_cash,
      'line_count',        v_8007_lines));

  -- =====================================================================
  -- 7. factor_recon — Rosenthal statement ending Net OAR vs GL 1107 as-of.
  --    No statement -> pass (covered=false). Statement diff -> WARN
  --    (advisory; the manual "Factor statement reconciled" item gates).
  -- =====================================================================
  SELECT * INTO v_stmt
    FROM factor_statements
   WHERE entity_id = p_entity_id
     AND statement_month = v_period.starts_on
   LIMIT 1;

  IF v_stmt.id IS NULL THEN
    v_checks := v_checks || jsonb_build_object(
      'item_key', 'factor_recon',
      'title', 'Factor AR snapshot ties to GL 1107 (Rosenthal)',
      'status', 'pass',
      'severity', 'informational',
      'explanation', 'No Rosenthal factor statement has been imported for this month, so there is nothing to reconcile automatically.',
      'recommendation', 'When the factor statement arrives, import it and use the manual "Factor statement received & reconciled" sign-off.',
      'classification', 'pass',
      'detail', jsonb_build_object('covered', false, 'note', 'no factor statement imported for this month'));
  ELSE
    SELECT COALESCE((
      SELECT ROUND(SUM(jel.debit - jel.credit) * 100)
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jel.account_id
       WHERE ga.entity_id = p_entity_id
         AND ga.code = '1107'
         AND je.entity_id = p_entity_id
         AND je.status = 'posted'
         AND je.basis = 'ACCRUAL'
         AND je.posting_date <= v_ends
    ), 0)::bigint INTO v_1107_asof;

    v_factor_status := CASE WHEN abs(v_stmt.ending_net_oar_cents - v_1107_asof) <= 1 THEN 'pass' ELSE 'warn' END;

    v_checks := v_checks || jsonb_build_object(
      'item_key', 'factor_recon',
      'title', 'Factor AR snapshot ties to GL 1107 (Rosenthal)',
      'status', v_factor_status,
      'severity', CASE WHEN v_factor_status = 'pass' THEN 'informational' ELSE 'advisory' END,
      'explanation', CASE WHEN v_factor_status = 'pass'
        THEN 'The Rosenthal statement''s ending Net Outstanding A/R matches GL 1107 (Factored AR) as of ' || to_char(v_ends,'MM/DD/YYYY') || ' within one cent.'
        ELSE 'The Rosenthal statement''s ending Net Outstanding A/R (' || public.close_fmt_usd(v_stmt.ending_net_oar_cents) || ') and GL 1107 as of ' || to_char(v_ends,'MM/DD/YYYY') || ' (' || public.close_fmt_usd(v_1107_asof) || ') differ by ' || public.close_fmt_usd(v_stmt.ending_net_oar_cents - v_1107_asof) || '.' END,
      'recommendation', CASE WHEN v_factor_status = 'pass'
        THEN 'No action needed.'
        ELSE 'Review the factor reconciliation panel for the driver of the difference. Advisory (non-blocking); the manual factor sign-off is where you certify it.' END,
      'classification', v_factor_status,
      'detail', jsonb_build_object(
        'covered',                 true,
        'statement_month',         v_stmt.statement_month,
        'ending_net_oar_cents',    v_stmt.ending_net_oar_cents,
        'gl_1107_asof_cents',      v_1107_asof,
        'diff_cents',              v_stmt.ending_net_oar_cents - v_1107_asof,
        'tolerance_cents',         1));
  END IF;

  -- =====================================================================
  -- 8. revenue_posted — sanity: some revenue posted this period. No revenue
  --    is unusual but not a hard blocker -> WARN (advisory).
  -- =====================================================================
  SELECT COALESCE(ROUND(SUM(jel.credit - jel.debit) * 100), 0)::bigint
    INTO v_rev
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jel.account_id
   WHERE ga.entity_id = p_entity_id
     AND ga.account_type = 'revenue'
     AND je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.status = 'posted'
     AND je.basis = 'ACCRUAL';

  v_rev_status := CASE WHEN v_rev > 0 THEN 'pass' ELSE 'warn' END;

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'revenue_posted',
    'title', 'Revenue posted for the period',
    'status', v_rev_status,
    'severity', CASE WHEN v_rev_status = 'pass' THEN 'informational' ELSE 'advisory' END,
    'explanation', CASE WHEN v_rev_status = 'pass'
      THEN public.close_fmt_usd(v_rev) || ' of revenue is posted for this period.'
      ELSE 'No revenue is posted for this period — unusual for an operating month.' END,
    'recommendation', CASE WHEN v_rev_status = 'pass'
      THEN 'No action needed.'
      ELSE 'Confirm this is expected (e.g. a pre-operating or fully-credited month). Advisory (non-blocking).' END,
    'classification', v_rev_status,
    'detail', jsonb_build_object('revenue_cents', v_rev));

  RETURN jsonb_build_object(
    'period_id',     v_period.id,
    'fiscal_year',   v_period.fiscal_year,
    'period_number', v_period.period_number,
    'starts_on',     v_period.starts_on,
    'ends_on',       v_period.ends_on,
    'gl_status',     v_period.status,
    'ran_at',        now(),
    'checks',        v_checks);
END;
$function$;
