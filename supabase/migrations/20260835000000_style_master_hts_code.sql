-- HTS code is STYLE-specific, not fabric-specific: the same fabric used in a
-- pant vs a jacket classifies under different HTS codes. Add an hts_code column
-- to style_master (free text, e.g. "6203.42.4011"). The AI suggester in Style
-- Master derives it from the style's Group (top/bottom/accessory) + the linked
-- base fabric's composition. fabric_codes.hts_code is being retired from the UI.

ALTER TABLE style_master ADD COLUMN IF NOT EXISTS hts_code text;

COMMENT ON COLUMN style_master.hts_code IS 'Harmonized Tariff Schedule code for this style (style-specific; AI-suggested from group + fabric composition).';
