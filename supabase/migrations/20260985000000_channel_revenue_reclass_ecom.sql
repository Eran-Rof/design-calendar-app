-- ════════════════════════════════════════════════════════════════════════════
-- Channel revenue reclass — ROF Ecom sales off 4005 "Sales Revenue ROF Brands"
-- onto 4011 "Sales Revenue - ROF Ecom"  (#1725, 2026-07-13, CEO-directed)
--
-- CEO: "sales revenue ecom should be on the sales revenue ecom account not the
-- rof brands income account."
--
-- CONTEXT — first INTENTIONAL divergence from the pure Xoro GL mirror.
-- Tangerine's GL is a 1:1 mirror of Xoro (journal_type='xoro_gl_mirror'). Xoro
-- commingles ROF wholesale + ROF ecom revenue into ONE account ("Sales Revenue
-- ROF Brands" -> ROF 4005); Xoro's dedicated website-revenue account is $0, so
-- ROF 4011 "Sales Revenue - ROF Ecom" was empty. ROF's chart has distinct
-- channel accounts. The channel is deterministic from the INVOICE-NUMBER prefix
-- embedded in each mirror JE's description ("Xoro GL mirror - Invoice
-- ROF ECOM-I##### (date)"): 'ROF ECOM-I…' = ROF ecom. (ar_invoices.channel_id
-- is NOT usable — 100% of mirrored invoices default to "Wholesale / EDI".)
--
-- WHAT THIS DOES — one balanced channel_reclass JE per calendar month that has
-- ROF-ECOM-prefixed revenue currently sitting on 4005:
--     DR 4005 Sales Revenue ROF Brands   (net ecom credit for the month)
--     CR 4011 Sales Revenue - ROF Ecom   (same amount)
-- Revenue-INTERNAL and net-zero: total revenue / Net Sales is UNCHANGED for
-- every period; only the split between 4005 and 4011 changes. After this,
-- 4005/4011 INTENTIONALLY differ from Xoro's lump while Net Sales ties.
--
-- Mechanism: gl_post_journal_entry() RPC — the T11-audited posting path (sets
-- app.audit_reason, fires all guard triggers: balance, period-open, hard-lock,
-- account active/postable). Chosen over mutating the mirror lines so the pure
-- Xoro provenance is preserved and the correction is layered visibly/reversibly.
--
-- Source-dating (NON-NEG): each monthly JE is dated to the MAX posting_date of
-- the ecom activity it corrects (a real Xoro txn date inside that period), never
-- import/today.
--
-- IDEMPOTENT: guarded by (source_table='channel_reclass', source_id per month);
-- the amount is recomputed live from the ORIGINAL mirror lines (identified by
-- invoice-number prefix, which the reclass JEs do NOT carry), so applying this
-- operationally now AND again on db-push merge is a safe no-op after the first.
-- Entity-scoped to rof_entity_id(). Touches ONLY 4005 and 4011.
-- ════════════════════════════════════════════════════════════════════════════
DO $mig$
DECLARE
  v_rof   uuid := rof_entity_id();
  v_4005  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '4005');
  v_4011  uuid := (SELECT id FROM gl_accounts WHERE entity_id = rof_entity_id() AND code = '4011');
  r       record;
  v_key   text;
  v_je    uuid;
BEGIN
  IF v_4005 IS NULL OR v_4011 IS NULL THEN
    RAISE EXCEPTION 'channel reclass: account 4005 (%) or 4011 (%) not found for entity', v_4005, v_4011;
  END IF;

  FOR r IN
    WITH ecom AS (
      SELECT je.posting_date AS pd, (l.credit - l.debit) AS net
      FROM journal_entry_lines l
      JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE l.account_id = v_4005
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
    v_key := 'channel_reclass:rof_ecom:4005->4011:' || r.ym;

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
      'description',   'Channel reclass ' || r.ym ||
                       ' - ROF Ecom sales 4005->4011 (' || to_char(r.net_amt, 'FM999999999.00') || ')',
      'audit_reason',  'Channel revenue reclass (CEO 2026-07-13): move ROF Ecom sales '
                       || '(ROF ECOM-prefixed invoices) mis-mirrored onto 4005 Sales Revenue ROF '
                       || 'Brands to 4011 Sales Revenue - ROF Ecom for ' || r.ym
                       || '. Revenue-internal, net-zero: Net Sales unchanged.',
      'audit_source',  'migration',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'line_number', 1, 'account_id', v_4005,
          'debit',  r.net_amt, 'credit', 0,
          'memo', 'Reclass ROF Ecom sales OUT of 4005 Sales Revenue ROF Brands (' || r.ym || ')'
        ),
        jsonb_build_object(
          'line_number', 2, 'account_id', v_4011,
          'debit',  0, 'credit', r.net_amt,
          'memo', 'Reclass ROF Ecom sales INTO 4011 Sales Revenue - ROF Ecom (' || r.ym || ')'
        )
      )
    ));

    RAISE NOTICE 'channel reclass % : % (je %)', r.ym, r.net_amt, v_je;
  END LOOP;
END
$mig$;

NOTIFY pgrst, 'reload schema';
