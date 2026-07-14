-- ════════════════════════════════════════════════════════════════════════════
-- #1744 Chargeback Management — RECORDING-grade → MANAGEMENT-grade
-- (2026-07-14, CEO-approved; top-5 audit gap)
--
-- factor_chargebacks was an import-only ledger (5,928 rows, ~-$623k net, 100%
-- status='new', item_num free text, NO link to the originating AR invoice, no
-- disposition workflow, no dilution metrics). This migration promotes it to a
-- managed worklist:
--
--   1. chargeback_reason_codes — a governed deduction-type master (the raw
--      Rosenthal `reason`/`reason_code` strings stay untouched as raw data;
--      reason_code_id is the NEW governed classification).
--   2. factor_chargebacks gains: matched_ar_invoice_id (+ match_method),
--      a disposition workflow (open/valid/disputed/recovered/written_off) with
--      reason + owner + timestamp, and reason_code_id.
--   3. Deterministic auto-match of item_num → ar_invoices.invoice_number.
--      HOUSE RULE: exact normalized equality ONLY. A token that resolves to 2+
--      invoices is left UNMATCHED — a wrong link is worse than no link.
--      Two disjoint, unambiguous methods (verified on prod, 0 conflicts):
--        • invoice_number_exact  — alnum-normalized full string equality
--          (handles prefixed item_num like 'ROF-I141259', 'ROFI145992').
--        • invoice_number_suffix — zero-padded numeric item_num (e.g.
--          '00000010360') == the invoice's trailing digit-run stripped of
--          leading zeros, WHERE that suffix maps to exactly one invoice.
--          (ROF/ROF-ECOM/PT share one global Xoro invoice sequence, so the
--          numeric suffix is globally unique — verified: 0 ambiguous.)
--      Manual matches (match_method='manual') are never clobbered.
--   4. Reason-code normalization of the ~3% populated raw reasons onto the
--      master where the mapping is exact/obvious (rest stay uncoded; category
--      'unknown' is NOT auto-assigned).
--
-- Idempotent throughout (IF NOT EXISTS + change-guarded UPDATEs): applied
-- operationally first, and a safe no-op on db-push merge. Everything is
-- entity-scoped to rof_entity_id().
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Governed reason-code master ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chargeback_reason_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  label      text NOT NULL,
  category   text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE chargeback_reason_codes IS
  'Governed deduction-type master for chargeback classification (#1744). Distinct from the raw Rosenthal reason strings on factor_chargebacks.';

INSERT INTO chargeback_reason_codes (code, label, category, sort) VALUES
  ('shortage',   'Shortage / Non-Receipt',              'shortage',    10),
  ('pricing',    'Pricing / Allowance',                 'pricing',     20),
  ('shortpay',   'Short Pay (Invoice/Check Difference)','pricing',     30),
  ('discount',   'Unearned Discount Taken',             'pricing',     40),
  ('markdown',   'Markdown / Margin Allowance',         'markdown',    50),
  ('compliance', 'Compliance / Vendor Violation',       'compliance',  60),
  ('packing',    'Packing / Carton Violation',          'compliance',  70),
  ('freight',    'Freight / Routing',                   'freight',     80),
  ('coop',       'Advertising / Co-op',                 'advertising', 90),
  ('defective',  'Defective / Return-to-Vendor',        'defective',  100),
  ('returns',    'Return / Refused Merchandise',        'returns',    110),
  ('fees',       'Interest / Processing Fees',          'fees',       120),
  ('misc',       'Miscellaneous',                       'other',      130),
  ('unknown',    'Unknown / No Reason Given',           'unknown',    140)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label, category = EXCLUDED.category, sort = EXCLUDED.sort;

-- ── 2. Management columns on factor_chargebacks ─────────────────────────────
ALTER TABLE factor_chargebacks
  ADD COLUMN IF NOT EXISTS matched_ar_invoice_id uuid REFERENCES ar_invoices(id),
  ADD COLUMN IF NOT EXISTS match_method          text,
  ADD COLUMN IF NOT EXISTS disposition           text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS disposition_reason    text,
  ADD COLUMN IF NOT EXISTS owner                 text,
  ADD COLUMN IF NOT EXISTS disposition_at        timestamptz,
  ADD COLUMN IF NOT EXISTS reason_code_id        uuid REFERENCES chargeback_reason_codes(id);

-- disposition CHECK (idempotent add)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'factor_chargebacks_disposition_chk'
  ) THEN
    ALTER TABLE factor_chargebacks
      ADD CONSTRAINT factor_chargebacks_disposition_chk
      CHECK (disposition IN ('open','valid','disputed','recovered','written_off'));
  END IF;
END $$;

COMMENT ON COLUMN factor_chargebacks.reason_code_id IS
  'Governed classification (chargeback_reason_codes). NULL = un-coded. The raw reason/reason_code columns are preserved as-is.';
COMMENT ON COLUMN factor_chargebacks.match_method IS
  'How matched_ar_invoice_id was set: invoice_number_exact | invoice_number_suffix | manual. NULL = unmatched.';
