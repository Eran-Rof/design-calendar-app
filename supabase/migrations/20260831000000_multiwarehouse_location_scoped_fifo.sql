-- Multi-warehouse: location-scoped FIFO (M52, part 1 — data foundation).
--
-- Today every inventory_layers row carries the same location_id (the "Main
-- Warehouse" row), while the REAL warehouse split lives only in a `wh=<name>`
-- token inside notes (from the Xoro by-size cutover). This migration:
--   1. De-duplicates the two identical "Main Warehouse" (MAIN_WH) rows.
--   2. Creates the "Psycho Tuna" + "Psycho Tuna Ecom" warehouses.
--   3. Re-points inventory_layers.location_id from the `wh=` tag so on-hand is
--      finally partitioned by real warehouse:
--        wh=ROF Main        -> Main Warehouse (MAIN_WH)
--        wh=ROF - ECOM      -> ROF Ecom (WH-00001)
--        wh=Psycho Tuna     -> Psycho Tuna (WH-00002)
--        wh=Psycho Tuna Ecom-> Psycho Tuna Ecom (WH-00003)
--        (untagged)         -> stays Main Warehouse (default bucket)
--
-- Conservation: total remaining_qty is invariant (we only re-label location_id,
-- never change quantities). A DO-block asserts this and RAISEs -> rollback on
-- any drift. Idempotent: safe to re-run; a no-op on a fresh DB with no layers.

DO $mw$
DECLARE
  v_entity        uuid := '404b8a6b-0d2d-44d2-8539-9064ff0fafee';
  v_main_id       uuid := '0c5e8506-cc6d-4db8-a579-feaf45c05d06'; -- canonical MAIN_WH (all layers point here today)
  v_dup_main_id   uuid := '499bdd22-6f2d-4513-8527-3990c4330c2a'; -- unreferenced duplicate MAIN_WH
  v_ecom_id       uuid := '128ccdf6-a86c-4297-b763-d137329ae18f'; -- WH-00001 ROF Ecom
  v_psycho_id     uuid;
  v_psycho_ec_id  uuid;
  v_total_before  numeric;
  v_total_after   numeric;
  v_unmapped      bigint;
BEGIN
  -- Snapshot total on-hand for the conservation assertion.
  SELECT COALESCE(sum(remaining_qty), 0) INTO v_total_before FROM inventory_layers;

  -- 1. De-dupe MAIN_WH — only if the duplicate carries NO layers.
  IF EXISTS (SELECT 1 FROM inventory_locations WHERE id = v_dup_main_id) THEN
    IF EXISTS (SELECT 1 FROM inventory_layers WHERE location_id = v_dup_main_id) THEN
      RAISE EXCEPTION 'Duplicate MAIN_WH % has layers — aborting dedupe', v_dup_main_id;
    END IF;
    DELETE FROM inventory_locations WHERE id = v_dup_main_id;
  END IF;

  -- 2. Create the two Psycho warehouses (idempotent by code within entity).
  SELECT id INTO v_psycho_id FROM inventory_locations
    WHERE entity_id = v_entity AND code = 'WH-00002' LIMIT 1;
  IF v_psycho_id IS NULL THEN
    INSERT INTO inventory_locations (entity_id, code, name, kind, is_active, sort_order)
    VALUES (v_entity, 'WH-00002', 'Psycho Tuna', 'warehouse', true, 20)
    RETURNING id INTO v_psycho_id;
  END IF;

  SELECT id INTO v_psycho_ec_id FROM inventory_locations
    WHERE entity_id = v_entity AND code = 'WH-00003' LIMIT 1;
  IF v_psycho_ec_id IS NULL THEN
    INSERT INTO inventory_locations (entity_id, code, name, kind, is_active, sort_order)
    VALUES (v_entity, 'WH-00003', 'Psycho Tuna Ecom', 'warehouse', true, 30)
    RETURNING id INTO v_psycho_ec_id;
  END IF;

  -- 3. Re-point location_id from the `wh=` notes tag.
  UPDATE inventory_layers
     SET location_id = v_main_id
   WHERE substring(notes from 'wh=(.+)$') = 'ROF Main';

  UPDATE inventory_layers
     SET location_id = v_ecom_id
   WHERE substring(notes from 'wh=(.+)$') = 'ROF - ECOM';

  UPDATE inventory_layers
     SET location_id = v_psycho_id
   WHERE substring(notes from 'wh=(.+)$') = 'Psycho Tuna';

  UPDATE inventory_layers
     SET location_id = v_psycho_ec_id
   WHERE substring(notes from 'wh=(.+)$') = 'Psycho Tuna Ecom';

  -- Untagged layers keep their current location (Main Warehouse) — no-op.

  -- 4. Conservation assertion: total on-hand must be unchanged.
  SELECT COALESCE(sum(remaining_qty), 0) INTO v_total_after FROM inventory_layers;
  IF v_total_after <> v_total_before THEN
    RAISE EXCEPTION 'On-hand conservation violated: before=% after=%', v_total_before, v_total_after;
  END IF;

  -- 5. Every layer must still carry a location_id.
  SELECT count(*) INTO v_unmapped FROM inventory_layers WHERE location_id IS NULL;
  IF v_unmapped > 0 THEN
    RAISE EXCEPTION '% layer(s) ended with NULL location_id', v_unmapped;
  END IF;
END
$mw$;
