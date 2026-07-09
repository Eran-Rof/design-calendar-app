-- 20260966000000_drill_phase2_segment_gl.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Drill-through Phase 2 — Segment P&L cell → GL account activity.
--
-- Two small read-only helpers (both STABLE, idempotent CREATE OR REPLACE):
--
-- 1. segment_pl_gl_drill(entity, from, to)
--    Same aggregation as segment_pl_breakdown() but one grain finer: adds
--    is_pl (style_code ends in 'PL' — the SAME private-label convention
--    api/_lib/accounting/revenueRouting.js#isPrivateLabelStyle uses when the
--    Xoro bridge routes revenue). The gl-drill handler maps each (brand,
--    channel, store, gender, is_pl) group through resolveRevenueRouting to the
--    revenue/COGS account the bridge posts it to, so a Segment P&L cell can
--    list exactly the GL accounts behind it.
--
-- 2. gl_range_activity_by_code(entity, basis, from, to, codes[])
--    Posted-JE debit/credit totals per account over a posting-date range,
--    returned in CENTS (journal_entry_lines stores DOLLARS — same ×100 the
--    gl_detail RPC applies), filtered to an explicit code list. Used to show
--    "GL posted" next to each mapped account without paging JE lines through
--    PostgREST.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION segment_pl_gl_drill(
  p_entity_id uuid,
  p_from_date date,
  p_to_date   date
)
RETURNS TABLE (
  brand_id     uuid,
  brand_code   text,
  brand_name   text,
  channel_code text,
  store_key    text,
  gender_code  text,
  is_pl        boolean,
  lines        bigint,
  qty          numeric,
  net_sales    numeric,
  cogs         numeric
) AS $$
  SELECT
    v.brand_id,
    bm.code,
    bm.name,
    v.channel_code,
    v.store_key,
    v.gender_code,
    (v.style_code ~* 'PL$') AS is_pl,
    count(*)::bigint            AS lines,
    sum(v.qty)                  AS qty,
    round(sum(v.net_sales), 2)  AS net_sales,
    round(sum(v.cogs), 2)       AS cogs
  FROM v_sales_dimensional v
  LEFT JOIN brand_master bm ON bm.id = v.brand_id
  WHERE v.entity_id = p_entity_id
    AND v.txn_date >= p_from_date
    AND v.txn_date <= p_to_date
  GROUP BY v.brand_id, bm.code, bm.name, v.channel_code, v.store_key, v.gender_code, (v.style_code ~* 'PL$');
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION segment_pl_gl_drill(uuid, date, date) IS
  'Drill-through Phase 2 — segment_pl_breakdown() plus an is_pl split (style_code ~* PL$, mirroring revenueRouting.isPrivateLabelStyle) so the gl-drill handler can map each dimension group to its routed revenue/COGS GL account.';

CREATE OR REPLACE FUNCTION gl_range_activity_by_code(
  p_entity_id uuid,
  p_basis     text,
  p_from_date date,
  p_to_date   date,
  p_codes     text[]
)
RETURNS TABLE (
  account_id   uuid,
  code         text,
  name         text,
  account_type text,
  debit_cents  bigint,
  credit_cents bigint
) AS $$
  SELECT
    ga.id,
    ga.code,
    ga.name,
    ga.account_type,
    COALESCE(SUM(jel.debit  * 100), 0)::bigint AS debit_cents,
    COALESCE(SUM(jel.credit * 100), 0)::bigint AS credit_cents
  FROM gl_accounts ga
  LEFT JOIN (
    journal_entry_lines jel
    JOIN journal_entries je
      ON je.id = jel.journal_entry_id
     AND je.status = 'posted'
     AND je.basis  = upper(p_basis)
     AND je.posting_date BETWEEN p_from_date AND p_to_date
  ) ON jel.account_id = ga.id AND je.entity_id = p_entity_id
  WHERE ga.entity_id = p_entity_id
    AND ga.code = ANY(p_codes)
  GROUP BY ga.id, ga.code, ga.name, ga.account_type;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION gl_range_activity_by_code(uuid, text, date, date, text[]) IS
  'Drill-through Phase 2 — posted debit/credit totals (CENTS; JE lines store dollars) per account code over a posting-date range. Accounts with no activity still return a zero row so the drill can show "no GL activity yet".';

NOTIFY pgrst, 'reload schema';
