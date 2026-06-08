-- 20260840000000_tpl_inventory_sftp_pull.sql
-- Wire the nightly SFTP pull for 3PL inventory recon: where the 3PL drops its
-- nightly on-hand file, plus dedupe bookkeeping so the cron never re-ingests the
-- same file. SFTP host/user/credential reuse the existing edi_* columns
-- (edi_endpoint host, edi_username, edi_credential_ref → env var name).

ALTER TABLE tpl_providers
  ADD COLUMN IF NOT EXISTS inventory_sftp_path     text,          -- remote dir the 3PL drops the inventory file in
  ADD COLUMN IF NOT EXISTS last_inventory_file     text,          -- filename last ingested (dedupe)
  ADD COLUMN IF NOT EXISTS last_inventory_pulled_at timestamptz;

COMMENT ON COLUMN tpl_providers.inventory_sftp_path IS 'Remote SFTP directory where this 3PL drops its nightly inventory (846/CSV). Host/user/credential come from edi_endpoint/edi_username/edi_credential_ref. Null = no auto-pull.';
