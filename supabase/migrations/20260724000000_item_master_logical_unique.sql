-- Part 2b — the structural backstop that stops ip_item_master from ever
-- re-fragmenting into duplicate SKUs. After Tiers 1+2 collapsed the catalog to
-- one row per logical SKU (memory project_ip_item_master_dup_skus), this adds a
-- UNIQUE on the logical identity. It keys on canonical_size(size) (via an
-- IMMUTABLE expression index) so the SML/LRG/LARGE-style spelling variance that
-- caused the sprawl can never split a cell again — without mutating the stored
-- size column. NULL color/inseam are coalesced so they collide rather than slip
-- past. Scoped to sized SKUs (style_id + size present).
--
-- NOTE: every SKU-creation path must catch a 23505 on this index and reuse the
-- existing row. resolveOrCreateSku already does; the Excel Item Master uploader
-- and any sku_code-only sync must be verified before relying on this.

CREATE OR REPLACE FUNCTION canonical_size(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE upper(trim(s))
    WHEN 'XS' THEN 'XSMALL' WHEN 'XSM' THEN 'XSMALL'
    WHEN 'S' THEN 'SMALL' WHEN 'SM' THEN 'SMALL' WHEN 'SML' THEN 'SMALL'
    WHEN 'M' THEN 'MEDIUM' WHEN 'MD' THEN 'MEDIUM' WHEN 'MED' THEN 'MEDIUM'
    WHEN 'L' THEN 'LARGE' WHEN 'LG' THEN 'LARGE' WHEN 'LRG' THEN 'LARGE'
    WHEN 'XL' THEN 'XLARGE' WHEN 'XLG' THEN 'XLARGE'
    WHEN 'XXL' THEN '2XLARGE' WHEN '2X' THEN '2XLARGE' WHEN '2XL' THEN '2XLARGE'
    WHEN '3X' THEN '3XLARGE' WHEN '3XL' THEN '3XLARGE' WHEN 'XXXL' THEN '3XLARGE'
    ELSE upper(trim(s)) END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_item_master_logical_sku
  ON ip_item_master (entity_id, style_id, COALESCE(color, ''), canonical_size(size), COALESCE(inseam, ''))
  WHERE style_id IS NOT NULL AND size IS NOT NULL;

COMMENT ON INDEX uq_ip_item_master_logical_sku IS
  'Logical-SKU uniqueness (style,color,canonical size,inseam) — the backstop preventing duplicate-SKU re-fragmentation. canonical_size() collapses SML/LRG/LARGE etc.';
