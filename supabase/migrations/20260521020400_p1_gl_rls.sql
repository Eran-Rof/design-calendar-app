-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 9
-- RLS for GL tables. Vendors never see GL data; the anon-key SPA path retains
-- full access (internal app), and authenticated internal users are scoped via
-- entity_users. A closed-period guard prevents UPDATE/DELETE on JEs whose
-- referenced period has status='closed'.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.4
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE gl_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_periods           ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_lines  ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────────────
-- Anon-key SPA path (internal apps) — full access. Vendors never reach these
-- tables via the vendor portal because no vendor route queries them.
-- ────────────────────────────────────────────────────────────────────────────
CREATE POLICY "anon_all_gl_accounts" ON gl_accounts
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_gl_periods" ON gl_periods
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_journal_entries" ON journal_entries
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_journal_entry_lines" ON journal_entry_lines
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- Authenticated internal users — entity-scoped via entity_users junction.
-- ────────────────────────────────────────────────────────────────────────────
CREATE POLICY "auth_internal_gl_accounts" ON gl_accounts
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

CREATE POLICY "auth_internal_gl_periods" ON gl_periods
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

CREATE POLICY "auth_internal_journal_entries" ON journal_entries
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- Lines inherit entity scoping via their parent journal_entry.
CREATE POLICY "auth_internal_journal_entry_lines" ON journal_entry_lines
  FOR ALL TO authenticated
  USING (journal_entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN entity_users eu ON eu.entity_id = je.entity_id
    WHERE eu.auth_id = auth.uid()
  ))
  WITH CHECK (journal_entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN entity_users eu ON eu.entity_id = je.entity_id
    WHERE eu.auth_id = auth.uid()
  ));

-- ════════════════════════════════════════════════════════════════════════════
-- Closed-period guard: trigger-based (RLS can't easily express "deny based on
-- referenced row's status"). Once a period is 'closed', NO writes to JEs in
-- it, regardless of caller. soft_close is a softer state — only inserts of
-- non-'adjustment' journal types are blocked.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION journal_entry_period_lock_guard() RETURNS trigger AS $$
DECLARE
  period_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO period_status FROM gl_periods WHERE id = OLD.period_id;
    IF period_status = 'closed' THEN
      RAISE EXCEPTION 'Cannot DELETE journal_entry % in closed period', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  SELECT status INTO period_status FROM gl_periods WHERE id = NEW.period_id;

  IF period_status = 'closed' THEN
    RAISE EXCEPTION 'Cannot write journal_entry % into closed period', NEW.id;
  END IF;

  IF TG_OP = 'INSERT' AND period_status = 'soft_close'
     AND NEW.journal_type NOT IN ('adjustment','close') THEN
    RAISE EXCEPTION 'Period is soft-closed; only adjustment/close journal types allowed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS je_period_lock_ins ON journal_entries;
CREATE TRIGGER je_period_lock_ins
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_period_lock_guard();

DROP TRIGGER IF EXISTS je_period_lock_upd ON journal_entries;
CREATE TRIGGER je_period_lock_upd
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_period_lock_guard();

DROP TRIGGER IF EXISTS je_period_lock_del ON journal_entries;
CREATE TRIGGER je_period_lock_del
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_period_lock_guard();

COMMENT ON FUNCTION journal_entry_period_lock_guard() IS 'Trigger-level period status enforcement. Blocks all writes into closed periods; in soft_close periods, only adjustment/close journal types may be inserted.';
