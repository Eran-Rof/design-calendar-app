-- ════════════════════════════════════════════════════════════════════════════
-- P11-10 Chunk 1: shopify_products table
--
-- Mirrors the Shopify product catalog per store. One row per
-- (shopify_store_id, shopify_product_id). resolved_style_id is the
-- back-link to style_master after the operator (or auto-match cron)
-- confirms the pairing.
--
-- See docs/tangerine/P11-10-shopify-product-mirror-and-image-unification.md §3.2
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS shopify_products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id       uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_product_id     bigint NOT NULL,
  shopify_handle         text NOT NULL,
  title                  text NOT NULL,
  product_type           text,
  vendor                 text,
  tags                   text[] NOT NULL DEFAULT '{}',
  status                 text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived','draft')),
  published_at           timestamptz,
  updated_at_shopify     timestamptz NOT NULL,
  raw_payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_style_id      uuid REFERENCES style_master(id) ON DELETE SET NULL,
  match_method           text CHECK (match_method IN ('handle','tag','manual')),
  last_synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_products_unique UNIQUE (shopify_store_id, shopify_product_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_products_handle
  ON shopify_products (shopify_store_id, shopify_handle);

CREATE INDEX IF NOT EXISTS idx_shopify_products_style
  ON shopify_products (resolved_style_id) WHERE resolved_style_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shopify_products_unmatched
  ON shopify_products (last_synced_at) WHERE resolved_style_id IS NULL;

ALTER TABLE shopify_products ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'anon_all_shopify_products'
       AND tablename = 'shopify_products'
  ) THEN
    CREATE POLICY anon_all_shopify_products ON shopify_products
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE shopify_products IS
  'P11-10: Shopify product catalog mirror. One row per (store, shopify_product_id). resolved_style_id pairs the row to a style_master row via auto-suggest (handle/tag) or manual override.';

NOTIFY pgrst, 'reload schema';
