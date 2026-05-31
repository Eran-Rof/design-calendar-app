-- 20260710010000_p15_c1b_mpl_wholesale_only.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P15 C1 correction — MPL brands are WHOLESALE-ONLY.
--
-- The C1 seed (20260710000000) gave every non-PT brand separate Wholesale +
-- Ecom pools and mapped the ecom-side channels (DTC/FBA/Walmart/Faire). But the
-- two Macy's private-label brands — MPL Epic + MPL Sun & Stone — sell ONLY
-- wholesale (CEO 2026-05-31: "MPL don't need ecom" + "MPL don't need marketplace
-- either"). So they keep only their `{CODE}-WS` pool + the WHOLESALE channel map;
-- we remove the Ecom pool + the DTC/FBA/Walmart/Faire mappings the seed created.
--
-- Runs after 20260710000000 in the same push, so it deletes exactly what the
-- seed just created. Idempotent: DELETE is a no-op if the rows are already gone.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Drop the ecom-side channel mappings for the MPL brands. (Map rows must go
--    first — brand_channel_partition.partition_id is ON DELETE RESTRICT.)
DELETE FROM brand_channel_partition bcp
USING brand_master b, channel_master c
WHERE bcp.brand_id = b.id
  AND bcp.channel_id = c.id
  AND b.entity_id = rof_entity_id()
  AND b.code IN ('MPLEPIC', 'MPLSUNSTONE')
  AND c.code IN ('DTC', 'FBA', 'WALMART', 'FAIRE');

-- 2. Drop the now-unreferenced MPL Ecom partitions.
DELETE FROM inventory_partition
WHERE code IN ('MPLEPIC-EC', 'MPLSUNSTONE-EC');

-- (The WHOLESALE → MPLEPIC-WS / MPLSUNSTONE-WS mappings + the -WS pools remain.)

NOTIFY pgrst, 'reload schema';
