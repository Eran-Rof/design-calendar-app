-- 20260521010000_ip_ats_avg_cost.sql
--
-- Materialize the ATS avg-cost slice out of `app_data['ats_excel_data']`
-- into a narrow, indexed table so the planning grid stops reading a
-- 7.4 MB JSONB blob just to look up cost per SKU.
--
-- Context:
--   wholesalePlanningRepository.ts::listAtsAvgCostBySku() was pulling the
--   entire ats_excel_data row on every forecast build, then iterating
--   skus[] to build a Map keyed by raw `sku` (e.g. "RYA1408 - Black").
--   The grid then looked it up by `item.sku_code` ("RYA1408-BLACK"),
--   so the Map missed every entry — the read had been doing nothing
--   useful for who knows how long. This table fixes BOTH the IO drag
--   and the silent-miss bug by canonicalizing keys on write.
--
-- Schema mirrors ip_item_avg_cost minus the source/source_ref columns —
-- the source for this table is always the ATS upload, no point
-- recording it per-row.

CREATE TABLE IF NOT EXISTS ip_ats_avg_cost (
  sku_code   text PRIMARY KEY,
  avg_cost   numeric NOT NULL CHECK (avg_cost >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ip_ats_avg_cost_updated_at_idx
  ON ip_ats_avg_cost (updated_at DESC);

-- Phase 0 anon-permissive RLS to match the rest of the planning tables.
ALTER TABLE ip_ats_avg_cost ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_ip_ats_avg_cost" ON ip_ats_avg_cost;
CREATE POLICY "anon_all_ip_ats_avg_cost" ON ip_ats_avg_cost
  FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ip_ats_avg_cost TO anon;

-- One-time backfill from the current ats_excel_data blob. As of this
-- migration the value is raw JSON (not yet the {"_gz":"..."} envelope),
-- so a SQL-side jsonb_array_elements pass can extract skus[] directly.
-- The canon transform mirrors src/inventory-planning/utils/skuCanon.ts:
-- trim + upper + strip spaces. Multiple raw SKUs in the blob can
-- collapse to the same canonical key (e.g., "RYA1408-Black" and
-- "RYA1408 - Black"), so the inner subquery aggregates with max() to
-- pick a deterministic avg_cost per canonical sku_code — otherwise the
-- ON CONFLICT clause raises "cannot affect row a second time".
--
-- If the blob is missing or in a shape we can't parse from SQL (e.g.,
-- gzip envelope), the backfill is a no-op and the next ATS upload
-- populates the table.
DO $$
BEGIN
  INSERT INTO ip_ats_avg_cost (sku_code, avg_cost)
  SELECT sku_code, max(avg_cost) AS avg_cost
  FROM (
    SELECT
      upper(replace(trim(sku->>'sku'), ' ', '')) AS sku_code,
      (sku->>'avgCost')::numeric AS avg_cost
    FROM app_data, jsonb_array_elements((value::jsonb)->'skus') AS sku
    WHERE key = 'ats_excel_data'
      AND sku->>'sku' IS NOT NULL
      AND length(trim(sku->>'sku')) > 0
      AND (sku->>'avgCost') ~ '^[0-9]+(\.[0-9]+)?$'
      AND (sku->>'avgCost')::numeric > 0
  ) s
  GROUP BY sku_code
  ON CONFLICT (sku_code) DO UPDATE
    SET avg_cost = EXCLUDED.avg_cost, updated_at = now();
EXCEPTION WHEN OTHERS THEN
  -- Blob is gzip-enveloped or otherwise un-parseable from SQL.
  -- Table stays empty; next ATS upload populates it.
  NULL;
END $$;
