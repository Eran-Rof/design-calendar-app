-- Per-color tagging for product images. Shopify ties each image to variants
-- (image.variant_ids) and each variant carries a Color option, so a re-hosted
-- image can be labelled with its color. The Inventory Matrix keys per-color
-- thumbnails on this column (NULL = style-level / not color-specific, e.g.
-- lifestyle shots — the matrix falls back to the style's default image).
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS color text;

CREATE INDEX IF NOT EXISTS idx_product_images_style_color
  ON product_images (style_id, color) WHERE color IS NOT NULL;
