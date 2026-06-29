-- Price Lists — add brand_id for per-brand DEFAULT lists.
--
-- The pricing engine (#719/M43) already supports per-customer, per-tier and a
-- single global is_default list. This adds a brand dimension so each brand can
-- have its own "Default — <Brand>" list (brand_id set, customer_id NULL).
-- Customer lists (Ross / Burlington) span multiple brands, so brand_id stays
-- NULL on those. The one-scope CHECK (customer_id XOR customer_tier) is
-- unaffected — brand_id is an independent dimension.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE price_lists
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master(id) ON DELETE SET NULL;

COMMENT ON COLUMN price_lists.brand_id IS 'Pricing — set on a per-brand DEFAULT list (its items are that brand''s styles). NULL on customer / tier / all-brand lists.';

CREATE INDEX IF NOT EXISTS idx_price_lists_brand
  ON price_lists (entity_id, brand_id) WHERE brand_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
