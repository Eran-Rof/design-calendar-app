-- ════════════════════════════════════════════════════════════════════════════
-- Customer analytics — mirrored-history fixes (Sales by Customer + Scorecard)
-- ════════════════════════════════════════════════════════════════════════════
-- Three defects reported by the operator, all rooted in how the Xoro/Excel
-- mirror lands historical AR into Tangerine:
--
--   A. "Sales by Customer is blank."
--      v_sales_by_customer / sales_by_customer() filtered invoice_kind to
--      ('customer_invoice','customer_credit_memo') only. The 28,328 mirrored
--      historical invoices carry invoice_kind='customer_invoice_historical'
--      (with gl_status='posted_historical'), so EVERY historical row was
--      excluded → the report returned zero rows. Fix: treat the *_historical
--      kinds as their live counterparts in both the view CASE and the WHERE.
--
--   B/C. Customer Scorecard blank for some customers + the customer picker
--      showing all-caps machine names. Root cause: the customer import created
--      duplicate rows for a handful of accounts — one ALL-CAPS machine-named row
--      (e.g. "AMAZON FBM", customer_code EXCEL:AMAZONFBM) that the AR mirror
--      attached the invoices to, and one proper-cased native row (e.g.
--      "Amazon FBM", CUST-00008) that carries the sales orders. Opening the
--      scorecard for the proper customer showed no mirrored AR (it lived on the
--      duplicate). Fix: merge each ALL-CAPS duplicate into its proper-cased
--      sibling — repoint every FK that references customers(id), then soft-delete
--      the duplicate so it drops out of pickers.
--
-- Idempotent + additive: the view/function use CREATE OR REPLACE; the merge only
-- acts on rows that still match the duplicate pattern (already-merged rows have
-- deleted_at set and are skipped).

-- ────────────────────────────────────────────────────────────────────────────
-- A. Sales by Customer — include mirrored historical invoice kinds
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_sales_by_customer AS
SELECT
  inv.entity_id,
  inv.customer_id,
  inv.invoice_date,
  inv.id AS ar_invoice_id,
  inv.invoice_kind,
  inv.total_amount_cents,
  CASE WHEN inv.invoice_kind IN ('customer_invoice','customer_invoice_historical')
       THEN inv.total_amount_cents ELSE 0 END AS gross_cents,
  CASE WHEN inv.invoice_kind IN ('customer_credit_memo','customer_credit_memo_historical')
       THEN inv.total_amount_cents ELSE 0 END AS credit_memo_cents
FROM ar_invoices inv
WHERE inv.gl_status IN ('sent','partial_paid','paid','posted','posted_historical')
  AND inv.invoice_kind IN (
        'customer_invoice','customer_credit_memo',
        'customer_invoice_historical','customer_credit_memo_historical'
      );

COMMENT ON VIEW v_sales_by_customer IS
  'Tangerine P7-7: per-customer per-invoice rows for the Sales by Customer × Period report. Separates gross_cents (invoices) from credit_memo_cents so net is gross - credit_memos. Includes mirrored *_historical invoice kinds (posted_historical) so the report reflects the full Xoro/Excel AR history.';

