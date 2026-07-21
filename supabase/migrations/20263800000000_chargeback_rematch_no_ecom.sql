-- Chargeback auto-match: exclude ECOM (D2C) invoices from the candidate pool.
--
-- Defect (CEO-caught): Macys internal doc "150100" / "00000150100"
-- (+/-$37,909.60 offset pair) suffix-matched invoice "ROF ECOM-I150100", a
-- $28.25 Shopify D2C invoice. Rosenthal only factors WHOLESALE AR - a factor
-- chargeback can never legitimately reference an ECOM invoice, so D2C invoices
-- do not belong in the match pool at all. Exactly 2 rows were affected
-- (verified: the 150100 pair; every other high-ratio match is a genuine
-- reference where the item_num IS the invoice's numeric core).
--
-- This migration promotes the one-shot matcher block from
-- 20260988000000_chargeback_management.sql into a reusable, self-healing
-- function (chargeback_rematch) with the ECOM exclusion, and runs it once.
-- The function:
--   1. UNLINKS any existing auto-match that points at an ECOM invoice
--      (match_method LIKE 'invoice_number%' only - manual links untouched).
--   2. Recomputes deterministic matches over the non-ECOM pool (exact
--      normalized equality only; ambiguous tokens stay unmatched; manual
--      matches never clobbered) - same rules as #1744 otherwise.
-- Idempotent: re-running converges to the same state.

CREATE OR REPLACE FUNCTION chargeback_rematch()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_unlinked int;
  v_matched  int;
BEGIN
  -- 1. Self-heal: drop auto-matches that point at D2C/ECOM invoices.
  WITH bad AS (
    UPDATE factor_chargebacks fc
       SET matched_ar_invoice_id = NULL,
           match_method          = NULL
      FROM ar_invoices ai
     WHERE ai.id = fc.matched_ar_invoice_id
       AND ai.invoice_number ~* 'ECOM'
       AND fc.match_method LIKE 'invoice_number%'
    RETURNING fc.id
  )
  SELECT count(*) INTO v_unlinked FROM bad;

  -- 2. Deterministic re-match over the wholesale-only pool.
  WITH inv_norm AS (
    SELECT id,
           nullif(regexp_replace(regexp_replace(invoice_number, '^.*[^0-9]', ''), '^0+', ''), '') AS suffix,
           upper(regexp_replace(invoice_number, '[^a-zA-Z0-9]', '', 'g'))                          AS alnum
    FROM ar_invoices
    WHERE entity_id = rof_entity_id()
      AND invoice_number !~* 'ECOM'   -- factor items never reference D2C invoices
  ),
  suffix_u AS (
    SELECT suffix, (array_agg(id))[1] AS inv_id FROM inv_norm
    WHERE suffix IS NOT NULL GROUP BY suffix HAVING count(*) = 1
  ),
  alnum_u AS (
    SELECT alnum, (array_agg(id))[1] AS inv_id FROM inv_norm
    WHERE alnum <> '' GROUP BY alnum HAVING count(*) = 1
  ),
  cb AS (
    SELECT id,
           (item_num ~ '^[0-9]+$')                                    AS is_numeric,
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
  ),
  upd AS (
    UPDATE factor_chargebacks fc
       SET matched_ar_invoice_id = r.inv_id,
           match_method          = r.method
      FROM resolved r
     WHERE fc.id = r.cb_id
       AND (fc.match_method IS NULL OR fc.match_method LIKE 'invoice_number%')  -- never clobber manual
       AND (fc.matched_ar_invoice_id IS DISTINCT FROM r.inv_id
            OR fc.match_method IS DISTINCT FROM r.method)
    RETURNING fc.id
  )
  SELECT count(*) INTO v_matched FROM upd;

  RETURN jsonb_build_object('unlinked_ecom', v_unlinked, 'rematched', v_matched);
END;
$$;

COMMENT ON FUNCTION chargeback_rematch() IS
  'Deterministic factor-chargeback auto-match (#1744 rules) over the wholesale-only invoice pool: unlinks auto-matches to ECOM/D2C invoices, then recomputes exact/suffix matches. Manual matches never touched. Idempotent.';

SELECT chargeback_rematch();
