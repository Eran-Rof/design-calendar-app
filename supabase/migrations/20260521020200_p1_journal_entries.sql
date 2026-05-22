-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 7
-- journal_entries + journal_entry_lines, plus trigger-level posting guards:
--   • balanced: Σ(debit) = Σ(credit)
--   • period_open: posting_date must fall in an open period
--   • postable: lines reject non-postable accounts
--   • control_subledger: lines hitting is_control must include subledger
--   • idempotency: (source_table, source_id, basis) unique among non-NULL sources
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1, §4.3
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS journal_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  period_id            uuid NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
  basis                text NOT NULL,
  journal_type         text NOT NULL,
  posting_date         date NOT NULL,
  source_module        text NOT NULL,
  source_table         text,
  source_id            text,
  description          text NOT NULL,
  status               text NOT NULL DEFAULT 'draft',
  posted_at            timestamptz,
  posted_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reversed_by_je_id    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  reverses_je_id       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  sibling_je_id        uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT journal_entries_basis_check
    CHECK (basis IN ('ACCRUAL','CASH')),
  CONSTRAINT journal_entries_status_check
    CHECK (status IN ('draft','posted','reversed'))
);

CREATE INDEX IF NOT EXISTS idx_je_entity_basis_date
  ON journal_entries (entity_id, basis, posting_date);
CREATE INDEX IF NOT EXISTS idx_je_period_basis_status
  ON journal_entries (period_id, basis, status);
