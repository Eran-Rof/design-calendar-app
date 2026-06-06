-- ════════════════════════════════════════════════════════════════════════════
-- P21 follow-up — Wave a Sales Order to a 3PL via EDI 940 (Warehouse Shipping
-- Order) + 945 (Warehouse Shipping Advice) return path.
--
-- "Waving" releases an allocated sales order to the contract 3PL that holds our
-- stock: we create an OUTBOUND tpl_shipment from the SO's allocated lines and
-- emit an X12 940 instructing the warehouse to pick/pack/ship. The 3PL later
-- returns a 945 confirming what shipped + tracking, which advances the
-- tpl_shipment to shipped.
--
-- This migration is ADDITIVE and backward-compatible:
--   1. sales_orders         + waved_at / waved_tpl_provider_id (timestamp-based;
--                             no new status enum value — the status set already
--                             carries fulfilling/shipped which a wave precedes).
--   2. tpl_providers         + EDI connection config (protocol/endpoint/username/
--                             credential_ref). Live transport is gated on these
--                             being populated; until then 940s generate + queue.
--   3. tpl_shipments         + status 'released' (940 sent, awaiting 945) and a
--                             tracking_number/ship advice already exist.
--   4. edi_messages          relaxed to carry warehouse 940/945 transactions:
--                             transaction_set gains '940'/'945', status gains
--                             'generated'/'sent'/'queued', vendor_id made
--                             NULLABLE (940/945 are 3PL-bound, not vendor-bound),
--                             + tpl_shipment_id / sales_order_id link columns.
--
-- Existing vendor EDI flows (850/820/855/856/810/997) are unaffected.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. sales_orders: wave markers ───────────────────────────────────────────
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS waved_at             timestamptz,
  ADD COLUMN IF NOT EXISTS waved_tpl_provider_id uuid REFERENCES tpl_providers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_waved ON sales_orders (waved_at) WHERE waved_at IS NOT NULL;

COMMENT ON COLUMN sales_orders.waved_at IS 'Set when the SO is released (waved) to a 3PL via EDI 940. Null = not yet waved. A timestamp rather than a status enum value so the existing draft→…→shipped lifecycle is untouched.';
COMMENT ON COLUMN sales_orders.waved_tpl_provider_id IS 'The 3PL provider the SO was waved to. FK to tpl_providers; surfaced by provider name, never the uuid.';

-- ─── 2. tpl_providers: EDI connection config ─────────────────────────────────
ALTER TABLE tpl_providers
  ADD COLUMN IF NOT EXISTS edi_protocol      text,   -- 'SFTP' | 'AS2' | 'VAN' | null (none configured)
  ADD COLUMN IF NOT EXISTS edi_endpoint      text,   -- host[:port]/path (SFTP) or AS2 URL
  ADD COLUMN IF NOT EXISTS edi_username      text,
  ADD COLUMN IF NOT EXISTS edi_credential_ref text;  -- name of an env var / secret-manager ref holding the SFTP key / AS2 cert / VAN password. NEVER the secret itself.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_tpl_providers_edi_protocol'
  ) THEN
    ALTER TABLE tpl_providers
      ADD CONSTRAINT chk_tpl_providers_edi_protocol
      CHECK (edi_protocol IS NULL OR edi_protocol IN ('SFTP','AS2','VAN'));
  END IF;
END $$;

COMMENT ON COLUMN tpl_providers.edi_protocol IS 'Transport protocol for outbound 940 delivery: SFTP, AS2, or VAN. Null = no EDI transport configured (940s generate + queue, never transmit).';
COMMENT ON COLUMN tpl_providers.edi_endpoint IS 'SFTP host[:port] + remote path, or AS2/VAN endpoint URL. Operator-provided per the 3PL onboarding doc.';
COMMENT ON COLUMN tpl_providers.edi_credential_ref IS 'NAME of the env var / secret reference holding the SFTP private key, AS2 cert, or VAN password — never the secret value itself.';

-- ─── 3. tpl_shipments: 'released' status (940 sent, awaiting 945) ─────────────
DO $$ BEGIN
  -- Rebuild the status CHECK to add 'released'. Idempotent: drop + recreate.
  ALTER TABLE tpl_shipments DROP CONSTRAINT IF EXISTS tpl_shipments_status_check;
  ALTER TABLE tpl_shipments
    ADD CONSTRAINT tpl_shipments_status_check
    CHECK (status IN ('draft','released','in_transit','received','shipped','closed','cancelled'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'tpl_shipments status check rebuild skipped: %', SQLERRM;
END $$;

ALTER TABLE tpl_shipments
  ADD COLUMN IF NOT EXISTS waved_at timestamptz;  -- when the 940 was generated for this shipment

COMMENT ON COLUMN tpl_shipments.status IS 'draft → released (940 sent) → in_transit/shipped (945 received) → received/closed. cancelled at any point.';

-- ─── 4. edi_messages: carry warehouse 940/945 transactions ───────────────────
-- Assert the table exists before mutating (financial/data safety).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'edi_messages') THEN
    RAISE EXCEPTION 'edi_messages table missing — cannot apply 940/945 extension';
  END IF;
END $$;

-- 4a. vendor_id nullable (940/945 are 3PL-bound, not vendor-bound).
ALTER TABLE edi_messages ALTER COLUMN vendor_id DROP NOT NULL;

-- 4b. transaction_set gains 940/945; status gains generated/sent/queued.
DO $$ BEGIN
  ALTER TABLE edi_messages DROP CONSTRAINT IF EXISTS edi_messages_transaction_set_check;
  ALTER TABLE edi_messages
    ADD CONSTRAINT edi_messages_transaction_set_check
    CHECK (transaction_set IN ('850','855','856','810','820','997','940','945'));

  ALTER TABLE edi_messages DROP CONSTRAINT IF EXISTS edi_messages_status_check;
  ALTER TABLE edi_messages
    ADD CONSTRAINT edi_messages_status_check
    CHECK (status IN ('received','processed','acknowledged','error','generated','sent','queued'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'edi_messages check rebuild skipped: %', SQLERRM;
END $$;

-- 4c. link columns to the 3PL shipment + sales order this message concerns.
ALTER TABLE edi_messages
  ADD COLUMN IF NOT EXISTS tpl_shipment_id uuid REFERENCES tpl_shipments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sales_order_id  uuid REFERENCES sales_orders(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tpl_provider_id uuid REFERENCES tpl_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transmitted     boolean,
  ADD COLUMN IF NOT EXISTS transport_detail text;

CREATE INDEX IF NOT EXISTS idx_edi_messages_tpl_shipment ON edi_messages (tpl_shipment_id) WHERE tpl_shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edi_messages_so           ON edi_messages (sales_order_id)  WHERE sales_order_id  IS NOT NULL;

COMMENT ON COLUMN edi_messages.tpl_shipment_id IS 'For 940/945 warehouse messages: the tpl_shipment this message instructs (940) or confirms (945).';
COMMENT ON COLUMN edi_messages.sales_order_id IS 'For 940 messages: the waved sales order this warehouse shipping order fulfills.';
COMMENT ON COLUMN edi_messages.transmitted IS 'Whether the outbound message was actually delivered to the partner (true) or stored + queued pending transport config (false/null).';
COMMENT ON COLUMN edi_messages.transport_detail IS 'Human-readable transport outcome, e.g. "SFTP upload OK to host/path" or "queued: no edi_protocol configured on provider".';

COMMIT;

NOTIFY pgrst, 'reload schema';
