-- ════════════════════════════════════════════════════════════════════════════
-- Channel reclass — Psycho Tuna ECOM revenue & COGS onto the dedicated PT-ecom
-- accounts  (#1729, 2026-07-13, CEO-directed)
--
-- CEO (2026-07-13): "in xoro all pt ecom invoices carry Shopify psychotuna as
-- the customer ... can you do the same for invoices and Cogs."
--
-- CONTEXT — companion to #1725/#1727 (ROF ecom). Unlike ROF (channel readable
-- from the invoice-number prefix), PT has NO ecom invoice prefix — every PT sale
-- is 'PT-I…'. The PT channel is carried by the CUSTOMER: Xoro tags each PT ecom
-- invoice with contact "Shopify psychotuna" (this is also how Tangerine separates
-- PT ecom inventory). Xoro posts ALL PT sales to one account "Sales Revenue - PT"
-- (ROF 4009) and all PT COGS to "Cost of Goods Sold PT" (ROF 5012), leaving the
-- dedicated PT-ecom accounts 4008 / 5013 at $0. (An earlier probe that keyed off
-- the Xoro *store* dimension wrongly concluded PT ecom was $0 — the store
-- "Psycho Tuna Ecom" only carries ecom OpEx; the sales/COGS live under store
-- "Psycho Tuna" tagged by the ecom customer. Corrected here.)
--
-- The customer lives on the raw mirror leg (xoro_gl_transactions.entity_full_name,
-- both spellings 'Shopify psychotuna' and 'Shopify psychotuna '); it is NOT on the
-- mirror JE lines, so PT-ecom transactions are identified by the set of Xoro
-- txn_ids whose customer is Shopify psychotuna, matched to the mirror JEs via
-- journal_entries.source_id = txn_id (each mirror JE = one Xoro txn).
--
-- WHAT THIS DOES — two balanced channel_reclass JEs per calendar month:
--   REVENUE:  DR 4009 Sales Revenue - PT      / CR 4008 Sales Revenue - PT Ecom
--   COGS:     DR 5013 Cost of Goods Sold PT Ecom / CR 5012 Cost of Goods Sold PT
-- Revenue-internal AND COGS-internal, each net-zero: Net Sales, total COGS and
-- Gross Profit are UNCHANGED for every period; only the PT wholesale-vs-ecom split
-- changes. Measured lifetime: revenue $190,772.06 (4009->4008),
-- COGS $62,105.09 (5012->5013) — a ~67% PT-ecom gross margin.
--
-- Mechanism / dating / idempotency: identical to #1725/#1727.
-- gl_post_journal_entry() (T11-audited path). Each monthly JE dated to the MAX
-- posting_date of the PT-ecom activity it corrects. Guarded by
-- (source_table='channel_reclass', source_id per month per stream); amount
-- recomputed live from the ORIGINAL mirror lines each run, so applying it
-- operationally now AND again on db-push merge is a safe no-op after the first.
-- Entity-scoped to rof_entity_id(). Touches ONLY 4008/4009 and 5012/5013.
-- ════════════════════════════════════════════════════════════════════════════
DO $mig$
DECLARE
  v_rof   uuid := rof_entity_id();
  v_4008  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '4008');
  v_4009  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '4009');
  v_5012  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '5012');
  v_5013  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '5013');
  r       record;
  v_key   text;
  v_je    uuid;