COMMENT ON COLUMN factor_chargebacks.disposition IS
  'Management workflow state: open | valid | disputed | recovered | written_off.';

-- ── 3. Worklist indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fc_disposition        ON factor_chargebacks (disposition);
CREATE INDEX IF NOT EXISTS idx_fc_matched_invoice    ON factor_chargebacks (matched_ar_invoice_id);
CREATE INDEX IF NOT EXISTS idx_fc_reason_code        ON factor_chargebacks (reason_code_id);
CREATE INDEX IF NOT EXISTS idx_fc_customer_month     ON factor_chargebacks (customer_id, report_month);
CREATE INDEX IF NOT EXISTS idx_fc_match_method       ON factor_chargebacks (match_method);

-- ── 4. Deterministic auto-match (idempotent; recomputes live each run) ──────
--   Only sets a match when the normalized token maps to exactly one invoice.
--   Never touches manually-corrected matches (match_method='manual').
WITH inv_norm AS (
  SELECT id,
         nullif(regexp_replace(regexp_replace(invoice_number, '^.*[^0-9]', ''), '^0+', ''), '') AS suffix,
         upper(regexp_replace(invoice_number, '[^a-zA-Z0-9]', '', 'g'))                          AS alnum
  FROM ar_invoices
  WHERE entity_id = rof_entity_id()
),
suffix_u AS (  -- suffix → the single invoice it maps to (drop ambiguous)
  SELECT suffix, (array_agg(id))[1] AS inv_id FROM inv_norm
  WHERE suffix IS NOT NULL GROUP BY suffix HAVING count(*) = 1
),
alnum_u AS (   -- alnum full string → single invoice
  SELECT alnum, (array_agg(id))[1] AS inv_id FROM inv_norm
  WHERE alnum <> '' GROUP BY alnum HAVING count(*) = 1
),
cb AS (
  SELECT id,
         (item_num ~ '^[0-9]+$')                                     AS is_numeric,
         nullif(ltrim(item_num, '0'), '')                           AS item_suffix,
         upper(regexp_replace(item_num, '[^a-zA-Z0-9]', '', 'g'))   AS item_alnum
  FROM factor_chargebacks
  WHERE entity_id = rof_entity_id()
),
resolved AS (
  SELECT cb.id AS cb_id,
         COALESCE(au.inv_id, su.inv_id) AS inv_id,
         CASE WHEN au.inv_id IS NOT NULL THEN 'invoice_number_exact'
              ELSE 'invoice_number_suffix' END AS method
  FROM cb
  LEFT JOIN alnum_u  au ON au.alnum  = cb.item_alnum
  LEFT JOIN suffix_u su ON cb.is_numeric AND su.suffix = cb.item_suffix
  WHERE COALESCE(au.inv_id, su.inv_id) IS NOT NULL
)
UPDATE factor_chargebacks fc
   SET matched_ar_invoice_id = r.inv_id,
       match_method          = r.method
  FROM resolved r
 WHERE fc.id = r.cb_id
   AND (fc.match_method IS NULL OR fc.match_method LIKE 'invoice_number%')  -- never clobber manual
   AND (fc.matched_ar_invoice_id IS DISTINCT FROM r.inv_id
        OR fc.match_method IS DISTINCT FROM r.method);

-- ── 5. Reason-code normalization (exact/obvious raw → governed only) ─────────
UPDATE factor_chargebacks fc
   SET reason_code_id = rc.id
  FROM (VALUES
    ('Short Pay (Inv/Ck Difference)',      'shortpay'),
    ('Discount taken - (chargeback)',      'discount'),
    ('Packing Violation',                  'packing'),
    ('Freight',                            'freight'),
    ('Warehouse Allowance',                'pricing'),
    ('Processing Charge',                  'fees'),
    ('Return/refused',                     'returns'),
    ('No Reason Given',                    'unknown'),
    ('Miscellaneous',                      'misc'),
    ('Miscellaneous credit / chargeback',  'misc')
  ) AS map(raw, code)
  JOIN chargeback_reason_codes rc ON rc.code = map.code
 WHERE fc.reason = map.raw
   AND fc.reason_code_id IS DISTINCT FROM rc.id;

-- ── 6. Gross-sales denominator view (dilution %) ────────────────────────────
--   Gross AR sales per customer per calendar month (invoice_date). The
--   dilution endpoint uses this as the % denominator; chargeback aggregation
--   itself is done in JS via api/_lib/chargebackMatch.js (aggregateDilution).
CREATE OR REPLACE VIEW v_chargeback_gross_sales AS
  SELECT customer_id,
         to_char(invoice_date, 'YYYY-MM') AS ym,
         sum(total_amount_cents)          AS gross_sales_cents
  FROM ar_invoices
  WHERE entity_id = rof_entity_id() AND customer_id IS NOT NULL AND invoice_date IS NOT NULL
  GROUP BY customer_id, to_char(invoice_date, 'YYYY-MM');

COMMENT ON VIEW v_chargeback_gross_sales IS
  'Gross AR sales per customer per month — dilution % denominator for the Chargeback Management module (#1744).';

NOTIFY pgrst, 'reload schema';
