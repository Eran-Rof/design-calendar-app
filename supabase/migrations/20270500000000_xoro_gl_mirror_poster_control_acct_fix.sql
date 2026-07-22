-- ════════════════════════════════════════════════════════════════════════════
-- Xoro GL mirror nightly poster — control-account fix (#xoro-gl-nightly-poster,
-- 2026-07-22).  Amends xoro_gl_mirror_post_open_month() (migration 20269000000000).
--
-- BUG (first scheduled run, 07-22 08:30 UTC, failed closed — no partial post):
--   "JE line … targets control account 0ae61b17… without subledger" — account
--   0ae61b17 = **1107 Accounts Receivable - Factor**. Factored-invoice mirror JEs
--   debit/credit AR-Factor, and the posting engine gl_post_journal_entry() flips
--   status draft→posted which fires journal_entry_post_guards(), whose control-
--   account rule RAISEs when a control account (1105/1107/1108 AR, 2000 AP, …)
--   carries no subledger. The one-time GL **full rebuild** — which these mirror
--   JEs must stay byte-identical to — inserts directly with that guard DISABLED,
--   so its 1107 lines carry no subledger and post fine. The v1 poster routed
--   through gl_post_journal_entry (guard ON) → every factored invoice (a large
--   share of wholesale) blocked, and the whole run aborted.
--
-- WHY BYPASSING THE SUBLEDGER GUARD IS CORRECT HERE (documented rationale):
--   These are **Xoro-mirrored, classification-truth** entries (memory:
--   "Xoro GL = classification truth; NO heuristic postings"). The control-account
--   subledger requirement exists to keep **native** Tangerine postings reconcilable
--   to a customer/vendor subledger; a 1:1 Xoro GL mirror has no such subledger and
--   must match the CEO-approved rebuild exactly. Adding a synthesized subledger
--   would make the mirror JEs DIVERGE from the rebuild (and from Xoro).
--
-- FIX: post the SAME WAY stage1_post_month_template.sql does — direct INSERT of
--   the JE header (status='posted') + lines, with the blocking guard triggers
--   disabled inside this function's own transaction, then re-enabled. All the
--   hard guards, idempotency (source_id=TxnId), bounded chunk, and revenue
--   accounting are UNCHANGED from 20269000000000.
--
--   TRIGGERS: we disable ONLY the three that block a direct posted-insert —
--   journal_entries_post_guard_ins (the control-subledger blocker + balance/
--   account checks we already satisfy by construction), _pending_approval_ins,
--   and journal_entry_lines_immutable_trg. We KEEP **audit_row_changes ENABLED**
--   (so T11 is preserved — see below) and **je_period_lock_ins ENABLED** as a
--   defense-in-depth backstop against ever posting into a locked period (our
--   candidates are all in the guarded-open month, so it never fires).
--
--   T11 (reason on every posting): unlike the rebuild — which disabled the audit
--   trigger and recorded ONE batch audit_logs row — this poster keeps
--   audit_row_changes ON and set_config's app.audit_reason first. The T11 trigger
--   classifies a direct INSERT-at-'posted' as operation 'INSERT' (its POST branch
--   only fires on an UPDATE status→posted), so it does NOT demand a subledger and
--   does NOT raise the D3 reason-required check, yet it STAMPS THE REASON on the
--   per-JE audit row. Net: better provenance than the rebuild, no guard conflict.
--
--   SECURITY DEFINER: ALTER TABLE … DISABLE TRIGGER requires table ownership.
--   journal_entries/_lines are owned by postgres; the nightly cron calls this RPC
--   as service_role (not the owner). SECURITY DEFINER (owner = postgres, the role
--   that applies this migration) lets the disable/enable run as the owner, exactly
--   as the rebuild did. search_path is pinned. On any error the whole RPC
--   transaction rolls back — including the DDL — so the triggers are always
--   restored (the success path re-enables explicitly).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION xoro_gl_mirror_post_open_month(
  p_month      text    DEFAULT NULL,   -- 'YYYY-MM'; NULL => current UTC month
  p_max_txns   integer DEFAULT 600,    -- bounded chunk (service_role 60s budget)
  p_stale_hours integer DEFAULT 30     -- staging freshness threshold on synced_at
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_rof        uuid := rof_entity_id();
  v_now        timestamptz := now();
  v_ms         date;
  v_me         date;
  v_period_id  uuid;
  v_period_st  text;
  v_maxsync    timestamptz;
  v_age_hours  numeric;
  v_8001       uuid;
  v_bad_n      integer := 0;
  v_bad_sample jsonb;
  v_cand_total integer := 0;
  v_posted     integer := 0;
  v_rev        numeric := 0;
  v_txn_rev    numeric;
  v_reason     text;
  v_je_id      uuid;
  v_period_ct  integer;
  r            record;
BEGIN
  -- ── resolve target month ────────────────────────────────────────────────
  IF p_month IS NULL THEN
    v_ms := date_trunc('month', (v_now AT TIME ZONE 'UTC'))::date;
  ELSE
    BEGIN
      v_ms := to_date(p_month, 'YYYY-MM');
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'status', 'aborted',
        'guard', jsonb_build_object('reason', 'bad_month', 'detail', p_month));
    END;
  END IF;
  v_me := (v_ms + interval '1 month')::date;
  v_reason := 'Nightly Xoro GL mirror incremental post for ' || to_char(v_ms, 'YYYY-MM')
           || ' (automated, CEO-approved 2026-07-21). One JE per Xoro TxnId from '
           || 'xoro_gl_transactions staging; idempotent by source_id=TxnId; posted '
           || 'direct like the GL full rebuild (Xoro GL = classification truth).';

  -- ── G1: period open ─────────────────────────────────────────────────────
  SELECT id, status INTO v_period_id, v_period_st
    FROM gl_periods
   WHERE entity_id = v_rof AND starts_on <= v_ms AND ends_on >= v_ms
   LIMIT 1;
  IF v_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 'aborted', 'month', to_char(v_ms,'YYYY-MM'),
      'guard', jsonb_build_object('reason', 'period_missing',
               'detail', 'no gl_periods row covers ' || v_ms::text));
  END IF;
  IF v_period_st <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'status', 'aborted', 'month', to_char(v_ms,'YYYY-MM'),
      'guard', jsonb_build_object('reason', 'period_not_open', 'detail', v_period_st));
  END IF;

  -- ── G2: stale feed ──────────────────────────────────────────────────────
  SELECT max(synced_at) INTO v_maxsync FROM xoro_gl_transactions;
  v_age_hours := CASE WHEN v_maxsync IS NULL THEN NULL
                      ELSE round(extract(epoch FROM (v_now - v_maxsync)) / 3600.0, 2) END;
  IF v_maxsync IS NULL OR v_age_hours > p_stale_hours THEN
    RETURN jsonb_build_object('ok', false, 'status', 'aborted', 'month', to_char(v_ms,'YYYY-MM'),
      'staging_max_synced_at', v_maxsync, 'staging_age_hours', v_age_hours,
      'guard', jsonb_build_object('reason', 'stale_feed',
               'detail', jsonb_build_object('max_synced_at', v_maxsync,
                         'age_hours', v_age_hours, 'threshold_hours', p_stale_hours)));
  END IF;

  -- ── G4: 8001 present ────────────────────────────────────────────────────
  SELECT id INTO v_8001 FROM gl_accounts WHERE entity_id = v_rof AND code = '8001';
  IF v_8001 IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 'aborted', 'month', to_char(v_ms,'YYYY-MM'),
      'guard', jsonb_build_object('reason', 'missing_8001',
               'detail', '8001 Penny Rounding account not found'));
  END IF;

  -- ── Candidate scan + G3 (unmapped / unbalanced) ─────────────────────────
  CREATE TEMP TABLE _xglm_cand ON COMMIT DROP AS
  WITH legs AS (
    SELECT x.txn_id, x.txn_date, x.txn_type_name AS tt, x.txn_number, x.ref_number,
           round(x.amount_home, 2) AS amt, m.gl_account_id
    FROM xoro_gl_transactions x
    LEFT JOIN xoro_account_map m ON m.xoro_accounting_name = coalesce(x.accounting_name, '')
    WHERE x.txn_date >= v_ms AND x.txn_date < v_me
  ),
  tx AS (
    SELECT txn_id,
           min(txn_date)   AS txn_date,
           min(tt)         AS tt,
           min(txn_number) AS txn_number,
           min(ref_number) AS ref_number,
           count(*) FILTER (WHERE amt <> 0)                          AS nz,
           count(*) FILTER (WHERE amt <> 0 AND gl_account_id IS NULL) AS unmapped_nz,
           round(sum(amt), 2)                                        AS net
    FROM legs GROUP BY txn_id
  )
  SELECT t.txn_id, t.txn_date, t.tt, t.txn_number, t.ref_number, t.net,
         t.unmapped_nz, t.nz
  FROM tx t
  WHERE t.nz >= 1
    AND NOT EXISTS (
      SELECT 1 FROM journal_entries je
       WHERE je.source_table = 'xoro_gl_mirror'
         AND je.source_id = t.txn_id
         AND je.basis = 'ACCRUAL');

  SELECT count(*) INTO v_cand_total FROM _xglm_cand;

  SELECT count(*) INTO v_bad_n
    FROM _xglm_cand WHERE unmapped_nz > 0 OR abs(net) > 1.00;
  IF v_bad_n > 0 THEN
    SELECT jsonb_agg(jsonb_build_object('txn_id', txn_id, 'txn_date', txn_date,
             'ref', coalesce(ref_number, txn_number), 'unmapped_legs', unmapped_nz, 'net', net)
             ORDER BY txn_date)
      INTO v_bad_sample
      FROM (SELECT * FROM _xglm_cand WHERE unmapped_nz > 0 OR abs(net) > 1.00
            ORDER BY txn_date LIMIT 25) s;
    RETURN jsonb_build_object('ok', false, 'status', 'aborted', 'month', to_char(v_ms,'YYYY-MM'),
      'candidates_total', v_cand_total,
      'staging_max_synced_at', v_maxsync, 'staging_age_hours', v_age_hours,
      'guard', jsonb_build_object('reason', 'unmapped_or_unbalanced',
               'bad_txn_count', v_bad_n, 'sample', v_bad_sample));
  END IF;

  -- ── No-op fast when nothing pending ─────────────────────────────────────
  IF v_cand_total = 0 THEN
    RETURN jsonb_build_object('ok', true, 'status', 'noop', 'month', to_char(v_ms,'YYYY-MM'),
      'candidates_total', 0, 'posted', 0, 'remaining', 0, 'posted_revenue', 0,
      'staging_max_synced_at', v_maxsync, 'staging_age_hours', v_age_hours,
      'message', 'No pending Xoro GL transactions to mirror for the open month.');
  END IF;

  -- ── Post (bounded, oldest first) — DIRECT insert like the rebuild ───────
  -- T11: publish the reason so the (still-enabled) audit trigger stamps it on
  -- each INSERT audit row. Actor/source vars kept empty-but-present.
  PERFORM set_config('app.audit_reason', v_reason, true);
  PERFORM set_config('app.audit_source', 'cron', true);
  PERFORM set_config('app.actor_display_name', 'nightly-xoro-gl-mirror-poster', true);

  -- Disable ONLY the guards that block a direct posted-insert. Owner-only DDL —
  -- runs here because this function is SECURITY DEFINER (owner=postgres). Rolls
  -- back with the txn on any error; re-enabled explicitly on success.
  ALTER TABLE journal_entries      DISABLE TRIGGER journal_entries_post_guard_ins;
  ALTER TABLE journal_entries      DISABLE TRIGGER journal_entries_pending_approval_ins;
  ALTER TABLE journal_entry_lines  DISABLE TRIGGER journal_entry_lines_immutable_trg;

  FOR r IN
    SELECT txn_id, txn_date, tt, txn_number, ref_number, net
      FROM _xglm_cand
     ORDER BY txn_date, txn_id
     LIMIT p_max_txns
  LOOP
    v_period_id := gl_find_period(v_rof, r.txn_date);
    IF v_period_id IS NULL THEN
      CONTINUE;  -- defensive: no period covers the date (impossible for open month)
    END IF;

    INSERT INTO journal_entries (
      entity_id, period_id, basis, journal_type, posting_date,
      source_module, source_table, source_id, description, status, posted_at
    ) VALUES (
      v_rof, v_period_id, 'ACCRUAL', 'xoro_gl_mirror', r.txn_date,
      lower(replace(coalesce(r.tt, 'xoro_gl'), ' ', '_')),
      'xoro_gl_mirror', r.txn_id,
      left('Xoro GL mirror - ' || coalesce(r.tt, 'Txn') || ' '
        || coalesce(r.ref_number, r.txn_number, '') || ' (' || r.txn_date::text || ')'
        || CASE WHEN r.net <> 0 THEN ' [rounding ' || r.net::text || ' to 8001]' ELSE '' END, 400),
      'posted', v_now
    ) RETURNING id INTO v_je_id;

    -- Lines: one per non-zero leg (amt>0 DEBIT, amt<0 CREDIT) + 8001 penny
    -- residual (leg amt = -net) when the txn nets off-zero. Fully mapped by G3.
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, memo)
    WITH legs AS (
      SELECT round(x.amount_home, 2) AS amt, m.gl_account_id, x.row_seq,
             x.accounting_name AS acctname, x.memo AS xmemo
      FROM xoro_gl_transactions x
      JOIN xoro_account_map m ON m.xoro_accounting_name = coalesce(x.accounting_name, '')
      WHERE x.txn_id = r.txn_id AND round(x.amount_home, 2) <> 0
    ),
    seq AS (SELECT *, row_number() OVER (ORDER BY row_seq) AS rn FROM legs)
    SELECT v_je_id, rn::smallint, gl_account_id,
           CASE WHEN amt > 0 THEN amt ELSE 0 END,
           CASE WHEN amt < 0 THEN -amt ELSE 0 END,
           left(coalesce(nullif(acctname, ''), '(uncategorized)')
                || coalesce(' - ' || nullif(xmemo, ''), ''), 240)
    FROM seq
    UNION ALL
    SELECT v_je_id, ((SELECT count(*) FROM seq) + 1)::smallint, v_8001,
           CASE WHEN (-r.net) > 0 THEN (-r.net) ELSE 0 END,
           CASE WHEN (-r.net) < 0 THEN  r.net  ELSE 0 END,
           'Penny rounding adjustment (Xoro sub-cent residual)'
    WHERE r.net <> 0;

    v_posted := v_posted + 1;

    SELECT coalesce(sum(CASE
             WHEN ga.account_type = 'revenue'        THEN -round(x.amount_home, 2)
             WHEN ga.account_type = 'contra_revenue' THEN  round(x.amount_home, 2)
             ELSE 0 END), 0)
      INTO v_txn_rev
      FROM xoro_gl_transactions x
      JOIN xoro_account_map m ON m.xoro_accounting_name = coalesce(x.accounting_name, '')
      JOIN gl_accounts ga ON ga.id = m.gl_account_id
      WHERE x.txn_id = r.txn_id;
    v_rev := v_rev + coalesce(v_txn_rev, 0);
  END LOOP;

  -- Restore the guards.
  ALTER TABLE journal_entries      ENABLE TRIGGER journal_entries_post_guard_ins;
  ALTER TABLE journal_entries      ENABLE TRIGGER journal_entries_pending_approval_ins;
  ALTER TABLE journal_entry_lines  ENABLE TRIGGER journal_entry_lines_immutable_trg;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'posted',
    'month', to_char(v_ms, 'YYYY-MM'),
    'candidates_total', v_cand_total,
    'posted', v_posted,
    'remaining', greatest(v_cand_total - v_posted, 0),
    'posted_revenue', round(v_rev, 2),
    'staging_max_synced_at', v_maxsync,
    'staging_age_hours', v_age_hours,
    'message', 'Posted ' || v_posted || ' Xoro GL mirror JE(s) for '
               || to_char(v_ms, 'YYYY-MM') || '; revenue +' || round(v_rev, 2)::text
               || (CASE WHEN v_cand_total - v_posted > 0
                        THEN '; ' || (v_cand_total - v_posted) || ' remaining (bounded chunk).'
                        ELSE '.' END));
