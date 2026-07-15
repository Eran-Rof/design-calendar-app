-- ════════════════════════════════════════════════════════════════════════════
-- 20260996000010_retailer_edi_partners.sql  (bumped from 20260996000000 to
-- resolve a duplicate-version collision with 20260996000000_fixed_asset_module;
-- additive + idempotent, so a re-apply under the new version is a no-op)
--
-- RETAILER-FACING outbound EDI (supplier → retail customer). Turns the config-
-- only edi_customer_partners shell (20260816000000_edi_customer_van.sql) into a
-- REAL trading-partner profile that can emit 856 ASN + 810 invoice + reconcile
-- 997, and links outbound retail messages into the edi_messages outbox so the
-- EXISTING transport cron (api/cron/edi-3pl-transport) sends them.
--
-- Everything is ADDITIVE + idempotent. No business data mutates. The SFTP secret
-- is stored ENCRYPTED at rest (AES-256-GCM, api/_lib/crypto.js, key =
-- VENDOR_DATA_ENCRYPTION_KEY) in edi_secret_ciphertext — NEVER plaintext, and
-- the API layer never returns it. INERT until a partner is configured with creds:
-- messages generate + queue but never transmit without a resolvable connection.
--
-- Sibling migrations: 20260990 (3PL transport), 20260995/20260997 (concurrent).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Guard: required tables must exist before we mutate.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'edi_customer_partners') THEN
    RAISE EXCEPTION 'edi_customer_partners table missing — cannot apply retailer EDI migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'edi_messages') THEN
    RAISE EXCEPTION 'edi_messages table missing — cannot apply retailer EDI migration';
  END IF;
END $$;

-- ─── 1. edi_customer_partners: full retail trading-partner + transport profile ─
ALTER TABLE edi_customer_partners
  -- Our + their envelope identity (partner_isa_qualifier/_id already exist).
  ADD COLUMN IF NOT EXISTS partner_gs_id         text,        -- their GS03 application receiver code
  ADD COLUMN IF NOT EXISTS our_isa_qualifier     text,        -- OUR ISA05 qualifier override (else edi_settings)
  ADD COLUMN IF NOT EXISTS our_isa_id            text,        -- OUR ISA06 sender override (else edi_settings.isa_sender_id)
  ADD COLUMN IF NOT EXISTS our_gs_id             text,        -- OUR GS02 sender override
  -- Outbound docs we EMIT to this retailer + per-doc segment/qualifier overrides.
  ADD COLUMN IF NOT EXISTS enabled_docs          text[]  NOT NULL DEFAULT ARRAY['856','810','997']::text[],
  ADD COLUMN IF NOT EXISTS doc_map               jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS usage_indicator       text    NOT NULL DEFAULT 'T',  -- ISA15 T=test / P=prod (cert first)
  -- SFTP transport profile (same column names as tpl_providers so the shared
  -- api/_lib/edi/transport.js resolves a partner row EXACTLY like a 3PL row).
  ADD COLUMN IF NOT EXISTS edi_protocol          text,        -- SFTP (AS2/VAN reserved)
  ADD COLUMN IF NOT EXISTS edi_endpoint          text,        -- host[:port][/dir]
  ADD COLUMN IF NOT EXISTS edi_port              integer,
  ADD COLUMN IF NOT EXISTS edi_username          text,
  ADD COLUMN IF NOT EXISTS edi_credential_ref    text,        -- legacy env-var indirection fallback
  ADD COLUMN IF NOT EXISTS edi_secret_ciphertext text,        -- AES-256-GCM(iv:tag:ct). NEVER plaintext, never returned.
  ADD COLUMN IF NOT EXISTS edi_outbound_dir      text,        -- remote dir WE upload 856/810 into
  ADD COLUMN IF NOT EXISTS edi_inbound_dir       text,        -- remote dir the retailer drops 997 into (we poll)
  ADD COLUMN IF NOT EXISTS edi_archive_dir       text,        -- remote dir we move processed inbound files into
  ADD COLUMN IF NOT EXISTS edi_poll_enabled      boolean NOT NULL DEFAULT true,  -- include in the inbound 997 poll
  ADD COLUMN IF NOT EXISTS edi_last_polled_at    timestamptz;

DO $$ BEGIN
  ALTER TABLE edi_customer_partners DROP CONSTRAINT IF EXISTS edi_customer_partners_usage_check;
  ALTER TABLE edi_customer_partners
    ADD CONSTRAINT edi_customer_partners_usage_check CHECK (usage_indicator IN ('T','P'));
EXCEPTION WHEN others THEN RAISE NOTICE 'usage_indicator check skipped: %', SQLERRM;
END $$;

COMMENT ON COLUMN edi_customer_partners.enabled_docs IS 'Outbound X12 docs we EMIT to this retailer: 856 (ASN), 810 (invoice), 997 (ack). A doc is only generated + queued when listed here AND is_active.';
COMMENT ON COLUMN edi_customer_partners.doc_map IS 'Per-doc segment/qualifier map overrides (JSONB), keyed by transaction set. e.g. {"810":{"line_id_qual":"UP","buyer_qual":"92","buyer_id":"1234"},"856":{"hierarchy":["S","O","T","I"],"man_qual":"GM","gs1_prefix":"0361234"}}. Absent keys use spec defaults.';
COMMENT ON COLUMN edi_customer_partners.usage_indicator IS 'ISA15 usage indicator: T (test — used during retailer certification) or P (production). Defaults to T so nothing emits as production until cert passes.';
COMMENT ON COLUMN edi_customer_partners.edi_secret_ciphertext IS 'AES-256-GCM ciphertext (iv:tag:ct hex, api/_lib/crypto.js, key VENDOR_DATA_ENCRYPTION_KEY) of the SFTP password OR private key. Write-only via the API; never returned.';

-- ─── 2. edi_messages: link outbound retail messages to the partner + invoice ──
ALTER TABLE edi_messages
  ADD COLUMN IF NOT EXISTS edi_customer_partner_id uuid REFERENCES edi_customer_partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ar_invoice_id           uuid;  -- source AR invoice for an 810/856 (dedupe + drill)

COMMENT ON COLUMN edi_messages.edi_customer_partner_id IS 'For OUTBOUND retail messages (856/810): the edi_customer_partners row whose SFTP connection the transport cron uses. Mutually exclusive with tpl_provider_id (3PL side).';
COMMENT ON COLUMN edi_messages.ar_invoice_id IS 'Source AR invoice that generated this outbound 810/856. Used to dedupe (one 810 + one 856 per invoice per partner) and to drill from the message log back to the invoice.';

-- Outbox scan for retail rows + dedupe of one doc per (partner, invoice, set).
CREATE INDEX IF NOT EXISTS idx_edi_messages_retail_outbox
  ON edi_messages (status, next_attempt_at)
  WHERE direction = 'outbound' AND edi_customer_partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_edi_messages_retail_dedupe
  ON edi_messages (edi_customer_partner_id, transaction_set, ar_invoice_id)
  WHERE direction = 'outbound' AND edi_customer_partner_id IS NOT NULL AND ar_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_edi_customer_partners_poll
  ON edi_customer_partners (entity_id)
  WHERE is_active AND edi_poll_enabled;

COMMIT;

NOTIFY pgrst, 'reload schema';
