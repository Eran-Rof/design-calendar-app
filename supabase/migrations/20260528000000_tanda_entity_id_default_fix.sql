-- ════════════════════════════════════════════════════════════════════════════
-- Tanda sync entity_id default fix
--
-- BUG: Tangerine P1 migration 20260521010200_p1_entity_id_propagation made
--      tanda_pos.entity_id and po_line_items.entity_id NOT NULL with no
--      DEFAULT. The Tanda Xoro sync's INSERT payload (useSyncOps.ts) doesn't
--      carry entity_id — no client-side entity machinery exists yet. So any
--      genuinely new PO from Xoro fails with:
--         null value in column "entity_id" of relation "tanda_pos"
--         violates not-null constraint
--
--      Existing rows still UPDATE fine (on-conflict-update preserves the
--      backfilled value), which is why the bug only surfaced after the
--      first new PO post-2026-05-21.
--
--      rebuild_po_line_items (mig 20260418120000) has the same blind spot:
--      it creates po_line_items rows from tanda_pos.data via trigger but
--      never sets entity_id on the child rows, so even after we fix the
--      tanda_pos default, the trigger would re-break on the child write.
--
-- FIX: Single-tenant-safe, multi-tenant-friendly:
--   1. rof_entity_id() helper returns the ROF entity uuid (STABLE)
--   2. DEFAULT rof_entity_id() on tanda_pos.entity_id and po_line_items.entity_id
--   3. Patch rebuild_po_line_items to copy entity_id from parent tanda_pos
--
-- Idempotent: SET DEFAULT is unconditional; CREATE OR REPLACE for functions.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Helper: returns the ROF entity uuid ─────────────────────────────────
CREATE OR REPLACE FUNCTION rof_entity_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM entities WHERE code = 'ROF' LIMIT 1;
$$;

-- ─── 2. Default for tanda_pos.entity_id ─────────────────────────────────────
ALTER TABLE tanda_pos
  ALTER COLUMN entity_id SET DEFAULT rof_entity_id();

-- ─── 3. Default for po_line_items.entity_id ─────────────────────────────────
ALTER TABLE po_line_items
  ALTER COLUMN entity_id SET DEFAULT rof_entity_id();

-- ─── 4. Patch rebuild_po_line_items to propagate entity_id ──────────────────
-- Only change from the original (mig 20260418120000): also SELECTs entity_id
-- from the parent tanda_pos and INSERTs it into each child row. COALESCE to
-- rof_entity_id() is a belt-and-suspenders guard in case a parent somehow
-- has NULL entity_id (shouldn't be possible post-P1 backfill).

CREATE OR REPLACE FUNCTION rebuild_po_line_items(p_po_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  po_data    jsonb;
  po_entity  uuid;
  items      jsonb;
  item       jsonb;
  idx        integer := 0;
  inserted   integer := 0;
BEGIN
  SELECT data, entity_id INTO po_data, po_entity
    FROM tanda_pos WHERE uuid_id = p_po_id;
  IF po_data IS NULL THEN RETURN 0; END IF;

  items := COALESCE(po_data->'Items', po_data->'PoLineArr', '[]'::jsonb);

  DELETE FROM po_line_items WHERE po_id = p_po_id;

  FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
    idx := idx + 1;
    INSERT INTO po_line_items (
      po_id, entity_id, line_index, item_number, description,
      qty_ordered, qty_received, qty_remaining, unit_price, line_total,
      date_expected_delivery, raw_json
    ) VALUES (
      p_po_id,
      COALESCE(po_entity, rof_entity_id()),
      idx,
      NULLIF(item->>'ItemNumber', ''),
      NULLIF(item->>'Description', ''),
      NULLIF(item->>'QtyOrder', '')::numeric,
      NULLIF(item->>'QtyReceived', '')::numeric,
      NULLIF(item->>'QtyRemaining', '')::numeric,
      NULLIF(item->>'UnitPrice', '')::numeric,
      CASE
        WHEN NULLIF(item->>'QtyOrder', '') IS NOT NULL
         AND NULLIF(item->>'UnitPrice', '') IS NOT NULL
        THEN (item->>'QtyOrder')::numeric * (item->>'UnitPrice')::numeric
        ELSE NULL
      END,
      NULLIF(item->>'DateExpectedDelivery', ''),
      item
    );
    inserted := inserted + 1;
  END LOOP;

  RETURN inserted;
END; $$;

-- ─── 5. Sanity probe — should return a uuid, not NULL ───────────────────────
DO $$
DECLARE
  v_id uuid;
BEGIN
  v_id := rof_entity_id();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'rof_entity_id() returned NULL — entities.code=ROF row missing';
  END IF;
END $$;

-- ─── 6. PostgREST schema cache reload ───────────────────────────────────────
NOTIFY pgrst, 'reload schema';
