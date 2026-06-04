-- Entity provisioning (clone COA) + stand up the Axel entity.
--
-- 1. clone_coa_to_entity(target, source): copies the source entity's BASE chart
--    of accounts (brand_id IS NULL — brand-child accounts are regenerated per
--    entity by M50 allocation, not copied) into the target entity, remapping
--    parent_account_id within the cloned set. Used by the entity-add API so a
--    new entity is a working set of books on creation. Operator decision: clone
--    ROF's COA for new entities.
-- 2. Stand up 'Syndicated Apparel Group' (code SAG) by cloning ROF's settings +
--    COA, then create the 'Axel' brand under SAG. (Brands are migration-managed.)
--
-- Idempotent: guarded on existence; clone skips codes already present.

CREATE OR REPLACE FUNCTION clone_coa_to_entity(p_target uuid, p_source uuid)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
BEGIN
  CREATE TEMP TABLE _coa_clone_map (old_id uuid, new_id uuid) ON COMMIT DROP;

  WITH src AS (
    SELECT id, code, name, account_type, normal_balance, account_subtype,
           is_postable, is_control, status, description, parent_account_id
    FROM gl_accounts
    WHERE entity_id = p_source AND brand_id IS NULL
  ),
  ins AS (
    INSERT INTO gl_accounts
      (entity_id, code, name, account_type, normal_balance, account_subtype,
       is_postable, is_control, status, description)
    SELECT p_target, code, name, account_type, normal_balance, account_subtype,
           is_postable, is_control, status, description
    FROM src
    WHERE NOT EXISTS (
      SELECT 1 FROM gl_accounts g WHERE g.entity_id = p_target AND g.code = src.code
    )
    RETURNING id, code
  )
  INSERT INTO _coa_clone_map (old_id, new_id)
  SELECT s.id, i.id FROM src s JOIN ins i ON i.code = s.code;

  -- Remap parent links within the freshly-cloned set.
  UPDATE gl_accounts t
  SET parent_account_id = m_parent.new_id
  FROM gl_accounts s
  JOIN _coa_clone_map m_self   ON m_self.old_id = s.id
  JOIN _coa_clone_map m_parent ON m_parent.old_id = s.parent_account_id
  WHERE t.id = m_self.new_id AND s.parent_account_id IS NOT NULL;

  SELECT count(*) INTO v_count FROM _coa_clone_map;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION clone_coa_to_entity(uuid, uuid) IS
  'Clone source entity base COA (brand_id IS NULL) into target entity with parent remapping. Returns # accounts cloned. Idempotent (skips existing codes).';

-- ─── Stand up Syndicated Apparel Group (SAG) + Axel brand ────────────────────
DO $$
DECLARE
  v_rof  uuid;
  v_sag  uuid;
  v_axel uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  SELECT id INTO v_sag FROM entities WHERE code = 'SAG';

  IF v_sag IS NULL THEN
    INSERT INTO entities (code, name, slug, status, functional_currency,
                          fiscal_year_start_month, accounting_basis_primary)
    SELECT 'SAG', 'Syndicated Apparel Group', 'syndicated-apparel-group', 'active',
           functional_currency, fiscal_year_start_month, accounting_basis_primary
    FROM entities WHERE code = 'ROF'
    RETURNING id INTO v_sag;

    PERFORM clone_coa_to_entity(v_sag, v_rof);
    RAISE NOTICE 'SAG entity created (%); COA cloned from ROF', v_sag;
  END IF;

  -- Axel brand under SAG (brands are migration-managed; append-only).
  SELECT id INTO v_axel FROM brand_master WHERE entity_id = v_sag AND code = 'AXEL';
  IF v_axel IS NULL THEN
    INSERT INTO brand_master (entity_id, code, name, is_default, sort_order)
    VALUES (v_sag, 'AXEL', 'Axel', false, 100);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
