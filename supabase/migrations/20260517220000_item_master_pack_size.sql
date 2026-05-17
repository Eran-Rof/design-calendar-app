-- Add pack_size column to ip_item_master — authoritative units-per-pack
-- for prepack SKUs. Replaces the regex-on-text-fields approach used by
-- ppkMultiplier() in src/shared/prepack/index.ts which had been
-- producing both false positives (stray "PPKn" tokens on non-prepack
-- variants triggering 60x qty inflation in sales reports) and false
-- negatives (legacy prepack styles like RCB1510NPT where the prepack
-- token sits in the size column but neither sku nor style carries it).
--
-- Default 1 = non-prepack. Backfill (below) populates pack_size only
-- from CLEAN signals — i.e. sku_code or style_code explicitly carrying
-- a "PPKn" suffix. This captures the pre-#139 strict-gate behavior
-- accurately in structured data.
--
-- The legacy "prepack-via-size-column" case (RCB1510NPT etc.) is NOT
-- backfilled here — it requires authoritative pack-quantity data from
-- Xoro's master, which lands via the rof_xoro_project normalizer
-- (separate repo). Tracking that as the follow-up to this migration.

ALTER TABLE ip_item_master
  ADD COLUMN IF NOT EXISTS pack_size integer NOT NULL DEFAULT 1
    CHECK (pack_size >= 1);

COMMENT ON COLUMN ip_item_master.pack_size IS
  'Units per pack for prepack SKUs (1 = non-prepack). Authoritative — '
  'populated by the Xoro item-master sync. Consumers should prefer '
  'this over the text-regex ppkMultiplier() helper.';

-- Backfill from sku_code, style_code, AND size columns per planner —
-- catches both modern PPK-suffixed SKUs ("RCB1258-PPK", "RYB0412PPK24")
-- and legacy styles where the prepack token sits in the size column
-- ("PPK18", "PPK24") rather than the style name (e.g. RCB1510NPT).
-- Priority: sku → style → size (matches the historical
-- ppkMultiplier() resolution order). Description / color are skipped
-- because they're free text and historically carry stray PPK tokens
-- (cross-ref notes, leakage) on rows that aren't actually prepacks.
--
-- Operator should audit the resulting pack_size values once after this
-- migration runs:
--   SELECT sku_code, style_code, size, pack_size FROM ip_item_master
--   WHERE pack_size > 1 ORDER BY sku_code;
-- and correct any false positives via targeted UPDATE statements. The
-- long-term plan is for rof_xoro_project's nightly normalizer to
-- overwrite pack_size with Xoro's authoritative pack-quantity field
-- on each run, eliminating regex-derived drift entirely.
UPDATE ip_item_master
SET pack_size = (
  COALESCE(
    NULLIF(substring(sku_code FROM 'PPK(\d+)'), '')::integer,
    NULLIF(substring(style_code FROM 'PPK(\d+)'), '')::integer,
    NULLIF(substring(size FROM 'PPK(\d+)'), '')::integer,
    1
  )
)
WHERE pack_size = 1
  AND (
    sku_code   ~* 'PPK\d+' OR
    style_code ~* 'PPK\d+' OR
    size       ~* 'PPK\d+'
  );

CREATE INDEX IF NOT EXISTS idx_ip_item_master_pack_size
  ON ip_item_master (pack_size) WHERE pack_size > 1;

COMMENT ON INDEX idx_ip_item_master_pack_size IS
  'Partial index — only the ~few hundred prepack rows. Used by reports '
  'that want to enumerate prepack SKUs without scanning the full master.';
