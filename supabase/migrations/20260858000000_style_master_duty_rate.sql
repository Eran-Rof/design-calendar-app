-- Style Master: capture the HTS duty rate alongside hts_code.
-- The AI HTS suggestion returns a duty_rate_pct; previously it was only pushed
-- to the HTS Master reference table. Now the style itself stores its duty rate
-- so the form's split HTS-code / duty-rate fields persist.
ALTER TABLE style_master ADD COLUMN IF NOT EXISTS duty_rate_pct numeric;
COMMENT ON COLUMN style_master.duty_rate_pct IS 'HTS duty rate % for this style (AI-suggested or manual), paired with hts_code.';

NOTIFY pgrst, 'reload schema';
