-- ap_bills — Xoro AP bill mirror landing table.
--
-- Consumer side of the new Xoro AP read path. The producer (rest_ap_sync.py
-- in the sibling rof_xoro_project repo) walks Xoro's bill/getbill REST
-- endpoint and POSTs a gzipped CSV to /api/ap/sync-bills. The handler
-- parses the CSV and upserts here.
--
-- This is SEPARATE from the manual-entry AP UI at /api/internal/ap-invoices
-- (which writes to `invoices` with bill_type='ap'). That path is internal
-- Tangerine AP; this one mirrors Xoro vendor bills as a read source for
-- reporting + planning.
--
-- Pre-agreed CSV shape (see /api/ap/sync-bills handler — do not change without
-- coordinating with the producer):
--
--   Bill Number, Bill Date, Due Date, Vendor Code, Vendor Name, Currency,
--   Item Number, Description, Qty, Unit Price, Amount,
--   Bill Status, Payment Status
--
-- One row per bill line. Idempotency uses (source, source_line_key) — same
-- pattern as ip_sales_history_wholesale — keyed off bill_number, item_number,
-- and an in-CSV line_index so re-runs UPDATE existing rows instead of
-- duplicating.

CREATE TABLE IF NOT EXISTS ap_bills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                      REFERENCES entities(id) ON DELETE RESTRICT,
  source            text NOT NULL DEFAULT 'xoro'
                      CHECK (source IN ('xoro', 'manual')),
  bill_number       text NOT NULL,
  bill_date         date,
  due_date          date,
  vendor_code       text,
  vendor_name       text,
  currency          text DEFAULT 'USD',
  item_number       text,
  description       text,
  qty               numeric,
  unit_price        numeric,
  amount            numeric,
  bill_status       text,
  payment_status    text,
  source_line_key   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Uniqueness for upsert idempotency. Mirrors the (source, source_line_key)
-- pattern on ip_sales_history_wholesale so the handler can `.upsert(...,
-- { onConflict: "source,source_line_key" })` and re-runs collapse onto the
-- same row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ap_bills_source_source_line_key_key'
  ) THEN
    ALTER TABLE ap_bills
      ADD CONSTRAINT ap_bills_source_source_line_key_key
      UNIQUE (source, source_line_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ap_bills_bill_date         ON ap_bills (bill_date);
CREATE INDEX IF NOT EXISTS idx_ap_bills_vendor_bill_date  ON ap_bills (vendor_code, bill_date DESC);
CREATE INDEX IF NOT EXISTS idx_ap_bills_payment_status    ON ap_bills (payment_status);

ALTER TABLE ap_bills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all_ap_bills ON ap_bills;
CREATE POLICY anon_all_ap_bills ON ap_bills FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE ap_bills IS 'Xoro AP bill mirror — landing table for /api/ap/sync-bills. One row per CSV bill line. Separate from invoices/manual-entry AP. Idempotent on (source, source_line_key).';

NOTIFY pgrst, 'reload schema';
