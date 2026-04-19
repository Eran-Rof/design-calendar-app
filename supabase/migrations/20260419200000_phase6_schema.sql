-- 20260419200000_phase6_schema.sql
--
-- Phase 6 — onboarding workflows, banking, ERP/EDI, anomaly flags,
-- forecasting, vendor health, preferred-vendor ranking.
--
-- Design notes:
--   • 'internal user' references are TEXT (not FK) because internal users
--     live in app_data['users'], not auth.users — same pattern as
--     compliance_documents.reviewed_by and vendor_notes.created_by.
--   • AES-256 encryption for banking_details and erp_integrations.config
--     happens at the application layer (Vercel API). This schema only
--     stores the ciphertext; rotation is handled by re-encrypting from
--     the API.
--   • All vendor-scoped tables use the standard RLS pattern:
--     anon-permissive (for the same-origin service_role proxy) +
--     authenticated-scoped via vendor_users.auth_id = auth.uid().
--   • Tables that are INTERNAL ONLY (preferred_vendors, spend_forecasts)
--     have no authenticated policy — vendor JWTs return zero rows even
--     though RLS is permissive for anon.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. onboarding_workflows
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS onboarding_workflows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'pending_review', 'approved', 'rejected')),
  current_step        integer NOT NULL DEFAULT 0,
  completed_steps     jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at          timestamptz,
  completed_at        timestamptz,
  approved_by         text,
  rejection_reason    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_workflows_vendor ON onboarding_workflows (vendor_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_workflows_status ON onboarding_workflows (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. onboarding_steps
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS onboarding_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     uuid NOT NULL REFERENCES onboarding_workflows(id) ON DELETE CASCADE,
  step_name       text NOT NULL CHECK (step_name IN ('company_info', 'banking', 'tax', 'compliance_docs', 'portal_tour', 'agreement')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'skipped')),
  data            jsonb,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_steps_workflow_step ON onboarding_steps (workflow_id, step_name);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_workflow_id ON onboarding_steps (workflow_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. banking_details
-- ══════════════════════════════════════════════════════════════════════════
-- account_number_encrypted and routing_number_encrypted hold AES-256-GCM
-- ciphertext produced by the API layer. Format: "{iv_hex}:{tag_hex}:{ct_hex}".
CREATE TABLE IF NOT EXISTS banking_details (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id                       uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  account_name                    text NOT NULL,
  bank_name                       text NOT NULL,
  account_number_encrypted        text NOT NULL,
  account_number_last4            text,
  routing_number_encrypted        text NOT NULL,
  account_type                    text NOT NULL CHECK (account_type IN ('checking', 'savings', 'wire')),
  currency                        text NOT NULL DEFAULT 'USD',
  verified                        boolean NOT NULL DEFAULT false,
  verified_at                     timestamptz,
  verified_by                     text,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_banking_details_vendor_id ON banking_details (vendor_id);
CREATE INDEX IF NOT EXISTS idx_banking_details_verified  ON banking_details (verified);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. erp_integrations
-- ══════════════════════════════════════════════════════════════════════════
-- config jsonb is expected to hold an encrypted envelope — API should
-- encrypt secrets (API tokens, webhook URLs) before writing.
CREATE TABLE IF NOT EXISTS erp_integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  type                text NOT NULL CHECK (type IN ('sap', 'oracle', 'netsuite', 'quickbooks', 'sage', 'custom')),
  status              text NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused', 'error')),
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at        timestamptz,
  last_sync_status    text CHECK (last_sync_status IN ('success', 'error')),
  last_sync_error     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_integrations_vendor_id ON erp_integrations (vendor_id);
CREATE INDEX IF NOT EXISTS idx_erp_integrations_status    ON erp_integrations (status);
CREATE INDEX IF NOT EXISTS idx_erp_integrations_type      ON erp_integrations (type);

-- ══════════════════════════════════════════════════════════════════════════
-- 5. erp_sync_logs
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS erp_sync_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES erp_integrations(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  entity_type     text NOT NULL CHECK (entity_type IN ('po', 'invoice', 'payment', 'shipment')),
  entity_id       uuid,
  status          text NOT NULL CHECK (status IN ('success', 'error', 'skipped')),
  payload_hash    text,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_sync_logs_integration_id ON erp_sync_logs (integration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_sync_logs_entity         ON erp_sync_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_erp_sync_logs_status         ON erp_sync_logs (status) WHERE status = 'error';

-- ══════════════════════════════════════════════════════════════════════════
-- 6. edi_messages
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS edi_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  transaction_set     text NOT NULL CHECK (transaction_set IN ('850', '855', '856', '810', '820', '997')),
  interchange_id      text,
  status              text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'acknowledged', 'error')),
  raw_content         text,
  parsed_content      jsonb,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edi_messages_vendor_id        ON edi_messages (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edi_messages_transaction_set  ON edi_messages (transaction_set);
CREATE INDEX IF NOT EXISTS idx_edi_messages_interchange_id   ON edi_messages (interchange_id);
CREATE INDEX IF NOT EXISTS idx_edi_messages_status           ON edi_messages (status) WHERE status = 'error';

-- ══════════════════════════════════════════════════════════════════════════
-- 7. anomaly_flags
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS anomaly_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('invoice', 'shipment', 'po', 'vendor')),
  entity_id       uuid,
  type            text NOT NULL CHECK (type IN ('duplicate_invoice', 'price_variance', 'unusual_volume', 'late_pattern', 'compliance_gap')),
  severity        text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description     text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed', 'escalated')),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_by     text,
  reviewed_at     timestamptz,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_flags_vendor_id ON anomaly_flags (vendor_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_flags_status    ON anomaly_flags (status);
CREATE INDEX IF NOT EXISTS idx_anomaly_flags_severity  ON anomaly_flags (severity);
CREATE INDEX IF NOT EXISTS idx_anomaly_flags_entity    ON anomaly_flags (entity_type, entity_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 8. spend_forecasts
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS spend_forecasts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  forecast_amount     numeric NOT NULL,
  actual_amount       numeric,
  confidence_pct      numeric,
  model_version       text,
  generated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_spend_forecasts_vendor_period ON spend_forecasts (vendor_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_spend_forecasts_vendor_id   ON spend_forecasts (vendor_id);
CREATE INDEX IF NOT EXISTS idx_spend_forecasts_period      ON spend_forecasts (period_start DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 9. vendor_health_scores
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_health_scores (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id               uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  overall_score           numeric NOT NULL,
  delivery_score          numeric,
  quality_score           numeric,
  compliance_score        numeric,
  financial_score         numeric,
  responsiveness_score    numeric,
  score_breakdown         jsonb,
  period_start            date NOT NULL,
  period_end              date NOT NULL,
  generated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_health_scores_vendor_period ON vendor_health_scores (vendor_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_vendor_health_scores_vendor_id ON vendor_health_scores (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_health_scores_period   ON vendor_health_scores (period_start DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 10. preferred_vendors
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS preferred_vendors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  category    text NOT NULL,
  rank        integer NOT NULL DEFAULT 1,
  notes       text,
  set_by      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_preferred_vendors_vendor_category ON preferred_vendors (vendor_id, category);
CREATE INDEX IF NOT EXISTS idx_preferred_vendors_category_rank ON preferred_vendors (category, rank);

-- ══════════════════════════════════════════════════════════════════════════
-- RLS — enable + policies
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE onboarding_workflows  ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_steps      ENABLE ROW LEVEL SECURITY;
ALTER TABLE banking_details       ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_integrations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_sync_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE edi_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomaly_flags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_forecasts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_health_scores  ENABLE ROW LEVEL SECURITY;
ALTER TABLE preferred_vendors     ENABLE ROW LEVEL SECURITY;

-- ── onboarding_workflows ───────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_onboarding_workflows" ON onboarding_workflows;
CREATE POLICY "anon_all_onboarding_workflows" ON onboarding_workflows FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_onboarding_workflows_select" ON onboarding_workflows;
CREATE POLICY "vendor_own_onboarding_workflows_select" ON onboarding_workflows FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_onboarding_workflows_update" ON onboarding_workflows;
CREATE POLICY "vendor_own_onboarding_workflows_update" ON onboarding_workflows FOR UPDATE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── onboarding_steps ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_onboarding_steps" ON onboarding_steps;
CREATE POLICY "anon_all_onboarding_steps" ON onboarding_steps FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_onboarding_steps_select" ON onboarding_steps;
CREATE POLICY "vendor_own_onboarding_steps_select" ON onboarding_steps FOR SELECT TO authenticated
  USING (workflow_id IN (SELECT w.id FROM onboarding_workflows w WHERE w.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));
DROP POLICY IF EXISTS "vendor_own_onboarding_steps_upsert" ON onboarding_steps;
CREATE POLICY "vendor_own_onboarding_steps_upsert" ON onboarding_steps FOR INSERT TO authenticated
  WITH CHECK (workflow_id IN (SELECT w.id FROM onboarding_workflows w WHERE w.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));
DROP POLICY IF EXISTS "vendor_own_onboarding_steps_update" ON onboarding_steps;
CREATE POLICY "vendor_own_onboarding_steps_update" ON onboarding_steps FOR UPDATE TO authenticated
  USING (workflow_id IN (SELECT w.id FROM onboarding_workflows w WHERE w.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));

-- ── banking_details ────────────────────────────────────────────────────
-- Vendor admins can CRUD their own; verified state is set by internal
-- via service_role. NEVER return key_hash-equivalent raw PAN values —
-- the API layer decrypts on demand only for authorized reads.
DROP POLICY IF EXISTS "anon_all_banking_details" ON banking_details;
CREATE POLICY "anon_all_banking_details" ON banking_details FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_banking_details_select" ON banking_details;
CREATE POLICY "vendor_own_banking_details_select" ON banking_details FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_banking_details_insert" ON banking_details;
CREATE POLICY "vendor_own_banking_details_insert" ON banking_details FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_banking_details_update" ON banking_details;
CREATE POLICY "vendor_own_banking_details_update" ON banking_details FOR UPDATE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── erp_integrations ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_erp_integrations" ON erp_integrations;
CREATE POLICY "anon_all_erp_integrations" ON erp_integrations FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_erp_integrations_select" ON erp_integrations;
CREATE POLICY "vendor_own_erp_integrations_select" ON erp_integrations FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_erp_integrations_update" ON erp_integrations;
CREATE POLICY "vendor_own_erp_integrations_update" ON erp_integrations FOR UPDATE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── erp_sync_logs ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_erp_sync_logs" ON erp_sync_logs;
CREATE POLICY "anon_all_erp_sync_logs" ON erp_sync_logs FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_erp_sync_logs_select" ON erp_sync_logs;
CREATE POLICY "vendor_own_erp_sync_logs_select" ON erp_sync_logs FOR SELECT TO authenticated
  USING (integration_id IN (SELECT i.id FROM erp_integrations i WHERE i.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));

-- ── edi_messages ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_edi_messages" ON edi_messages;
CREATE POLICY "anon_all_edi_messages" ON edi_messages FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_edi_messages_select" ON edi_messages;
CREATE POLICY "vendor_own_edi_messages_select" ON edi_messages FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── anomaly_flags ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_anomaly_flags" ON anomaly_flags;
CREATE POLICY "anon_all_anomaly_flags" ON anomaly_flags FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_anomaly_flags_select" ON anomaly_flags;
CREATE POLICY "vendor_own_anomaly_flags_select" ON anomaly_flags FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── vendor_health_scores — vendors can read their own ─────────────────
DROP POLICY IF EXISTS "anon_all_vendor_health_scores" ON vendor_health_scores;
CREATE POLICY "anon_all_vendor_health_scores" ON vendor_health_scores FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_vendor_health_scores_select" ON vendor_health_scores;
CREATE POLICY "vendor_own_vendor_health_scores_select" ON vendor_health_scores FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ── spend_forecasts — INTERNAL ONLY (no authenticated policy) ─────────
DROP POLICY IF EXISTS "anon_all_spend_forecasts" ON spend_forecasts;
CREATE POLICY "anon_all_spend_forecasts" ON spend_forecasts FOR ALL TO anon USING (true) WITH CHECK (true);
-- (deliberately no authenticated policy — vendors cannot read forecasts)

-- ── preferred_vendors — INTERNAL ONLY (no authenticated policy) ──────
DROP POLICY IF EXISTS "anon_all_preferred_vendors" ON preferred_vendors;
CREATE POLICY "anon_all_preferred_vendors" ON preferred_vendors FOR ALL TO anon USING (true) WITH CHECK (true);
-- (deliberately no authenticated policy — ranking is private)