CREATE INDEX IF NOT EXISTS idx_je_source
  ON journal_entries (source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_je_sibling
  ON journal_entries (sibling_je_id);

-- Idempotency: a given source event posts at most once per basis.
CREATE UNIQUE INDEX IF NOT EXISTS uq_je_source_basis
  ON journal_entries (source_table, source_id, basis)
  WHERE source_id IS NOT NULL;

COMMENT ON TABLE  journal_entries IS 'Header for every GL posting. Dual-basis: every event produces 0/1/2 sibling rows (one ACCRUAL, one CASH) linked via sibling_je_id. status=draft is editable; posted is immutable except for reversal; reversed is terminal.';
COMMENT ON COLUMN journal_entries.basis        IS 'ACCRUAL or CASH. Both books always coexist; reports filter by basis.';
COMMENT ON COLUMN journal_entries.sibling_je_id IS 'Points at the other-basis twin of this JE. NULL when only one basis emitted a row for the event.';
COMMENT ON COLUMN journal_entries.source_table  IS 'Origin table for the event (e.g. invoices, payments). Combined with source_id forms the idempotency key.';

-- ────────────────────────────────────────────────────────────────────────────
-- journal_entry_lines
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id     uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_number          smallint NOT NULL,
  account_id           uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  debit                numeric(18,2) NOT NULL DEFAULT 0,
  credit               numeric(18,2) NOT NULL DEFAULT 0,
  memo                 text,
  subledger_type       text,
  subledger_id         uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jel_line_unique UNIQUE (journal_entry_id, line_number),
  CONSTRAINT jel_one_side_check
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  CONSTRAINT jel_amounts_nonneg
    CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT jel_subledger_pair_check
    CHECK ((subledger_type IS NULL AND subledger_id IS NULL)
        OR (subledger_type IS NOT NULL AND subledger_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_jel_je               ON journal_entry_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account          ON journal_entry_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_jel_subledger        ON journal_entry_lines (subledger_type, subledger_id);

COMMENT ON TABLE journal_entry_lines IS 'Lines belonging to a journal_entry. One side per line (debit XOR credit). Lines hitting an is_control=true account must include subledger_type + subledger_id; enforcement is in the JE posting trigger.';

-- ════════════════════════════════════════════════════════════════════════════
-- Posting guard trigger: runs when journal_entries.status transitions to
-- 'posted'. Validates everything the application posting service should have
-- already checked. Fail-loud safety net.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION journal_entry_post_guards() RETURNS trigger AS $$
DECLARE
  total_d           numeric(18,2);
  total_c           numeric(18,2);
  bad_line          record;
  period            record;
  entity_lock       date;
BEGIN
  -- 1. Balanced: Σ(debit) = Σ(credit)
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_d, total_c
  FROM journal_entry_lines WHERE journal_entry_id = NEW.id;

  IF total_d <> total_c THEN
    RAISE EXCEPTION 'Unbalanced journal_entry %: debits=% credits=%',
      NEW.id, total_d, total_c;
  END IF;

  IF total_d = 0 THEN
    RAISE EXCEPTION 'Journal_entry % has no lines or zero totals', NEW.id;
  END IF;

  -- 2. Period status: the referenced period must be open
  SELECT status, starts_on INTO period
    FROM gl_periods WHERE id = NEW.period_id;
  IF period.status <> 'open' THEN
    RAISE EXCEPTION 'Cannot post journal_entry % into period in status %',
      NEW.id, period.status;
  END IF;

  -- 3. posting_date falls inside the referenced period
  IF NEW.posting_date NOT BETWEEN period.starts_on AND period.starts_on + interval '1 month' - interval '1 day' THEN
    -- Cheap re-derive of ends_on to avoid a second SELECT
    PERFORM 1 FROM gl_periods
      WHERE id = NEW.period_id
        AND NEW.posting_date BETWEEN starts_on AND ends_on;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'posting_date % is outside period % bounds', NEW.posting_date, NEW.period_id;
    END IF;
  END IF;

  -- 4. entities.posting_locked_through hard lock
  SELECT posting_locked_through INTO entity_lock
    FROM entities WHERE id = NEW.entity_id;
  IF entity_lock IS NOT NULL AND NEW.posting_date <= entity_lock THEN
    RAISE EXCEPTION 'posting_date % is on or before entity hard-lock %',
      NEW.posting_date, entity_lock;
  END IF;

  -- 5. Every line's account must belong to the same entity, be active, postable.
  --    Control accounts require subledger.
  FOR bad_line IN
    SELECT jel.id, jel.account_id, a.entity_id AS account_entity, a.status,
           a.is_postable, a.is_control, jel.subledger_type
    FROM journal_entry_lines jel
    JOIN gl_accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.id
      AND (a.entity_id <> NEW.entity_id
        OR a.status <> 'active'
        OR a.is_postable = false
        OR (a.is_control = true AND jel.subledger_type IS NULL))
  LOOP
    IF bad_line.account_entity <> NEW.entity_id THEN
      RAISE EXCEPTION 'JE line % references account in wrong entity', bad_line.id;
    ELSIF bad_line.status <> 'active' THEN
      RAISE EXCEPTION 'JE line % references inactive account %', bad_line.id, bad_line.account_id;
    ELSIF bad_line.is_postable = false THEN
      RAISE EXCEPTION 'JE line % targets non-postable account %', bad_line.id, bad_line.account_id;
    ELSE
      RAISE EXCEPTION 'JE line % targets control account % without subledger', bad_line.id, bad_line.account_id;
    END IF;
  END LOOP;

  NEW.posted_at := COALESCE(NEW.posted_at, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE INSERT — for direct inserts at status='posted'
DROP TRIGGER IF EXISTS journal_entries_post_guard_ins ON journal_entries;
CREATE TRIGGER journal_entries_post_guard_ins
  BEFORE INSERT ON journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION journal_entry_post_guards();

-- BEFORE UPDATE — when status transitions to 'posted'
DROP TRIGGER IF EXISTS journal_entries_post_guard_upd ON journal_entries;
CREATE TRIGGER journal_entries_post_guard_upd
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW
  WHEN (OLD.status <> 'posted' AND NEW.status = 'posted')
  EXECUTE FUNCTION journal_entry_post_guards();

-- Touched timestamp
CREATE OR REPLACE FUNCTION journal_entries_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_touch_trg ON journal_entries;
CREATE TRIGGER journal_entries_touch_trg
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_touch();

-- ════════════════════════════════════════════════════════════════════════════
-- Immutability: once a JE is 'posted' or 'reversed', lines cannot change.
-- Only the JE-level status flip to 'reversed' is allowed via the reverse path.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION journal_entry_lines_immutable() RETURNS trigger AS $$
DECLARE
  je_status text;
BEGIN
  SELECT status INTO je_status FROM journal_entries
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  IF je_status IN ('posted','reversed') THEN
    RAISE EXCEPTION 'journal_entry_lines for JE in status % are immutable', je_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entry_lines_immutable_trg ON journal_entry_lines;
CREATE TRIGGER journal_entry_lines_immutable_trg
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_immutable();
