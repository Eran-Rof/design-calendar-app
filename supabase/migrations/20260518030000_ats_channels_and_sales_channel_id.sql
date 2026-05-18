-- Seed the three ATS channels (ROF wholesale, ROF ECOM, PT) and
-- prepare ip_sales_history_wholesale for the export's store filter.
--
-- Background: the ATS UI has had a store dropdown (ROF / ROF ECOM /
-- PT) for a while, but it only filtered the IN-GRID rows. Sales
-- history pulled from ip_sales_history_wholesale was never narrowed
-- by store, so the export's T3 / LY totals always summed ALL stores'
-- contributions for each visible SKU. Result: when the operator
-- filtered to "ROF ECOM" only, the total still showed ~$3.5M (ROF
-- wholesale bleeding in) when actual ROF ECOM YTD is ~$150k.
--
-- The schema already has channel_id FK on the sales row, but the
-- nightly sync handler always wrote NULL because no production
-- channel rows existed. This migration creates them.
--
-- Sync handler update (separate file, same PR) resolves the raw
-- "Sale Store" CSV column to the right channel_id on every UPSERT.
-- Going-forward rows from the next nightly run carry channel_id;
-- historical NULL rows stay NULL until re-synced.

BEGIN;

INSERT INTO ip_channel_master (channel_code, name, channel_type, active)
VALUES
  ('ROF',      'Ring of Fire — Wholesale', 'wholesale', true),
  ('ROF ECOM', 'Ring of Fire — Ecom',      'ecom',      true),
  ('PT',       'Psycho Tuna',              'wholesale', true)
ON CONFLICT (channel_code) DO UPDATE
  SET name = EXCLUDED.name,
      channel_type = EXCLUDED.channel_type,
      active = EXCLUDED.active;

-- Index the (channel_id, txn_date) tuple so the export's
-- per-channel + date-window query stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_ip_sales_wholesale_channel_date
  ON ip_sales_history_wholesale (channel_id, txn_date)
  WHERE channel_id IS NOT NULL;

COMMIT;
