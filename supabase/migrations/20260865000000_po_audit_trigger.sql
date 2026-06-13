-- Purchase Orders — attach the T11 universal audit trigger.
--
-- The same AFTER INSERT/UPDATE/DELETE trigger that covers AR/AP/JE/customers/
-- vendors (audit_row_changes_trigger → row_changes) now covers purchase_orders
-- and purchase_order_lines, so every header/line field change is captured
-- (changed columns + before/after + when) and surfaced via the PO modal's
-- Audit-trail timeline (GET /api/internal/audit/row-history).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['purchase_orders', 'purchase_order_lines'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS audit_row_changes ON %I', t);
      EXECUTE format(
        'CREATE TRIGGER audit_row_changes
           AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger()',
        t
      );
    END IF;
  END LOOP;
END $$;
