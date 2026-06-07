-- Journal Entries had no human-readable identifier — only the uuid PK — which
-- violates the suite's "no viewable UUIDs" rule (SOs are SO-YYYY-NNNNN, etc.).
-- Add a sequential JE number, format JE-YYYY-NNNNN, entity-scoped + year-scoped
-- (year from posting_date). DB-assigned via a BEFORE INSERT trigger so EVERY
-- write path gets one — the manual-create RPC, every auto-posting event through
-- gl_post_journal_entry, and the direct-RPC paths (commission, year-end close).
-- Auto-assigned and immutable: there is no UI to edit it.

-- 1. Column + uniqueness (per entity; null allowed only transiently pre-trigger).
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS je_number text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_je_number
  ON journal_entries (entity_id, je_number) WHERE je_number IS NOT NULL;
COMMENT ON COLUMN journal_entries.je_number IS
  'Human-readable JE number JE-YYYY-NNNNN (year from posting_date), auto-assigned by trg_assign_je_number, entity- and year-scoped. Immutable; no UI edit.';

-- 2. Atomic per-(entity, year) counter. ON CONFLICT DO UPDATE ... RETURNING is
--    row-locked, so concurrent auto-posting bursts never collide or skip.
CREATE TABLE IF NOT EXISTS je_number_counters (
  entity_id uuid  NOT NULL,
  year      int   NOT NULL,
  last_seq  int   NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, year)
);
ALTER TABLE je_number_counters ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE je_number_counters IS
  'Per-(entity, year) high-water mark for journal_entries.je_number. Maintained by trg_assign_je_number (SECURITY DEFINER); not written directly.';

-- 3. Trigger: assign JE-YYYY-NNNNN on first insert if not already set.
--    SECURITY DEFINER so the counter upsert runs regardless of caller RLS.
CREATE OR REPLACE FUNCTION assign_je_number()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_year int;
  v_seq  int;
BEGIN
  IF NEW.je_number IS NOT NULL AND NEW.je_number <> '' THEN
    RETURN NEW;
  END IF;
  v_year := EXTRACT(YEAR FROM NEW.posting_date)::int;
  INSERT INTO je_number_counters (entity_id, year, last_seq)
    VALUES (NEW.entity_id, v_year, 1)
    ON CONFLICT (entity_id, year)
    DO UPDATE SET last_seq = je_number_counters.last_seq + 1
    RETURNING last_seq INTO v_seq;
  NEW.je_number := 'JE-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');
  RETURN NEW;
END;
$$;

-- 4. Backfill existing rows in posting_date → created_at → id order per
--    (entity, year). Runs as a plain UPDATE (the trigger is INSERT-only).
WITH ordered AS (
  SELECT id, entity_id,
         EXTRACT(YEAR FROM posting_date)::int AS yr,
         row_number() OVER (
           PARTITION BY entity_id, EXTRACT(YEAR FROM posting_date)::int
           ORDER BY posting_date, created_at, id
         ) AS rn
  FROM journal_entries
  WHERE je_number IS NULL
)
UPDATE journal_entries je
SET je_number = 'JE-' || o.yr::text || '-' || lpad(o.rn::text, 5, '0')
FROM ordered o
WHERE je.id = o.id;

-- 5. Seed the counter to the backfilled high-water mark so new inserts continue.
INSERT INTO je_number_counters (entity_id, year, last_seq)
SELECT entity_id,
       EXTRACT(YEAR FROM posting_date)::int AS yr,
       MAX(NULLIF(regexp_replace(je_number, '^JE-[0-9]+-', ''), '')::int) AS last_seq
FROM journal_entries
WHERE je_number IS NOT NULL
GROUP BY entity_id, EXTRACT(YEAR FROM posting_date)::int
ON CONFLICT (entity_id, year)
DO UPDATE SET last_seq = GREATEST(je_number_counters.last_seq, EXCLUDED.last_seq);

-- 6. Attach the trigger (drop-if-exists for idempotency).
DROP TRIGGER IF EXISTS trg_assign_je_number ON journal_entries;
CREATE TRIGGER trg_assign_je_number
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assign_je_number();

-- 7. Surface je_number in the GL-detail drill RPCs (both the original accrual
--    gl_detail and the basis-aware gl_detail_b) so the ledger + export show the
--    JE number instead of a uuid. DROP first: adding an OUT column changes the
--    return row type, which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS gl_detail(uuid, date, date);
DROP FUNCTION IF EXISTS gl_detail_b(uuid, date, date, text);

CREATE OR REPLACE FUNCTION gl_detail(p_account_id uuid, p_from date, p_to date)
RETURNS TABLE (
  posting_date          date,
  je_id                 uuid,
  je_number             text,
  description           text,
  debit_cents           bigint,
  credit_cents          bigint,
  running_balance_cents bigint,
  source_module         text,
  source_id             text
)
LANGUAGE sql STABLE
AS $$
  WITH lines AS (
    SELECT
      je.id                          AS je_id,
      je.je_number,
      je.posting_date,
      je.description,
      je.source_module,
      je.source_id,
      (jel.debit  * 100)::bigint     AS debit_cents,
      (jel.credit * 100)::bigint     AS credit_cents
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id    = p_account_id
      AND je.status         = 'posted'
      AND je.basis          = 'ACCRUAL'
      AND je.posting_date  BETWEEN p_from AND p_to
  )
  SELECT
    posting_date,
    je_id,
    je_number,
    description,
    debit_cents,
    credit_cents,
    SUM(debit_cents - credit_cents) OVER (ORDER BY posting_date, je_id)::bigint AS running_balance_cents,
    source_module,
    source_id
  FROM lines
  ORDER BY posting_date, je_id;
$$;

CREATE OR REPLACE FUNCTION gl_detail_b(
  p_account_id uuid,
  p_from       date,
  p_to         date,
  p_basis      text DEFAULT 'ACCRUAL'
)
RETURNS TABLE (
  posting_date          date,
  je_id                 uuid,
  je_number             text,
  description           text,
  debit_cents           bigint,
  credit_cents          bigint,
  running_balance_cents bigint,
  source_module         text,
  source_id             text
)
LANGUAGE sql STABLE
AS $$
  WITH lines AS (
    SELECT
      je.id                          AS je_id,
      je.je_number,
      je.posting_date,
      je.description,
      je.source_module,
      je.source_id,
      (jel.debit  * 100)::bigint     AS debit_cents,
      (jel.credit * 100)::bigint     AS credit_cents
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id    = p_account_id
      AND je.status         = 'posted'
      AND je.basis          = COALESCE(NULLIF(upper(p_basis), ''), 'ACCRUAL')
      AND je.posting_date  BETWEEN p_from AND p_to
  )
  SELECT
    posting_date,
    je_id,
    je_number,
    description,
    debit_cents,
    credit_cents,
    SUM(debit_cents - credit_cents) OVER (ORDER BY posting_date, je_id)::bigint AS running_balance_cents,
    source_module,
    source_id
  FROM lines
  ORDER BY posting_date, je_id;
$$;

NOTIFY pgrst, 'reload schema';
