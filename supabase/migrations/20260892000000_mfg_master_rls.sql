-- Manufacturing masters — enable Row Level Security.
--
-- part_master (M1), service_item_master (M1), and part_type_master (M5b) shipped
-- WITHOUT RLS, unlike every sibling mfg table (part_inventory_layers, mfg_bom,
-- mfg_build_orders, …). With RLS off and the standard Supabase anon grants, the
-- anon key could read/write part costs, default vendors, and service charges
-- with no entity scoping. This brings them in line with the sibling tables:
-- anon_all (the app is anon-gated today) + auth_internal (entity-scoped) — the
-- exact policy pair used by mfg_bom / mfg_build_orders.
--
-- Idempotent: ENABLE RLS is a no-op if already on; policies are DROP-then-CREATE.

ALTER TABLE part_master         ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_item_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_type_master    ENABLE ROW LEVEL SECURITY;

-- part_master
DROP POLICY IF EXISTS "anon_all_part_master" ON part_master;
CREATE POLICY "anon_all_part_master" ON part_master FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_part_master" ON part_master;
CREATE POLICY "auth_internal_part_master" ON part_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- service_item_master
DROP POLICY IF EXISTS "anon_all_service_item_master" ON service_item_master;
CREATE POLICY "anon_all_service_item_master" ON service_item_master FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_service_item_master" ON service_item_master;
CREATE POLICY "auth_internal_service_item_master" ON service_item_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- part_type_master
DROP POLICY IF EXISTS "anon_all_part_type_master" ON part_type_master;
CREATE POLICY "anon_all_part_type_master" ON part_type_master FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_part_type_master" ON part_type_master;
CREATE POLICY "auth_internal_part_type_master" ON part_type_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