CREATE OR REPLACE FUNCTION sales_by_customer(p_entity_id uuid, p_from date, p_to date)
RETURNS TABLE (
  customer_id        uuid,
  customer_name      text,
  customer_code      text,
  invoice_count      bigint,
  gross_cents        bigint,
  credit_memo_cents  bigint,
  net_cents          bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id                                                        AS customer_id,
    c.name                                                      AS customer_name,
    c.code                                                      AS customer_code,
    COUNT(DISTINCT CASE WHEN v.invoice_kind IN ('customer_invoice','customer_invoice_historical')
                        THEN v.ar_invoice_id END)::bigint       AS invoice_count,
    COALESCE(SUM(v.gross_cents), 0)::bigint                     AS gross_cents,
    COALESCE(SUM(v.credit_memo_cents), 0)::bigint               AS credit_memo_cents,
    (COALESCE(SUM(v.gross_cents), 0) - COALESCE(SUM(v.credit_memo_cents), 0))::bigint AS net_cents
  FROM customers c
  JOIN v_sales_by_customer v
       ON v.customer_id = c.id
      AND v.entity_id = p_entity_id
      AND v.invoice_date BETWEEN p_from AND p_to
  GROUP BY c.id, c.name, c.code
  HAVING COALESCE(SUM(v.gross_cents), 0) + COALESCE(SUM(v.credit_memo_cents), 0) > 0;
$$;

COMMENT ON FUNCTION sales_by_customer(uuid, date, date) IS
  'Tangerine P7-7: per-customer totals across a date window. Drops customers with zero activity (HAVING). Counts mirrored *_historical invoice kinds. net = gross - credit_memos.';

-- ────────────────────────────────────────────────────────────────────────────
-- B/C. Merge ALL-CAPS mirror-duplicate customers into their proper sibling
-- ────────────────────────────────────────────────────────────────────────────
-- A "duplicate" = an active row whose name is fully upper-case (a machine mirror
-- name) that has a distinct, proper-cased sibling in the same entity with the
-- same space-insensitive, case-insensitive name. The proper-cased row is the
-- keeper. We repoint every FK column that references customers(id) from the
-- duplicate to the keeper, then soft-delete the duplicate.
DO $$
DECLARE
  pair   RECORD;
  fk     RECORD;
  moved  bigint;
BEGIN
  FOR pair IN
    WITH allcaps AS (
      SELECT c.id, c.name, c.entity_id,
             lower(regexp_replace(c.name, '\s', '', 'g')) AS nn
      FROM customers c
      WHERE c.deleted_at IS NULL
        AND c.name = upper(c.name)
        AND c.name ~ '[A-Z]'
    )
    SELECT a.id AS dupe_id, a.name AS dupe_name,
           k.id AS keeper_id, k.name AS keeper_name
    FROM allcaps a
    JOIN LATERAL (
      SELECT k.id, k.name
      FROM customers k
      WHERE k.deleted_at IS NULL
        AND k.entity_id = a.entity_id
        AND k.id <> a.id
        AND lower(regexp_replace(k.name, '\s', '', 'g')) = a.nn
        AND k.name <> upper(k.name)          -- proper-cased sibling only
      -- Deterministic keeper: prefer a row that already owns a CUST-NNNNN code.
      ORDER BY (k.code ~ '^CUST-') DESC, k.created_at ASC
      LIMIT 1
    ) k ON true
  LOOP
    RAISE NOTICE 'Merging duplicate customer % (%) -> keeper % (%)',
      pair.dupe_name, pair.dupe_id, pair.keeper_name, pair.keeper_id;

    -- Repoint every FK column that references customers(id).
    FOR fk IN
      SELECT tc.table_schema, tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'customers'
        AND ccu.column_name = 'id'
        -- Skip the self-referential parent pointer: handled explicitly below so we
        -- never create a cycle or point a child at the tombstoned duplicate.
        AND NOT (tc.table_name = 'customers' AND kcu.column_name = 'parent_customer_id')
    LOOP
      BEGIN
        EXECUTE format(
          'UPDATE %I.%I SET %I = $1 WHERE %I = $2',
          fk.table_schema, fk.table_name, fk.column_name, fk.column_name
        ) USING pair.keeper_id, pair.dupe_id;
        GET DIAGNOSTICS moved = ROW_COUNT;
        IF moved > 0 THEN
          RAISE NOTICE '  repointed % row(s) in %.%(%)',
            moved, fk.table_schema, fk.table_name, fk.column_name;
        END IF;
      EXCEPTION WHEN unique_violation THEN
        -- A conflicting keeper row already exists for a per-customer-unique table;
        -- leave the duplicate's row in place rather than fail the whole merge.
        RAISE NOTICE '  SKIPPED %.%(%) — unique conflict on repoint',
          fk.table_schema, fk.table_name, fk.column_name;
      END;
    END LOOP;

    -- Re-parent any customer that pointed at the duplicate.
    UPDATE customers SET parent_customer_id = pair.keeper_id
    WHERE parent_customer_id = pair.dupe_id;

    -- Soft-delete the duplicate so it disappears from pickers/search.
    UPDATE customers
    SET deleted_at = now(),
        status = 'inactive',
        updated_at = now()
    WHERE id = pair.dupe_id AND deleted_at IS NULL;
  END LOOP;
END $$;
