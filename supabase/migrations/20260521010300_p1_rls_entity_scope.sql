-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 4
-- Apply the canonical RLS template (policy #2: auth_internal) to every
-- entity-scoped table from migration 3. Pre-existing anon_all_* and
-- vendor_* policies are left untouched.
--
-- Rationale: only the internal-staff auth path (auth.users via entity_users)
-- is new in P1. Vendor isolation (auth_vendor_*) already exists and works;
-- entity-scoping vendor reads is deferred to P10 RLS-flip since RoF is
-- single-entity today and tightening now risks blocking the portal if
-- entity_vendors isn't fully seeded.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.3
-- ════════════════════════════════════════════════════════════════════════════

-- Idempotent ENABLE RLS for every table touched (no-op if already enabled).
ALTER TABLE tanda_pos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_line_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices               ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_line_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_item_master         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_category_master     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_vendor_master       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_customer_master     ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────────────
-- Canonical internal-auth policy (DROP+CREATE for idempotency).
-- Pattern: authenticated user can see/modify rows where they have an
-- entity_users row for that entity. Vendor users (who land in vendor_users
-- but not entity_users) match no rows here and are unaffected.
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "auth_internal_tanda_pos" ON tanda_pos;
CREATE POLICY "auth_internal_tanda_pos" ON tanda_pos
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_po_line_items" ON po_line_items;
CREATE POLICY "auth_internal_po_line_items" ON po_line_items
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_invoices" ON invoices;
CREATE POLICY "auth_internal_invoices" ON invoices
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_invoice_line_items" ON invoice_line_items;
CREATE POLICY "auth_internal_invoice_line_items" ON invoice_line_items
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_shipments" ON shipments;
CREATE POLICY "auth_internal_shipments" ON shipments
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_shipment_lines" ON shipment_lines;
CREATE POLICY "auth_internal_shipment_lines" ON shipment_lines
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_shipment_events" ON shipment_events;
CREATE POLICY "auth_internal_shipment_events" ON shipment_events
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_receipts" ON receipts;
CREATE POLICY "auth_internal_receipts" ON receipts
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_receipt_line_items" ON receipt_line_items;
CREATE POLICY "auth_internal_receipt_line_items" ON receipt_line_items
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_item_master" ON ip_item_master;
CREATE POLICY "auth_internal_ip_item_master" ON ip_item_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_category_master" ON ip_category_master;
CREATE POLICY "auth_internal_ip_category_master" ON ip_category_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_vendor_master" ON ip_vendor_master;
CREATE POLICY "auth_internal_ip_vendor_master" ON ip_vendor_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_customer_master" ON ip_customer_master;
CREATE POLICY "auth_internal_ip_customer_master" ON ip_customer_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- Anon-key policies are NOT touched by this migration. Existing anon_all_*
-- policies on each table continue to work; if a table never had one (e.g.
-- some ip_* tables), it operates without anon access until a future migration
-- adds the policy explicitly. This is intentional — we don't want to widen
-- access by accident.
-- ────────────────────────────────────────────────────────────────────────────
