-- 20260812000000_rfq_code.sql
--
-- Add a human-readable auto-generated CODE to every RFQ.
--
-- Format: RFQ-00001 (zero-padded to 5 digits). Assigned by a BEFORE INSERT
-- trigger off a sequence so EVERY create path (generate-rfqs, manual insert,
-- any future endpoint) gets a code without app-layer changes.
--
-- Idempotent: safe to re-run.

-- 1. Column.
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS code text;

-- 2. Sequence the trigger draws from.
CREATE SEQUENCE IF NOT EXISTS rfq_code_seq;

-- 3. Backfill existing rows in created_at order so codes are stable + ordered.
WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM rfqs
  WHERE code IS NULL
)
UPDATE rfqs r
SET code = 'RFQ-' || lpad(numbered.rn::text, 5, '0')
FROM numbered
WHERE r.id = numbered.id;

-- 4. Advance the sequence past the backfilled range so the next nextval()
--    yields the first un-used number.
SELECT setval('rfq_code_seq', GREATEST((SELECT count(*) FROM rfqs), 1));

-- 5. Trigger function: assign a code on insert when none was supplied.
CREATE OR REPLACE FUNCTION assign_rfq_code() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS NULL THEN
    NEW.code := 'RFQ-' || lpad(nextval('rfq_code_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. BEFORE INSERT trigger (drop-then-create for idempotency).
DROP TRIGGER IF EXISTS trg_assign_rfq_code ON rfqs;
CREATE TRIGGER trg_assign_rfq_code
  BEFORE INSERT ON rfqs
  FOR EACH ROW
  EXECUTE FUNCTION assign_rfq_code();

-- 7. Uniqueness backstop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfqs_code ON rfqs (code);

COMMENT ON COLUMN rfqs.code IS 'Human-readable RFQ code, format RFQ-00001, auto-assigned by trg_assign_rfq_code from rfq_code_seq.';
