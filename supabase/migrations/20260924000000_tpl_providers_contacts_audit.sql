-- 3PL providers — multiple contacts + audit trail (operator items 1 & 2).
--
-- (1) Add a `contacts` jsonb array (mirrors customers.contacts) so a provider can
--     carry up to 8 contacts, each with name / title / department / email / phone.
-- (2) Attach the T11 universal audit trigger (same one covering AR/AP/JE/customers/
--     vendors/POs) so every provider change is captured + surfaced in the provider
--     modal's Audit-trail timeline (GET /api/internal/audit/row-history).

ALTER TABLE tpl_providers ADD COLUMN IF NOT EXISTS contacts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN tpl_providers.contacts IS 'Up to 8 contacts, each {name,title,department,email,phone}. Mirrors customers.contacts.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'tpl_providers'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS audit_row_changes ON tpl_providers';
    EXECUTE
      'CREATE TRIGGER audit_row_changes
         AFTER INSERT OR UPDATE OR DELETE ON tpl_providers
         FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger()';
  END IF;
END $$;
