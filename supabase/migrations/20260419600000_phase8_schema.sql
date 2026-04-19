-- 20260419600000_phase8_schema.sql
--
-- Phase 8 — multi-entity support, workflow rules, RFQ/quote flow,
-- and mobile session tracking.
--
-- Design notes:
--   • 'internal user' references are TEXT (not FK) because internal
--     users live in app_data['users'] — same precedent as prior phases.
--   • A default Entity is seeded so existing data (POs, invoices,
--     vendors) can be associated as the platform adopts multi-tenancy
--     gradually. New RFQ/WorkflowRule rows require entity_id.
--   • RFQAttachment uses the Postgres-native "one of two FK" pattern
--     via a CHECK constraint, not a polymorphic uuid column — keeps
--     referential integrity real.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. entities
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_entity_id  uuid REFERENCES entities(id) ON DELETE RESTRICT,
  name              text NOT NULL,
  slug              text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_parent ON entities (parent_entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities (status);

-- Seed the default Ring of Fire entity if none exists so the tenancy
-- layer can be adopted without forcing a pre-migration data fix.
INSERT INTO entities (name, slug, status)
  SELECT 'Ring of Fire', 'ring-of-fire', 'active'
  WHERE NOT EXISTS (SELECT 1 FROM entities LIMIT 1);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. entity_branding
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entity_branding (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 uuid NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  logo_url                  text,
  primary_color             text,
  secondary_color           text,
  favicon_url               text,
  company_display_name      text,
  portal_welcome_message    text,
  email_from_name           text,
  email_from_address        text,
  custom_domain             text,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_branding_domain ON entity_branding (custom_domain) WHERE custom_domain IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. entity_vendors (junction)
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entity_vendors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  vendor_id             uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  relationship_status   text NOT NULL DEFAULT 'active' CHECK (relationship_status IN ('active', 'suspended', 'terminated')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_vendors ON entity_vendors (entity_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_entity_vendors_vendor ON entity_vendors (vendor_id);
CREATE INDEX IF NOT EXISTS idx_entity_vendors_status ON entity_vendors (relationship_status);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. workflow_rules
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS workflow_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name            text NOT NULL,
  trigger_event   text NOT NULL CHECK (trigger_event IN ('po_issued', 'invoice_submitted', 'shipment_created', 'compliance_expired', 'dispute_opened', 'anomaly_detected')),
  conditions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_rules_entity_event ON workflow_rules (entity_id, trigger_event) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_workflow_rules_active ON workflow_rules (is_active);

-- ══════════════════════════════════════════════════════════════════════════
-- 5. workflow_executions
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS workflow_executions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id               uuid NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
  entity_id             uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  trigger_entity_type   text NOT NULL,
  trigger_entity_id     uuid,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto_approved', 'skipped')),
  current_approver      text,
  approved_by           text,
  rejected_by           text,
  rejection_reason      text,
  triggered_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  metadata              jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_rule_id ON workflow_executions (rule_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_entity  ON workflow_executions (entity_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_status  ON workflow_executions (status);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_trigger ON workflow_executions (trigger_entity_type, trigger_entity_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 6. rfqs
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rfqs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  title                   text NOT NULL,
  description             text,
  category                text,
  status                  text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'awarded')),
  submission_deadline     timestamptz,
  delivery_required_by    date,
  estimated_quantity      integer,
  estimated_budget        numeric,
  currency                text NOT NULL DEFAULT 'USD',
  created_by              text,
  awarded_to_vendor_id    uuid REFERENCES vendors(id) ON DELETE SET NULL,
  awarded_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfqs_entity_id  ON rfqs (entity_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_status     ON rfqs (status);
CREATE INDEX IF NOT EXISTS idx_rfqs_category   ON rfqs (category);
CREATE INDEX IF NOT EXISTS idx_rfqs_deadline   ON rfqs (submission_deadline) WHERE status IN ('draft', 'published');
CREATE INDEX IF NOT EXISTS idx_rfqs_awarded_to ON rfqs (awarded_to_vendor_id) WHERE awarded_to_vendor_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 7. rfq_line_items
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rfq_line_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id            uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  line_index        integer NOT NULL DEFAULT 1,
  description       text NOT NULL,
  quantity          integer NOT NULL,
  unit_of_measure   text,
  specifications    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfq_line_items_rfq_id ON rfq_line_items (rfq_id, line_index);

-- ══════════════════════════════════════════════════════════════════════════
-- 8. rfq_invitations
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rfq_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id   uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'viewed', 'submitted', 'declined')),
  invited_at  timestamptz NOT NULL DEFAULT now(),
  viewed_at   timestamptz,
  declined_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rfq_invitations ON rfq_invitations (rfq_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_rfq_invitations_vendor ON rfq_invitations (vendor_id);
CREATE INDEX IF NOT EXISTS idx_rfq_invitations_status ON rfq_invitations (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 9. rfq_quotes
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rfq_quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id          uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id       uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'awarded', 'rejected')),
  total_price     numeric,
  lead_time_days  integer,
  valid_until     date,
  notes           text,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rfq_quotes_rfq_vendor ON rfq_quotes (rfq_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_rfq_quotes_vendor ON rfq_quotes (vendor_id);
CREATE INDEX IF NOT EXISTS idx_rfq_quotes_status ON rfq_quotes (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 10. rfq_quote_lines
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rfq_quote_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            uuid NOT NULL REFERENCES rfq_quotes(id) ON DELETE CASCADE,
  rfq_line_item_id    uuid NOT NULL REFERENCES rfq_line_items(id) ON DELETE CASCADE,
  unit_price          numeric,
  quantity            integer,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rfq_quote_lines ON rfq_quote_lines (quote_id, rfq_line_item_id);
CREATE INDEX IF NOT EXISTS idx_rfq_quote_lines_rfq_line ON rfq_quote_lines (rfq_line_item_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 11. rfq_attachments — either attached to the RFQ or to a quote
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rfq_attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id              uuid REFERENCES rfqs(id) ON DELETE CASCADE,
  quote_id            uuid REFERENCES rfq_quotes(id) ON DELETE CASCADE,
  file_url            text NOT NULL,
  file_name           text NOT NULL,
  file_size_bytes     bigint,
  uploaded_by_type    text NOT NULL CHECK (uploaded_by_type IN ('internal', 'vendor')),
  uploaded_by         text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_rfq_attachment_target CHECK ((rfq_id IS NOT NULL)::int + (quote_id IS NOT NULL)::int = 1)
);

CREATE INDEX IF NOT EXISTS idx_rfq_attachments_rfq    ON rfq_attachments (rfq_id)   WHERE rfq_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rfq_attachments_quote  ON rfq_attachments (quote_id) WHERE quote_id IS NOT NULL;

-- Storage bucket for RFQ attachments
INSERT INTO storage.buckets (id, name, public) VALUES ('rfq-attachments', 'rfq-attachments', false)
  ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- 12. mobile_sessions
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mobile_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_user_id    uuid NOT NULL REFERENCES vendor_users(id) ON DELETE CASCADE,
  device_token      text NOT NULL,
  platform          text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version       text,
  last_active_at    timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_sessions_token ON mobile_sessions (device_token);
CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user ON mobile_sessions (vendor_user_id, last_active_at DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 13. push_notifications
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS push_notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_user_id      uuid NOT NULL REFERENCES vendor_users(id) ON DELETE CASCADE,
  mobile_session_id   uuid REFERENCES mobile_sessions(id) ON DELETE SET NULL,
  title               text NOT NULL,
  body                text,
  data                jsonb,
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_user   ON push_notifications (vendor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_notifications_status ON push_notifications (status);

-- ══════════════════════════════════════════════════════════════════════════
-- RLS — enable + policies
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE entities             ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_branding      ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_vendors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfqs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_line_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_invitations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_quotes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_quote_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_attachments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notifications   ENABLE ROW LEVEL SECURITY;

-- ── entities — vendor reads entities they're linked to via entity_vendors
DROP POLICY IF EXISTS "anon_all_entities" ON entities;
CREATE POLICY "anon_all_entities" ON entities FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_linked_entities_select" ON entities;
CREATE POLICY "vendor_linked_entities_select" ON entities FOR SELECT TO authenticated
  USING (id IN (SELECT ev.entity_id FROM entity_vendors ev JOIN vendor_users vu ON vu.vendor_id = ev.vendor_id WHERE vu.auth_id = auth.uid()));

-- ── entity_branding — readable by vendor for entities they're linked to (to render branding)
DROP POLICY IF EXISTS "anon_all_entity_branding" ON entity_branding;
CREATE POLICY "anon_all_entity_branding" ON entity_branding FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_linked_entity_branding_select" ON entity_branding;
CREATE POLICY "vendor_linked_entity_branding_select" ON entity_branding FOR SELECT TO authenticated
  USING (entity_id IN (SELECT ev.entity_id FROM entity_vendors ev JOIN vendor_users vu ON vu.vendor_id = ev.vendor_id WHERE vu.auth_id = auth.uid()));

-- ── entity_vendors — vendor sees their own memberships
DROP POLICY IF EXISTS "anon_all_entity_vendors" ON entity_vendors;
CREATE POLICY "anon_all_entity_vendors" ON entity_vendors FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_entity_vendors_select" ON entity_vendors;
CREATE POLICY "vendor_own_entity_vendors_select" ON entity_vendors FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── workflow_rules / workflow_executions — INTERNAL ONLY
DROP POLICY IF EXISTS "anon_all_workflow_rules" ON workflow_rules;
CREATE POLICY "anon_all_workflow_rules" ON workflow_rules FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_workflow_executions" ON workflow_executions;
CREATE POLICY "anon_all_workflow_executions" ON workflow_executions FOR ALL TO anon USING (true) WITH CHECK (true);
-- (no authenticated policies — vendors can't see workflow state)

-- ── rfqs — vendors see RFQs they're invited to or have quoted
DROP POLICY IF EXISTS "anon_all_rfqs" ON rfqs;
CREATE POLICY "anon_all_rfqs" ON rfqs FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_invited_rfqs_select" ON rfqs;
CREATE POLICY "vendor_invited_rfqs_select" ON rfqs FOR SELECT TO authenticated
  USING (id IN (
    SELECT rfq_id FROM rfq_invitations WHERE vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  ));

-- ── rfq_line_items — inherits from RFQ access
DROP POLICY IF EXISTS "anon_all_rfq_line_items" ON rfq_line_items;
CREATE POLICY "anon_all_rfq_line_items" ON rfq_line_items FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_rfq_line_items_select" ON rfq_line_items;
CREATE POLICY "vendor_rfq_line_items_select" ON rfq_line_items FOR SELECT TO authenticated
  USING (rfq_id IN (
    SELECT rfq_id FROM rfq_invitations WHERE vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  ));

-- ── rfq_invitations — vendor sees their own
DROP POLICY IF EXISTS "anon_all_rfq_invitations" ON rfq_invitations;
CREATE POLICY "anon_all_rfq_invitations" ON rfq_invitations FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_rfq_invitations_select" ON rfq_invitations;
CREATE POLICY "vendor_own_rfq_invitations_select" ON rfq_invitations FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_rfq_invitations_update" ON rfq_invitations;
CREATE POLICY "vendor_own_rfq_invitations_update" ON rfq_invitations FOR UPDATE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── rfq_quotes — vendor CRUD their own
DROP POLICY IF EXISTS "anon_all_rfq_quotes" ON rfq_quotes;
CREATE POLICY "anon_all_rfq_quotes" ON rfq_quotes FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_rfq_quotes_select" ON rfq_quotes;
CREATE POLICY "vendor_own_rfq_quotes_select" ON rfq_quotes FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_rfq_quotes_insert" ON rfq_quotes;
CREATE POLICY "vendor_own_rfq_quotes_insert" ON rfq_quotes FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_rfq_quotes_update" ON rfq_quotes;
CREATE POLICY "vendor_own_rfq_quotes_update" ON rfq_quotes FOR UPDATE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── rfq_quote_lines — inherit from quote
DROP POLICY IF EXISTS "anon_all_rfq_quote_lines" ON rfq_quote_lines;
CREATE POLICY "anon_all_rfq_quote_lines" ON rfq_quote_lines FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_rfq_quote_lines_select" ON rfq_quote_lines;
CREATE POLICY "vendor_own_rfq_quote_lines_select" ON rfq_quote_lines FOR SELECT TO authenticated
  USING (quote_id IN (SELECT id FROM rfq_quotes WHERE vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));
DROP POLICY IF EXISTS "vendor_own_rfq_quote_lines_insert" ON rfq_quote_lines;
CREATE POLICY "vendor_own_rfq_quote_lines_insert" ON rfq_quote_lines FOR INSERT TO authenticated
  WITH CHECK (quote_id IN (SELECT id FROM rfq_quotes WHERE vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));

-- ── rfq_attachments — vendor sees attachments on their quotes or RFQs they're invited to
DROP POLICY IF EXISTS "anon_all_rfq_attachments" ON rfq_attachments;
CREATE POLICY "anon_all_rfq_attachments" ON rfq_attachments FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_rfq_attachments_select" ON rfq_attachments;
CREATE POLICY "vendor_rfq_attachments_select" ON rfq_attachments FOR SELECT TO authenticated
  USING (
    rfq_id IN (SELECT rfq_id FROM rfq_invitations WHERE vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
    OR quote_id IN (SELECT id FROM rfq_quotes WHERE vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  );

-- ── mobile_sessions — vendor_user CRUD their own
DROP POLICY IF EXISTS "anon_all_mobile_sessions" ON mobile_sessions;
CREATE POLICY "anon_all_mobile_sessions" ON mobile_sessions FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_mobile_sessions_select" ON mobile_sessions;
CREATE POLICY "vendor_own_mobile_sessions_select" ON mobile_sessions FOR SELECT TO authenticated
  USING (vendor_user_id IN (SELECT id FROM vendor_users WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_mobile_sessions_insert" ON mobile_sessions;
CREATE POLICY "vendor_own_mobile_sessions_insert" ON mobile_sessions FOR INSERT TO authenticated
  WITH CHECK (vendor_user_id IN (SELECT id FROM vendor_users WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_mobile_sessions_update" ON mobile_sessions;
CREATE POLICY "vendor_own_mobile_sessions_update" ON mobile_sessions FOR UPDATE TO authenticated
  USING (vendor_user_id IN (SELECT id FROM vendor_users WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_mobile_sessions_delete" ON mobile_sessions;
CREATE POLICY "vendor_own_mobile_sessions_delete" ON mobile_sessions FOR DELETE TO authenticated
  USING (vendor_user_id IN (SELECT id FROM vendor_users WHERE auth_id = auth.uid()));

-- ── push_notifications — vendor_user reads their own
DROP POLICY IF EXISTS "anon_all_push_notifications" ON push_notifications;
CREATE POLICY "anon_all_push_notifications" ON push_notifications FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_push_notifications_select" ON push_notifications;
CREATE POLICY "vendor_own_push_notifications_select" ON push_notifications FOR SELECT TO authenticated
  USING (vendor_user_id IN (SELECT id FROM vendor_users WHERE auth_id = auth.uid()));
