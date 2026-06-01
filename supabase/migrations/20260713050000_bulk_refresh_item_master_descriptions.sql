-- ════════════════════════════════════════════════════════════════════════════
-- 2026-05-30: bulk_refresh_item_master_descriptions RPC
--
-- Background: /api/master/sync's UPDATE path (existing sku_codes) fails on
-- every chunk because PostgreSQL evaluates CHECK constraints on the proposed
-- INSERT row BEFORE checking for the unique conflict and routing to DO UPDATE.
-- Our payload's proposed INSERT row has is_apparel defaulting to true with
-- color/size/inseam/length/fit NULL → apparel_dims_required CHECK fails,
-- conflict resolution never runs, the whole chunk aborts atomically.
--
-- Workaround: do a true UPDATE (not INSERT...ON CONFLICT) via this RPC.
-- The handler keeps using upsert for the NEW-row path (with is_apparel:false
-- to satisfy CHECK). For the UPDATE path, it calls this function with a
-- jsonb array of {sku_code, description, attributes} rows.
--
-- Merge semantics (matches handler docstring "leave existing populated
-- values alone"):
--   description: COALESCE(existing, input) — existing non-null wins,
--                fills NULL only.
--   attributes:  existing || input — JSONB shallow merge with input keys
--                winning on conflict. Adds Xoro classification fields
--                (group_name, category_name, ...) without nuking any
--                merchandiser-added keys.
--
-- updated_at is bumped so audit/changelog views surface the refresh.
--
-- Returns: row count actually updated.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bulk_refresh_item_master_descriptions(payload jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'array' THEN
    RETURN 0;
  END IF;

  WITH input AS (
    SELECT *
      FROM jsonb_to_recordset(payload)
        AS x(sku_code text, description text, attributes jsonb)
  ),
  upd AS (
    UPDATE ip_item_master m
       SET description = COALESCE(m.description, i.description),
           attributes  = COALESCE(m.attributes, '{}'::jsonb)
                       || COALESCE(i.attributes, '{}'::jsonb),
           updated_at  = now()
      FROM input i
     WHERE m.sku_code = i.sku_code
    RETURNING m.id
  )
  SELECT count(*) INTO updated_count FROM upd;

  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION public.bulk_refresh_item_master_descriptions(jsonb) IS
  'Bulk-refreshes description+attributes for existing ip_item_master rows by sku_code. Used by /api/master/sync UPDATE path to dodge the apparel_dims_required CHECK that fires on the proposed INSERT row in upsert flows. COALESCE keeps existing description; attributes shallow-merge with input winning on shared keys.';

GRANT EXECUTE ON FUNCTION public.bulk_refresh_item_master_descriptions(jsonb)
  TO authenticated, service_role;
