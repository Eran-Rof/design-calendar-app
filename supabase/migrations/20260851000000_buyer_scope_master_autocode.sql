-- buyer_scope_master.code is now AUTO-GENERATED (SCOPE-NNNNN) and immutable —
-- never operator-supplied or editable. Backfills the existing rows, assigns on
-- insert, and freezes the value on update. Codes are an internal key only; the
-- customer_buyer_scopes join references scope_id (uuid), so rewriting the code
-- text is safe (nothing FKs to it).

-- 1. Backfill existing rows → SCOPE-NNNNN in their current display order.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY sort_order, created_at) AS rn
  FROM buyer_scope_master
)
UPDATE buyer_scope_master b
SET code = 'SCOPE-' || lpad(o.rn::text, 5, '0'), updated_at = now()
FROM ordered o
WHERE o.id = b.id;

-- 2. One UNIQUE backstop on the generated code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_scope_master_code ON buyer_scope_master (code);

-- 3. Trigger: assign SCOPE-NNNNN on INSERT (ignoring any supplied code), and
--    freeze the code on UPDATE (operator can never change it).
CREATE OR REPLACE FUNCTION buyer_scope_master_code() RETURNS trigger AS $$
DECLARE
  v_seq integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.code := OLD.code;            -- immutable
    RETURN NEW;
  END IF;
  -- INSERT: always auto-assign, regardless of what was passed in.
  SELECT COALESCE(MAX((substring(code FROM 'SCOPE-([0-9]+)'))::int), 0) + 1
    INTO v_seq
    FROM buyer_scope_master;
  NEW.code := 'SCOPE-' || lpad(v_seq::text, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS buyer_scope_master_code_trg ON buyer_scope_master;
CREATE TRIGGER buyer_scope_master_code_trg
  BEFORE INSERT OR UPDATE ON buyer_scope_master
  FOR EACH ROW EXECUTE FUNCTION buyer_scope_master_code();

NOTIFY pgrst, 'reload schema';