BEGIN
  IF v_4008 IS NULL OR v_4009 IS NULL OR v_5012 IS NULL OR v_5013 IS NULL THEN
    RAISE EXCEPTION 'PT ecom reclass: an account is missing (4008=% 4009=% 5012=% 5013=%)',
      v_4008, v_4009, v_5012, v_5013;
  END IF;

  -- ── Stream 1: REVENUE 4009 -> 4008 ──────────────────────────────────────────
  -- PT ecom txns = mirror JEs whose Xoro txn carries the "Shopify psychotuna"
  -- customer (xoro_gl_transactions.entity_full_name); linked via source_id=txn_id.
  FOR r IN
    WITH ecom AS (
      SELECT je.posting_date AS pd, (l.credit - l.debit) AS net
      FROM journal_entry_lines l
      JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE l.account_id = v_4009
        AND je.journal_type = 'xoro_gl_mirror'
        AND je.source_id IN (SELECT DISTINCT txn_id::text FROM xoro_gl_transactions
                              WHERE entity_full_name ILIKE '%shopify psychotuna%')
    )
    SELECT to_char(date_trunc('month', pd), 'YYYY-MM') AS ym,
           round(sum(net), 2) AS net_amt, max(pd) AS post_date
    FROM ecom GROUP BY 1 HAVING round(sum(net), 2) <> 0 ORDER BY 1
  LOOP
    v_key := 'channel_reclass:pt_ecom_rev:4009->4008:' || r.ym;
    IF EXISTS (SELECT 1 FROM journal_entries
                WHERE entity_id = v_rof AND source_table = 'channel_reclass' AND source_id = v_key) THEN
      CONTINUE;
    END IF;
    v_je := gl_post_journal_entry(jsonb_build_object(
      'entity_id', v_rof, 'basis', 'ACCRUAL', 'journal_type', 'channel_reclass',
      'posting_date', r.post_date, 'source_module', 'gl_channel_reclass',
      'source_table', 'channel_reclass', 'source_id', v_key,
      'description', 'Channel reclass ' || r.ym ||
                     ' - PT Ecom sales 4009->4008 (' || to_char(r.net_amt, 'FM999999999.00') || ')',
      'audit_reason', 'PT Ecom revenue reclass (CEO 2026-07-13): move Psycho Tuna ecom sales '
                     || '(customer "Shopify psychotuna") from 4009 Sales Revenue - PT to 4008 '
                     || 'Sales Revenue - PT Ecom for ' || r.ym || '. Revenue-internal, net-zero.',
      'audit_source', 'migration',
      'lines', jsonb_build_array(
        jsonb_build_object('line_number',1,'account_id',v_4009,'debit',r.net_amt,'credit',0,
          'memo','Reclass PT Ecom sales OUT of 4009 Sales Revenue - PT (' || r.ym || ')'),
        jsonb_build_object('line_number',2,'account_id',v_4008,'debit',0,'credit',r.net_amt,
          'memo','Reclass PT Ecom sales INTO 4008 Sales Revenue - PT Ecom (' || r.ym || ')')
      )));
    RAISE NOTICE 'PT ecom REV % : % (je %)', r.ym, r.net_amt, v_je;
  END LOOP;

  -- ── Stream 2: COGS 5012 -> 5013 ─────────────────────────────────────────────
  FOR r IN
    WITH ecom AS (
      SELECT je.posting_date AS pd, (l.debit - l.credit) AS net
      FROM journal_entry_lines l
      JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE l.account_id = v_5012
        AND je.journal_type = 'xoro_gl_mirror'
        AND je.source_id IN (SELECT DISTINCT txn_id::text FROM xoro_gl_transactions
                              WHERE entity_full_name ILIKE '%shopify psychotuna%')
    )
    SELECT to_char(date_trunc('month', pd), 'YYYY-MM') AS ym,
           round(sum(net), 2) AS net_amt, max(pd) AS post_date
    FROM ecom GROUP BY 1 HAVING round(sum(net), 2) <> 0 ORDER BY 1
  LOOP
    v_key := 'channel_reclass:pt_ecom_cogs:5012->5013:' || r.ym;
    IF EXISTS (SELECT 1 FROM journal_entries
                WHERE entity_id = v_rof AND source_table = 'channel_reclass' AND source_id = v_key) THEN
      CONTINUE;
    END IF;
    v_je := gl_post_journal_entry(jsonb_build_object(
      'entity_id', v_rof, 'basis', 'ACCRUAL', 'journal_type', 'channel_reclass',
      'posting_date', r.post_date, 'source_module', 'gl_channel_reclass',
      'source_table', 'channel_reclass', 'source_id', v_key,
      'description', 'Channel COGS reclass ' || r.ym ||
                     ' - PT Ecom COGS 5012->5013 (' || to_char(r.net_amt, 'FM999999999.00') || ')',
      'audit_reason', 'PT Ecom COGS reclass (CEO 2026-07-13): move Psycho Tuna ecom COGS '
                     || '(customer "Shopify psychotuna") from 5012 Cost of Goods Sold PT to 5013 '
                     || 'Cost of Goods Sold PT Ecom for ' || r.ym || '. COGS-internal, net-zero.',
      'audit_source', 'migration',
      'lines', jsonb_build_array(
        jsonb_build_object('line_number',1,'account_id',v_5013,'debit',r.net_amt,'credit',0,
          'memo','Reclass PT Ecom COGS INTO 5013 Cost of Goods Sold PT Ecom (' || r.ym || ')'),
        jsonb_build_object('line_number',2,'account_id',v_5012,'debit',0,'credit',r.net_amt,
          'memo','Reclass PT Ecom COGS OUT of 5012 Cost of Goods Sold PT (' || r.ym || ')')
      )));
    RAISE NOTICE 'PT ecom COGS % : % (je %)', r.ym, r.net_amt, v_je;
  END LOOP;
END
$mig$;

NOTIFY pgrst, 'reload schema';
