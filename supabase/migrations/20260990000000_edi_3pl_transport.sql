-- ════════════════════════════════════════════════════════════════════════════
-- 20260990000000_edi_3pl_transport.sql
--
-- Make the 3PL EDI connection REAL: give tpl_providers a full, config-driven
-- transport profile (SFTP now; AS2/VAN reserved) and turn edi_messages into a
-- proper outbox/inbox state machine so a cron can send queued 940s and poll +
-- stage inbound 944/945/846/997.
--
-- Everything here is ADDITIVE + idempotent. No business data mutates. Secrets
-- are stored ENCRYPTED at rest (AES-256-GCM, api/_lib/crypto.js, key =
-- VENDOR_DATA_ENCRYPTION_KEY) in edi_secret_ciphertext — NEVER plaintext, and
-- the API layer never returns it.
--
-- Prior art extended here:
--   20260833000000_wave_edi_940.sql      — edi_* config + edi_messages 940/945
--   20260840000000_tpl_inventory_sftp_pull.sql — inventory_sftp_path pull
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Guard: both tables must exist (data-safety before mutating).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tpl_providers') THEN
    RAISE EXCEPTION 'tpl_providers table missing — cannot apply EDI 3PL transport migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'edi_messages') THEN
    RAISE EXCEPTION 'edi_messages table missing — cannot apply EDI 3PL transport migration';
  END IF;
END $$;

