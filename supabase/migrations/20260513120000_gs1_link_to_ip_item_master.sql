-- GS1: link upc_item_master rows to the canonical ip_item_master row.
--
-- Today, upc_item_master carries denormalized copies of style_no, color,
-- size, and description for the same items the planning + ATS apps see
-- via ip_item_master. Two consequences:
--   1. GS1 maintains its own Xoro sync (xoroSyncService.ts) instead of
--      reusing the nightly master pipeline that already populates
--      ip_item_master from the same Xoro CurrentProducts CSV.
--   2. Field-level edits in one source don't propagate to the other.
--
-- Phase 1 (this migration): introduce a nullable FK so GS1 can JOIN to
-- ip_item_master at query time when it needs richer fields (description,
-- category_id, vendor_id, unit_cost, etc.). FK is nullable because some
-- UPCs may not have a matching canonical SKU yet (Xoro item master can
-- run with a small lag behind GS1 label scans).
--
-- Phase 2 (later, code-level only): switch GS1 reads to LEFT JOIN
-- ip_item_master via sku_id and trust the join values for shared fields.
--
-- Phase 3 (much later, after Phase 2 is verified): drop the cached
-- columns (style_no, color, size, description) from upc_item_master.
-- Deferred because pack_gtin_bom currently FKs to upc_item_master.upc
-- and bomBuilderService caches by "style_no|color|size" string keys.
--
-- ip_item_master grain is (style, color); upc_item_master grain is
-- (style, color, size). N:1 relationship — many UPC sizes per SKU.

ALTER TABLE upc_item_master
  ADD COLUMN IF NOT EXISTS sku_id uuid REFERENCES ip_item_master(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_upc_item_master_sku_id
  ON upc_item_master (sku_id);

-- Auto-populate sku_id on INSERT / UPDATE of (style_no, color) so all
-- write paths (xoroSyncService + Excel ingest + manual UI edits) link
-- to the canonical SKU without each client having to do the lookup.
-- BEFORE trigger so NEW.sku_id is set before the row hits the table.
--
-- Match key mirrors the canonSku() helper in api/_lib/sku-canon.js:
--   trim → uppercase → strip ALL whitespace
-- Style and color in upc_item_master are already upper-case (xoroSyncService
-- + Excel ingest both .toUpperCase() before insert) but may carry spaces
-- ("ISLAND BREEZE LT WASH"), so the regex strip is what does the work.
--
-- If a caller explicitly sets sku_id (e.g. the future Phase 2 code that
-- resolves it client-side), the trigger respects the explicit value and
-- skips the lookup. Same for UPDATEs that don't touch style_no/color.
CREATE OR REPLACE FUNCTION upc_item_master_set_sku_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sku_id IS NULL THEN
    SELECT id INTO NEW.sku_id
    FROM ip_item_master
    WHERE sku_code = UPPER(REGEXP_REPLACE(NEW.style_no || '-' || NEW.color, '\s+', '', 'g'));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_upc_item_master_set_sku_id ON upc_item_master;
CREATE TRIGGER trg_upc_item_master_set_sku_id
  BEFORE INSERT OR UPDATE OF style_no, color ON upc_item_master
  FOR EACH ROW EXECUTE FUNCTION upc_item_master_set_sku_id();

-- Backfill existing rows. Same match logic as the trigger.
UPDATE upc_item_master uim
SET sku_id = iim.id
FROM ip_item_master iim
WHERE uim.sku_id IS NULL
  AND iim.sku_code = UPPER(REGEXP_REPLACE(uim.style_no || '-' || uim.color, '\s+', '', 'g'));

-- Surface the new column to the PostgREST schema cache so the GS1
-- frontend can SELECT it without redeploy.
NOTIFY pgrst, 'reload schema';
