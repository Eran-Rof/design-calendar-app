-- 20260897000000_gs1_catalog.sql
--
-- GS1 Styles Catalog — the publishable supplier catalog (workflow step 1).
--
-- One row per saleable style + color, auto-imported from the PLM style master
-- (style_master + ip_item_master colors) with the sales price pulled from a
-- user-selected Tangerine price list (M43 price_lists / price_list_items). The
-- operator can override the price before publishing the catalog as a GDSN /
-- retail-portal feed (CIN trade items).
--
-- Single-tenant, anon-RLS, no entity_id — matches the rest of the GS1 module
-- (see 20260422211000_gs1_prepack_schema.sql). Style/color/price data is read
-- from the entity-scoped PLM tables server-side; only the curated catalog row
-- (with its editable price + publish state) is stored here.

-- ══════════════════════════════════════════════════════════════════════════════
-- gs1_catalog_items
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gs1_catalog_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity (denormalized from the PLM so the catalog is self-contained for export).
  style_id        uuid,                       -- style_master.id (loose link; no FK across modules)
  style_no        text NOT NULL,              -- style_master.style_code
  style_name      text,
  color           text NOT NULL,
  color_id        uuid,                       -- color_master.id when resolved
  brand           text,
  category        text,
  description     text,
  -- GS1 codes (resolved from the GS1 masters at import time; may be null until minted).
  pack_gtin       text,                       -- pack_gtin_master.pack_gtin for (style_no,color)
  -- Pricing — pulled from the chosen price list, editable before publish.
  price_cents     bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  currency        char(3) NOT NULL DEFAULT 'USD',
  price_list_id   uuid,                       -- price_lists.id the price came from
  price_list_code text,                       -- price_lists.code (e.g. PL-00001 / DEFAULT)
  -- Publish workflow.
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'ready', 'published')),
  gdsn_target     text,                       -- data pool / portal the feed was generated for
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One catalog row per style+color.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gs1_catalog_style_color
  ON gs1_catalog_items (style_no, color);
CREATE INDEX IF NOT EXISTS idx_gs1_catalog_status ON gs1_catalog_items (status);
CREATE INDEX IF NOT EXISTS idx_gs1_catalog_style  ON gs1_catalog_items (style_no);

-- keep updated_at fresh (mirrors the trigger pattern used elsewhere in GS1).
CREATE OR REPLACE FUNCTION gs1_catalog_items_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gs1_catalog_items_touch ON gs1_catalog_items;
CREATE TRIGGER trg_gs1_catalog_items_touch
  BEFORE UPDATE ON gs1_catalog_items
  FOR EACH ROW EXECUTE FUNCTION gs1_catalog_items_touch_updated_at();

-- RLS: permissive anon policy (internal app — matches the GS1 module pattern).
ALTER TABLE gs1_catalog_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gs1_anon_all ON gs1_catalog_items;
CREATE POLICY gs1_anon_all ON gs1_catalog_items
  FOR ALL TO anon USING (true) WITH CHECK (true);
