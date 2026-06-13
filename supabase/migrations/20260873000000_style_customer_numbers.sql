-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Style ⇄ Customer style-number map (style_customer_numbers)
--
-- ONE base style serves MANY customers, each of whom has their OWN style number
-- for it (private-label / customer-customized goods). Recording the customer's
-- number against the base style here means we DON'T fork a whole new style_master
-- row per customer (the cause of the "thousands of lines that are really one
-- style" sprawl, e.g. RYB0981PL-BLACK-34-<customer> SKUs).
--
-- A customer PO that cites the customer's own style number resolves back to our
-- base style via this map (feeds the AI "Upload customer PO" flow + the
-- manufacturing module). Self-managing junction, mirrors style_fabric_codes.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS style_customer_numbers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES entities(id)      ON DELETE RESTRICT,
  style_id              uuid NOT NULL REFERENCES style_master(id)  ON DELETE CASCADE,
  customer_id           uuid NOT NULL REFERENCES customers(id)     ON DELETE RESTRICT,
  customer_style_number text NOT NULL,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- A customer can map at most one number per base style.
  CONSTRAINT uq_style_customer_numbers_style_customer UNIQUE (style_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_scn_style    ON style_customer_numbers (style_id);
CREATE INDEX IF NOT EXISTS idx_scn_customer ON style_customer_numbers (customer_id);
-- Reverse lookup: customer PO cites their number → find our base style.
CREATE INDEX IF NOT EXISTS idx_scn_lookup
  ON style_customer_numbers (entity_id, customer_id, lower(customer_style_number));

CREATE OR REPLACE FUNCTION style_customer_numbers_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS style_customer_numbers_touch_trg ON style_customer_numbers;
CREATE TRIGGER style_customer_numbers_touch_trg
  BEFORE UPDATE ON style_customer_numbers
  FOR EACH ROW EXECUTE FUNCTION style_customer_numbers_touch();

ALTER TABLE style_customer_numbers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_style_customer_numbers" ON style_customer_numbers;
CREATE POLICY "anon_all_style_customer_numbers" ON style_customer_numbers
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_style_customer_numbers" ON style_customer_numbers;
CREATE POLICY "auth_internal_style_customer_numbers" ON style_customer_numbers
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  style_customer_numbers IS 'Maps one base style_master style to each customer''s own style number, so customer-customized variants do not fork new style rows.';
COMMENT ON COLUMN style_customer_numbers.customer_style_number IS 'The customer''s own style/item number for our base style (as printed on their PO).';
