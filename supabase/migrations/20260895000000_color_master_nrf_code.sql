-- color_master — NRF (National Retail Federation) standard color code.
--
-- The NRF color code is the retail-standard 3-digit color family identifier
-- (e.g. 001 White, 110 Black, 220 Brown, 600 Blue…). We store the code plus the
-- NRF standard family name for display. Populated by the AI matcher
-- (POST /api/internal/colors/nrf-suggest + the Color Master "Auto-match NRF"
-- bulk action), and editable by hand. Both nullable.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — the CI "Supabase DB push" re-runs
-- manually-applied migrations, so this must be safe to run more than once.

ALTER TABLE color_master ADD COLUMN IF NOT EXISTS nrf_code text;
ALTER TABLE color_master ADD COLUMN IF NOT EXISTS nrf_name text;

COMMENT ON COLUMN color_master.nrf_code IS 'NRF standard 3-digit color code (e.g. 110 = Black). Nullable; AI-matched or hand-entered.';
COMMENT ON COLUMN color_master.nrf_name IS 'NRF standard color family name for the nrf_code (e.g. Black). Nullable.';