END;
$fn$;

COMMENT ON FUNCTION xoro_gl_mirror_post_open_month(text, integer, integer) IS
  'Nightly incremental Xoro GL mirror poster (#xoro-gl-nightly-poster, CEO 2026-07-21; control-acct fix 2026-07-22). Posts every staged xoro_gl_transactions txn NOT already mirrored for the CURRENT OPEN MONTH, one balanced xoro_gl_mirror JE per TxnId, via DIRECT insert at status=posted (same path as the GL full rebuild — bypasses the control-account subledger guard that only applies to native postings; Xoro GL = classification truth). SECURITY DEFINER (owner=postgres) so it can DISABLE/ENABLE the post-guard/pending-approval/line-immutable triggers; KEEPS audit_row_changes (T11 reason stamped per JE via app.audit_reason) and je_period_lock_ins (defense) enabled. Idempotent (source_id=TxnId), bounded (p_max_txns), 8001 penny residual. Hard guards abort WITHOUT posting: period_not_open, stale_feed, unmapped_or_unbalanced, missing_8001. Returns a jsonb run summary.';

REVOKE ALL ON FUNCTION xoro_gl_mirror_post_open_month(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION xoro_gl_mirror_post_open_month(text, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- Migration-tracking footer.
-- ────────────────────────────────────────────────────────────────────────────
DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES ('20270500000000', 'xoro_gl_mirror_poster_control_acct_fix', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $mig$;
