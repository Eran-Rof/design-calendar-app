-- ════════════════════════════════════════════════════════════════════════════
-- Xoro GL mirror — nightly incremental poster  (#xoro-gl-nightly-poster,
-- 2026-07-21, CEO-approved "Automate nightly")
--
-- WHY
--   The 2026-07-13 one-time full rebuild (scripts/gl-rebuild/stage1_post_month_
--   _template.sql) posted one xoro_gl_mirror JE per Xoro TxnId for everything
--   STAGED at that moment. The staging table xoro_gl_transactions keeps flowing
--   nightly (rof_xoro_project/scripts/rest_gl_sync.py -> POST /api/xoro/sync-gl),
--   but NOTHING posted staged->GL after the rebuild — so 07-13..07-20 revenue
--   (~$789K) sat in staging, unposted, and July GL revenue read $1.10M vs Xoro's
--   ~$1.9M. Root cause: no scheduled incremental poster. This function IS that
--   poster, wired to a nightly cron (api/_handlers/cron/xoro-gl-mirror-post.js).
--
-- WHAT IT DOES (idempotent, bounded, guard-gated)
--   For the CURRENT OPEN MONTH only, posts every staged Xoro txn NOT already
--   mirrored, one balanced double-entry JE per TxnId, THROUGH the T11-audited
--   posting engine gl_post_journal_entry() (sets app.audit_reason, fires balance
--   + period-lock + hard-lock + account-active guards). JEs are byte-for-byte the
--   same shape the rebuild produced (journal_type/source_table='xoro_gl_mirror',
--   source_id=TxnId, source_module=lower(txn_type), description, penny residual to
--   8001) so the Income Statement / drills treat them identically.
--
--   IDEMPOTENT: candidate set excludes any TxnId already mirrored
--   (source_table='xoro_gl_mirror' AND source_id=TxnId AND basis='ACCRUAL');
--   re-runs and the db-push re-apply are safe no-ops.
--
--   BOUNDED: posts at most p_max_txns per call (service_role 60s budget); a
--   normal day's delta is ~150 txns. Any remainder is reported so the cron/digest
--   sees the backlog and the next run continues.
--
-- HARD GUARDS — abort WITHOUT posting anything (the cron writes an app_errors
-- 'cron' breadcrumb the daily digest surfaces) when:
--   G1 period_not_open : the open month's gl_periods row is missing or its status
--                        is not 'open' (never auto-post into soft_close/closed).
--   G2 stale_feed      : MAX(xoro_gl_transactions.synced_at) is older than
--                        p_stale_hours (feed frozen — don't under-post silently).
--   G3 unmapped_or_unbalanced : ANY candidate txn has a non-zero leg with no
--                        xoro_account_map row, or nets outside +/-$1.00. A mapping
--                        gap means the month would post lopsided — abort + alert so
--                        someone curates xoro_account_map (build-xoro-account-map.mjs)
--                        first; next run posts cleanly. (Stricter than stage1, which
--                        skipped+reported — the CEO signed off on abort-the-run.)
--   G4 missing_8001    : the 8001 Penny Rounding account is absent.
--
-- T11: every gl_post carries audit_reason + audit_source='cron' (parity with the
-- channel-reclass poster 20260985; the rebuild disabled triggers, this does NOT).
--
-- STABLE inputs, entity-scoped to rof_entity_id(). Idempotent DDL (CREATE OR
-- REPLACE). Read the migration-tracking footer note before renumbering.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION xoro_gl_mirror_post_open_month(
  p_month      text    DEFAULT NULL,   -- 'YYYY-MM'; NULL => current UTC month
  p_max_txns   integer DEFAULT 600,    -- bounded chunk (service_role 60s budget)
  p_stale_hours integer DEFAULT 30     -- staging freshness threshold on synced_at
)
RETURNS jsonb
LANGUAGE plpgsql
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
  v_lines      jsonb;
  v_resid      jsonb;
  v_nlines     integer;
  v_je         uuid;
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
           || 'xoro_gl_transactions staging; idempotent by source_id=TxnId.';

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
  --   candidate = txn in the month, at least one non-zero leg, NOT already
  --   mirrored. Guard trips if any candidate has an unmapped non-zero leg or
  --   nets outside +/-$1.00.
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

  -- ── Post (bounded, oldest first) ────────────────────────────────────────
  FOR r IN
    SELECT txn_id, txn_date, tt, txn_number, ref_number, net
      FROM _xglm_cand
     ORDER BY txn_date, txn_id
     LIMIT p_max_txns
  LOOP
    -- Build the balanced line array from this txn's non-zero legs (guaranteed
    -- fully mapped by G3). amt>0 => DEBIT, amt<0 => CREDIT.
    WITH l AS (
      SELECT round(x.amount_home, 2) AS amt, m.gl_account_id, x.row_seq,
             x.accounting_name AS acctname, x.memo AS xmemo
      FROM xoro_gl_transactions x
      JOIN xoro_account_map m ON m.xoro_accounting_name = coalesce(x.accounting_name, '')
      WHERE x.txn_id = r.txn_id AND round(x.amount_home, 2) <> 0
    ),
    seq AS (SELECT *, row_number() OVER (ORDER BY row_seq) AS rn FROM l)
    SELECT jsonb_agg(jsonb_build_object(
             'line_number', rn,
             'account_id',  gl_account_id,
             'debit',       CASE WHEN amt > 0 THEN amt ELSE 0 END,
             'credit',      CASE WHEN amt < 0 THEN -amt ELSE 0 END,
             'memo', left(coalesce(nullif(acctname, ''), '(uncategorized)')
                          || coalesce(' - ' || nullif(xmemo, ''), ''), 240)
           ) ORDER BY rn), max(rn)
      INTO v_lines, v_nlines
      FROM seq;

    IF v_lines IS NULL THEN
      CONTINUE;  -- defensive: no non-zero legs (nz>=1 guard should prevent)
    END IF;

    -- Penny residual to 8001 (Xoro sub-cent rounding), leg amt = -net.
    IF r.net <> 0 THEN
      v_resid := jsonb_build_array(jsonb_build_object(
        'line_number', v_nlines + 1,
        'account_id',  v_8001,
        'debit',  CASE WHEN (-r.net) > 0 THEN (-r.net) ELSE 0 END,
        'credit', CASE WHEN (-r.net) < 0 THEN  r.net  ELSE 0 END,
        'memo', 'Penny rounding adjustment (Xoro sub-cent residual)'));
      v_lines := v_lines || v_resid;
    END IF;

    v_je := gl_post_journal_entry(jsonb_build_object(
      'entity_id',     v_rof,
      'basis',         'ACCRUAL',
      'journal_type',  'xoro_gl_mirror',
      'posting_date',  r.txn_date,
      'source_module', lower(replace(coalesce(r.tt, 'xoro_gl'), ' ', '_')),
      'source_table',  'xoro_gl_mirror',
      'source_id',     r.txn_id,
      'description',   left('Xoro GL mirror - ' || coalesce(r.tt, 'Txn') || ' '
                        || coalesce(r.ref_number, r.txn_number, '') || ' (' || r.txn_date::text || ')'
                        || CASE WHEN r.net <> 0 THEN ' [rounding ' || r.net::text || ' to 8001]' ELSE '' END, 400),
      'audit_reason',  v_reason,
      'audit_source',  'cron',
      'lines',         v_lines
    ));
    v_posted := v_posted + 1;

    -- Revenue contribution of this txn (revenue = -amt, contra_revenue = +amt).
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
  'Nightly incremental Xoro GL mirror poster (#xoro-gl-nightly-poster, CEO 2026-07-21). Posts every staged xoro_gl_transactions txn NOT already mirrored for the CURRENT OPEN MONTH, one balanced xoro_gl_mirror JE per TxnId via the T11-audited gl_post_journal_entry (audit_source=cron). Idempotent (source_id=TxnId), bounded (p_max_txns), 8001 penny residual. Hard guards abort WITHOUT posting: period_not_open, stale_feed (synced_at > p_stale_hours), unmapped_or_unbalanced candidate, missing_8001. Returns a jsonb run summary.';

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
    VALUES ('20269000000000', 'xoro_gl_mirror_nightly_poster', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $mig$;
