-- Date Presets master — backfill the currently-used built-in presets as rows.
--
-- The built-in presets (MTD, YTD, This Year, Last Year, Last 30/60/90d, …) live
-- in code (src/tanda/components/dateRangeMath.ts DEFAULT_PRESETS). Operators
-- asked to also SEE and manage those current presets from the Date Presets
-- master (reorder / relabel / disable), not only ADD new ones. So we seed one
-- row per built-in here, tagged with `source_key` = the built-in's code key.
--
-- mergePresets() (dateRangeMath.ts) drops any code built-in whose key is
-- "covered" by an active master row's source_key — so the picker shows each
-- preset exactly ONCE (the editable master row wins). Delete a backfilled row
-- and its code built-in transparently reappears as the fallback.

-- Tag column so merge can dedup built-ins against their master mirror.
ALTER TABLE date_preset_master ADD COLUMN IF NOT EXISTS source_key text;

COMMENT ON COLUMN date_preset_master.source_key IS
  'When set, this row mirrors a code DEFAULT_PRESET (dateRangeMath.ts) with this key; mergePresets suppresses that built-in so it shows once. NULL = operator-added preset.';

-- Seed the current built-ins (idempotent on entity_id + source_key).
INSERT INTO date_preset_master (entity_id, label, kind, n, sort_order, is_active, source_key)
SELECT rof_entity_id(), v.label, v.kind, v.n, v.sort_order, true, v.source_key
FROM (VALUES
  ('MTD',             'mtd',              NULL::integer, 0::smallint,  'mtd'),
  ('YTD',             'ytd',              NULL,          1,            'ytd'),
  ('This Year',       'this_year',        NULL,          2,            'ty'),
  ('Last Year',       'last_year',        NULL,          3,            'ly'),
  ('TY → last month', 'ty_to_last_month', NULL,          4,            'ty_to_last_month'),
  ('Last month',      'last_month',       NULL,          5,            'last_month'),
  ('Last 30d',        'last_n_days',      30,            6,            'last_30d'),
  ('Last 60d',        'last_n_days',      60,            7,            'last_60d'),
  ('Last 90d',        'last_n_days',      90,            8,            'last_90d'),
  ('Last Quarter',    'last_quarter',     NULL,          9,            'last_quarter')
) AS v(label, kind, n, sort_order, source_key)
WHERE NOT EXISTS (
  SELECT 1 FROM date_preset_master d
  WHERE d.entity_id = rof_entity_id() AND d.source_key = v.source_key
);
