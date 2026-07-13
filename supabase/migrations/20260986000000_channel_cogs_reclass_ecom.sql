-- ════════════════════════════════════════════════════════════════════════════
-- Channel COGS reclass — ROF Ecom COGS off 5010 "Cost of Goods Sold ROF Brands"
-- onto 5014 "Cost of Goods Sold ROF Ecom"  (#1727, 2026-07-13, CEO-directed)
--
-- CEO (2026-07-13): "move cogs to correct account for ecom." The companion to the
-- revenue reclass #1725 (4005->4011). Without it, ecom revenue sat on 4011 while
-- its cost stayed on 5010, so the ROF Ecom line showed a ~100% (fake) gross
-- margin and ROF wholesale carried ecom's cost. This puts ecom cost on ecom COGS
-- so each channel shows a TRUE gross profit; total COGS / Gross Profit UNCHANGED.
--
-- CONTEXT — second INTENTIONAL divergence from the pure Xoro GL mirror. Xoro
-- commingles ROF wholesale + ROF ecom COGS into ONE account ("Cost of Goods Sold
-- ROF Brands" -> ROF 5010); Xoro's dedicated ecom-COGS account is $0, so ROF 5014
-- was empty. Channel is deterministic from the INVOICE-NUMBER prefix embedded in
-- each mirror JE's description ("Xoro GL mirror - Invoice ROF ECOM-I##### (date)"):
-- 'ROF ECOM-I…' = ROF ecom. IDENTICAL basis to the #1725 revenue reclass, so
-- ecom revenue and ecom cost move on the same invoice population and the ecom
-- gross margin is internally consistent. Measured ROF-ECOM COGS on 5010 =
-- $193,033.72 (26,690 mirror lines).
--
-- NOTE — Psycho Tuna: Xoro records NO PT ecom sales or COGS. All PT activity is
-- wholesale (4009 / "Cost of Goods Sold PT", store "Psycho Tuna"); the
-- "Psycho Tuna Ecom" store carries only ecom OPERATING expenses (Shopify fees,
-- Meta/Google ads, logistics). So PT 4008 / 5013 stay $0 by design — there is no
-- PT-ecom-tagged sales/COGS population to reclass. (Flagged to CEO as a Xoro-side
-- data-flow question, not a GL misposting.) This migration touches ONLY ROF.
--
-- WHAT THIS DOES — one balanced channel_reclass JE per calendar month that has
-- ROF-ECOM-prefixed COGS currently sitting on 5010:
--     DR 5014 Cost of Goods Sold ROF Ecom   (net ecom debit for the month)
--     CR 5010 Cost of Goods Sold ROF Brands (same amount)
-- COGS-INTERNAL and net-zero: total COGS / Gross Profit UNCHANGED for every
-- period; only the split between 5010 and 5014 changes.
--
-- Mechanism / dating / idempotency: identical to #1725. gl_post_journal_entry()
-- (T11-audited path, all guard triggers). Each monthly JE dated to the MAX
-- posting_date of the ecom COGS it corrects (a real Xoro txn date in-period).
-- Guarded by (source_table='channel_reclass', source_id per month); amount
-- recomputed live from the ORIGINAL mirror lines each run, so applying it
-- operationally now AND again on db-push merge is a safe no-op after the first.
-- Entity-scoped to rof_entity_id(). Touches ONLY 5010 and 5014.
-- ════════════════════════════════════════════════════════════════════════════
DO $mig$
DECLARE
  v_rof   uuid := rof_entity_id();
  v_5010  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '5010');
  v_5014  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '5014');
  r       record;
  v_key   text;
  v_je    uuid;
BEGIN
  IF v_5010 IS NULL OR v_5014 IS NULL THEN
    RAISE EXCEPTION 'channel COGS reclass: account 5010 (%) or 5014 (%) not found for entity', v_5010, v_5014;
  END IF;

  FOR r IN
    WITH ecom AS (
      SELECT je.posting_date AS pd, (l.debit - l.credit) AS net
      FROM journal_entry_lines l
      JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE l.account_id = v_5010
        AND je.journal_type = 'xoro_gl_mirror'
        AND substring(je.description FROM 'Invoice (.*) \(') ILIKE 'ROF ECOM-%'
    )
    SELECT to_char(date_trunc('month', pd), 'YYYY-MM') AS ym,
           round(sum(net), 2) AS net_amt,
           max(pd)            AS post_date
    FROM ecom
    GROUP BY 1
    HAVING round(sum(net), 2) <> 0
    ORDER BY 1
  LOOP
    v_key := 'channel_reclass:rof_ecom_cogs:5010->5014:' || r.ym;

    -- idempotency: skip months already reclassed
    IF EXISTS (SELECT 1 FROM journal_entries
                WHERE entity_id = v_rof
                  AND source_table = 'channel_reclass'
                  AND source_id = v_key) THEN
      CONTINUE;
    END IF;

    v_je := gl_post_journal_entry(jsonb_build_object(
      'entity_id',     v_rof,
      'basis',         'ACCRUAL',
      'journal_type',  'channel_reclass',
      'posting_date',  r.post_date,
      'source_module', 'gl_channel_reclass',
      'source_table',  'channel_reclass',
      'source_id',     v_key,
      'description',   'Channel COGS reclass ' || r.ym ||
                       ' - ROF Ecom COGS 5010->5014 (' || to_char(r.net_amt, 'FM999999999.00') || ')',
      'audit_reason',  'Channel COGS reclass (CEO 2026-07-13): move ROF Ecom COGS '
                       || '(ROF ECOM-prefixed invoices) mis-mirrored onto 5010 Cost of Goods '
                       || 'Sold ROF Brands to 5014 Cost of Goods Sold ROF Ecom for ' || r.ym
                       || '. COGS-internal, net-zero: total COGS / Gross Profit unchanged.',
      'audit_source',  'migration',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'line_number', 1, 'account_id', v_5014,
          'debit',  r.net_amt, 'credit', 0,
          'memo', 'Reclass ROF Ecom COGS INTO 5014 Cost of Goods Sold ROF Ecom (' || r.ym || ')'
        ),
        jsonb_build_object(
          'line_number', 2, 'account_id', v_5010,
          'debit',  0, 'credit', r.net_amt,
          'memo', 'Reclass ROF Ecom COGS OUT of 5010 Cost of Goods Sold ROF Brands (' || r.ym || ')'
        )
      )
    ));

    RAISE NOTICE 'channel COGS reclass % : % (je %)', r.ym, r.net_amt, v_je;
  END LOOP;
END
$mig$;

NOTIFY pgrst, 'reload schema';