-- ─── 1. tpl_providers: full transport + trading-partner profile ───────────────
ALTER TABLE tpl_providers
  ADD COLUMN IF NOT EXISTS edi_port              integer,     -- SFTP port (default 22 at runtime if null)
  ADD COLUMN IF NOT EXISTS edi_secret_ciphertext text,        -- AES-256-GCM(iv:tag:ct) SFTP password OR private key. NEVER plaintext.
  ADD COLUMN IF NOT EXISTS edi_outbound_dir      text,        -- remote dir WE upload 940s into (the partner's inbound)
  ADD COLUMN IF NOT EXISTS edi_inbound_dir       text,        -- remote dir the partner drops 944/945/846/997 into (we poll it)
  ADD COLUMN IF NOT EXISTS edi_archive_dir       text,        -- remote dir we move processed inbound files into (blank = leave in place)
  ADD COLUMN IF NOT EXISTS partner_isa_qualifier text,        -- their ISA05/07 qualifier (e.g. ZZ, 01, 12)
  ADD COLUMN IF NOT EXISTS partner_isa_id        text,        -- their ISA interchange ID (receiver)
  ADD COLUMN IF NOT EXISTS partner_gs_id         text,        -- their GS application receiver code (GS03)
  ADD COLUMN IF NOT EXISTS our_isa_qualifier     text,        -- OUR ISA qualifier override (else edi_settings)
  ADD COLUMN IF NOT EXISTS our_isa_id            text,        -- OUR ISA sender override (else edi_settings.isa_sender_id)
  ADD COLUMN IF NOT EXISTS our_gs_id             text,        -- OUR GS sender override (else edi_settings.gs_sender_id)
  ADD COLUMN IF NOT EXISTS enabled_doc_types     text[]  NOT NULL DEFAULT ARRAY['940','944','945','846','997']::text[],
  ADD COLUMN IF NOT EXISTS edi_poll_enabled      boolean NOT NULL DEFAULT true,   -- include this provider in the inbound poll cron
  ADD COLUMN IF NOT EXISTS edi_last_polled_at    timestamptz;

COMMENT ON COLUMN tpl_providers.edi_secret_ciphertext IS 'AES-256-GCM ciphertext (iv:tag:ct hex, api/_lib/crypto.js, key VENDOR_DATA_ENCRYPTION_KEY) of the SFTP password OR private key. Write-only via the API; never returned. Supersedes edi_credential_ref (env-var indirection), which still works as a fallback.';
COMMENT ON COLUMN tpl_providers.edi_outbound_dir IS 'Remote SFTP directory we UPLOAD outbound 940s into (the partner''s inbound drop). Falls back to the path suffix on edi_endpoint, else /.';
COMMENT ON COLUMN tpl_providers.edi_inbound_dir IS 'Remote SFTP directory the 3PL drops inbound EDI (944/945/846/997) into. The transport cron polls this; blank = no poll.';
COMMENT ON COLUMN tpl_providers.edi_archive_dir IS 'Remote SFTP directory the cron moves an inbound file into once ingested (dedupe + audit). Blank = leave the file in place (dedupe still enforced by ISA control number).';
COMMENT ON COLUMN tpl_providers.enabled_doc_types IS 'Doc types this 3PL exchanges. Outbound 940 only sends if 940 is listed; inbound files of a non-listed type are logged but not applied.';

-- ─── 2. edi_messages: outbox / inbox state machine ────────────────────────────
ALTER TABLE edi_messages
  ADD COLUMN IF NOT EXISTS attempts             integer NOT NULL DEFAULT 0,   -- transmit / apply attempts
  ADD COLUMN IF NOT EXISTS last_error           text,                          -- most recent transport/apply error
  ADD COLUMN IF NOT EXISTS file_name            text,                          -- remote file name uploaded (outbound) or fetched (inbound)
  ADD COLUMN IF NOT EXISTS next_attempt_at      timestamptz,                   -- backoff gate: cron skips queued/failed rows until now >= this
  ADD COLUMN IF NOT EXISTS group_control_number text,                          -- GS06 group control number (for 997 reconciliation)
  ADD COLUMN IF NOT EXISTS ack_status           text,                          -- outbound: pending|accepted|rejected (997 result)
  ADD COLUMN IF NOT EXISTS acked_at             timestamptz;

-- 2a. status set gains the state-machine transitions. Keep every existing value.
--     queued  → sent (uploaded ok) → acknowledged (997 accepted)
--     queued  → failed (transport error; retried until max attempts)
--     received (downloaded) → parsed → applied | staged | error
DO $$ BEGIN
  ALTER TABLE edi_messages DROP CONSTRAINT IF EXISTS edi_messages_status_check;
  ALTER TABLE edi_messages
    ADD CONSTRAINT edi_messages_status_check
    CHECK (status IN (
      'received','processed','acknowledged','error','generated','sent','queued',
      'failed','parsed','applied','staged'
    ));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'edi_messages status check rebuild skipped: %', SQLERRM;
END $$;

-- 2b. transaction_set gains 846 (inventory) + 944 (receipt advice) for 3PL inbound.
DO $$ BEGIN
  ALTER TABLE edi_messages DROP CONSTRAINT IF EXISTS edi_messages_transaction_set_check;
  ALTER TABLE edi_messages
    ADD CONSTRAINT edi_messages_transaction_set_check
    CHECK (transaction_set IN ('850','855','856','810','820','997','940','945','846','944'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'edi_messages transaction_set check rebuild skipped: %', SQLERRM;
END $$;

-- 2c. ack_status domain guard.
DO $$ BEGIN
  ALTER TABLE edi_messages DROP CONSTRAINT IF EXISTS edi_messages_ack_status_check;
  ALTER TABLE edi_messages
    ADD CONSTRAINT edi_messages_ack_status_check
    CHECK (ack_status IS NULL OR ack_status IN ('pending','accepted','rejected'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'edi_messages ack_status check rebuild skipped: %', SQLERRM;
END $$;

COMMENT ON COLUMN edi_messages.attempts IS 'Outbound: SFTP transmit attempts. Inbound: apply attempts. Cron stops retrying at MAX_ATTEMPTS (see api/_lib/edi/outbox.js) and leaves status=failed.';
COMMENT ON COLUMN edi_messages.next_attempt_at IS 'Exponential-backoff gate. The transport cron only picks up queued/failed outbound rows where next_attempt_at is null or <= now().';
COMMENT ON COLUMN edi_messages.ack_status IS 'For outbound messages awaiting a 997: pending until the partner''s 997 arrives, then accepted (AK9=A) or rejected. Reconciled by group_control_number.';

-- 2d. Indexes for the queue scan + inbound dedupe.
CREATE INDEX IF NOT EXISTS idx_edi_messages_outbox
  ON edi_messages (status, next_attempt_at)
  WHERE direction = 'outbound';
CREATE INDEX IF NOT EXISTS idx_edi_messages_dedupe
  ON edi_messages (direction, transaction_set, interchange_id);
CREATE INDEX IF NOT EXISTS idx_edi_messages_group_ctl
  ON edi_messages (group_control_number)
  WHERE group_control_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edi_messages_provider
  ON edi_messages (tpl_provider_id)
  WHERE tpl_provider_id IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
