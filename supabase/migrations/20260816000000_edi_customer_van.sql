-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — EDI restructure: VAN Settings + Customer Trading Partners
--
-- EDI was vendor-only (edi_messages + erp_integrations partner rows surfaced by
-- the vendor X12 panel). This migration adds the two missing config sides so EDI
-- can be reorganised into Vendors / Customers / Settings under Master Data:
--
--   edi_settings           — per-entity VAN / interchange configuration (a
--                            singleton-ish row per entity: VAN provider + host +
--                            credentials, ISA/GS sender qualifiers + IDs, a
--                            test/prod toggle). One active row drives outbound
--                            interchange envelopes.
--   edi_customer_partners  — customer-side trading partners: which CUSTOMERS we
--                            exchange EDI with, their ISA qualifier + ID, and the
--                            X12 document sets supported (e.g. inbound 850 PO,
--                            outbound 810 invoice / 856 ASN).
--
-- SCOPE NOTE: this builds the CONFIG / STRUCTURE only. Live transaction
-- transport over the VAN (AS2 / SFTP delivery, retailer-side 850 ingest, 810/856
-- emission) is a deliberate FOLLOW-UP and is NOT implemented here. The
-- van_password_enc column is a PLACEHOLDER text field — no real secret crypto is
-- wired up yet (follow-up: encrypt at rest like vendor field-crypto).
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- edi_settings — per-entity VAN / interchange configuration.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edi_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  van_provider          text,
  van_host              text,
  van_username          text,
  -- PLACEHOLDER: stored as-is for now. NOT encrypted. Follow-up: wrap with the
  -- vendor field-crypto key before any real VAN credentials are entered.
  van_password_enc      text,
  isa_sender_qualifier  text,
  isa_sender_id         text,
  gs_sender_id          text,
  test_mode             boolean NOT NULL DEFAULT true,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_edi_settings_entity UNIQUE (entity_id)
);

CREATE OR REPLACE FUNCTION edi_settings_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS edi_settings_touch_trg ON edi_settings;
CREATE TRIGGER edi_settings_touch_trg
  BEFORE UPDATE ON edi_settings
  FOR EACH ROW EXECUTE FUNCTION edi_settings_touch();

ALTER TABLE edi_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_edi_settings" ON edi_settings;
CREATE POLICY "anon_all_edi_settings" ON edi_settings
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_edi_settings" ON edi_settings;
CREATE POLICY "auth_internal_edi_settings" ON edi_settings
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  edi_settings IS 'Tangerine per-entity EDI VAN / interchange configuration. One active row per entity drives outbound ISA/GS interchange envelopes.';
COMMENT ON COLUMN edi_settings.van_provider IS 'VAN / trading-network provider name, e.g. SPS Commerce, TrueCommerce, Cleo.';
COMMENT ON COLUMN edi_settings.van_password_enc IS 'PLACEHOLDER credential field. Currently stored as plain text. Follow-up: encrypt at rest with the vendor field-crypto key.';
COMMENT ON COLUMN edi_settings.isa_sender_qualifier IS 'Our ISA05 interchange sender ID qualifier, e.g. 01 (DUNS) or ZZ (mutually defined).';
COMMENT ON COLUMN edi_settings.isa_sender_id IS 'Our ISA06 interchange sender ID, padded to 15 chars by the envelope builder.';
COMMENT ON COLUMN edi_settings.gs_sender_id IS 'Our GS02 application sender code used in the functional group header.';
COMMENT ON COLUMN edi_settings.test_mode IS 'When true, outbound ISA15 usage indicator is T (test); false emits P (production).';

-- ─────────────────────────────────────────────────────────────────────────────
-- edi_customer_partners — customer-side trading partners (MVP config).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edi_customer_partners (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id           uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  partner_isa_qualifier text,
  partner_isa_id        text,
  supported_docs        text[] NOT NULL DEFAULT '{}',
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_edi_customer_partners_entity_customer UNIQUE (entity_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_edi_customer_partners_entity_active
  ON edi_customer_partners (entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_edi_customer_partners_customer
  ON edi_customer_partners (customer_id);

CREATE OR REPLACE FUNCTION edi_customer_partners_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS edi_customer_partners_touch_trg ON edi_customer_partners;
CREATE TRIGGER edi_customer_partners_touch_trg
  BEFORE UPDATE ON edi_customer_partners
  FOR EACH ROW EXECUTE FUNCTION edi_customer_partners_touch();

ALTER TABLE edi_customer_partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_edi_customer_partners" ON edi_customer_partners;
CREATE POLICY "anon_all_edi_customer_partners" ON edi_customer_partners
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_edi_customer_partners" ON edi_customer_partners;
CREATE POLICY "auth_internal_edi_customer_partners" ON edi_customer_partners
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  edi_customer_partners IS 'Tangerine customer-side EDI trading partners. One row per customer per entity carrying the partner ISA qualifier/ID and the supported X12 document sets. Config only; live transport is a follow-up.';
COMMENT ON COLUMN edi_customer_partners.customer_id IS 'FK to customers.id. The partner is displayed by customer NAME; the uuid is never surfaced.';
COMMENT ON COLUMN edi_customer_partners.partner_isa_qualifier IS 'Partner ISA07 interchange receiver ID qualifier, e.g. 01 or ZZ.';
COMMENT ON COLUMN edi_customer_partners.partner_isa_id IS 'Partner ISA08 interchange receiver ID.';
COMMENT ON COLUMN edi_customer_partners.supported_docs IS 'X12 transaction sets exchanged with this customer, e.g. {850,810,856}. Planned flows: inbound 850 PO, outbound 810 invoice / 856 ASN.';
