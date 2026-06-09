-- Seed non-apparel vendors referenced in Xoro AP bills so nightly
-- rest_ap_sync.py can resolve them via vendors.name and land the bills.
--
-- Also trims a trailing space from the existing Weihai Lianqiao row
-- that was preventing the ilike name-match from finding it.

-- Fix trailing-space on existing Weihai row
UPDATE vendors
SET name = TRIM(name), updated_at = now()
WHERE name = 'Weihai Lianqiao International ';

-- Insert missing non-apparel vendors. Guard with NOT EXISTS against the
-- partial case-insensitive unique index (idx_vendors_name_ci_active).
INSERT INTO vendors (name, status)
SELECT v.name, 'active'
FROM (VALUES
  ('GPA Logistics Group Inc.'),
  ('eBay'),
  ('Blue Shield CA'),
  ('DAMIAN VALENCIA'),
  ('Health First New York'),
  ('Meta Platforms, Inc. - Ads')
) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM vendors
  WHERE lower(vendors.name) = lower(v.name)
    AND deleted_at IS NULL
);
