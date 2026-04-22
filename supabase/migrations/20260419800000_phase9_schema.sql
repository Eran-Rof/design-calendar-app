-- 20260419800000_phase9_schema.sql
--
-- Phase 9 — AI insights, collaboration workspaces, ESG/diversity,
-- compliance automation, marketplace, and benchmark data.
--
-- Conventions (consistent with earlier phases):
--   • snake_case table names
--   • internal user references stored as text (internal users live in
--     app_data['users'], NOT auth.users — same precedent as prior phases)
--   • entity scoping via entities(id); vendor-owned tables reference
--     vendors(id) with ON DELETE CASCADE unless preserving audit trail
--   • RLS pattern: anon-permissive ALL (so internal apps using the anon
--     key keep working) + authenticated vendor-filtered where vendors
--     should see their own rows
--   • Additive only — no ALTER/DROP on existing tables
--
-- Storage notes:
--   • report_file_url, certificate_file_url are storage paths into the
--     'vendor-docs' bucket (same convention as compliance_documents)

-- ══════════════════════════════════════════════════════════════════════════
-- 1. ai_insights
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  vendor_id       uuid REFERENCES vendors(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN (
    'cost_saving', 'risk_alert', 'consolidation',
    'contract_renewal', 'performance_trend', 'market_benchmark'
  )),
  title           text NOT NULL,
  summary         text,
  recommendation  text,
  confidence_pct  numeric(5,2) CHECK (confidence_pct IS NULL OR (confidence_pct >= 0 AND confidence_pct <= 100)),
  data_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'read', 'actioned', 'dismissed')),
  generated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_entity     ON ai_insights (entity_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_vendor     ON ai_insights (vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_insights_status     ON ai_insights (status);
CREATE INDEX IF NOT EXISTS idx_ai_insights_type       ON ai_insights (type);
CREATE INDEX IF NOT EXISTS idx_ai_insights_expires    ON ai_insights (expires_at);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. collaboration_workspaces + pins + tasks
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS collaboration_workspaces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  vendor_id    uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by   text,                                      -- internal user (app_data['users'])
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_entity ON collaboration_workspaces (entity_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_vendor ON collaboration_workspaces (vendor_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON collaboration_workspaces (status);

CREATE TABLE IF NOT EXISTS workspace_pins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES collaboration_workspaces(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('po', 'invoice', 'contract', 'rfq', 'document')),
  entity_ref_id   uuid NOT NULL,                           -- soft FK (polymorphic); validated in API layer
  pinned_by_type  text NOT NULL CHECK (pinned_by_type IN ('vendor', 'internal')),
  pinned_by       text NOT NULL,                           -- vendor_user_id (as text) or internal user id
  label           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_pins_workspace ON workspace_pins (workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_pins_ref       ON workspace_pins (entity_type, entity_ref_id);

CREATE TABLE IF NOT EXISTS workspace_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES collaboration_workspaces(id) ON DELETE CASCADE,
  title             text NOT NULL,
  description       text,
  assigned_to_type  text CHECK (assigned_to_type IN ('vendor', 'internal')),
  assigned_to       text,
  due_date          date,
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'in_progress', 'complete', 'cancelled')),
  completed_at      timestamptz,
  created_by_type   text CHECK (created_by_type IN ('vendor', 'internal')),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace ON workspace_tasks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_status    ON workspace_tasks (status);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_due       ON workspace_tasks (due_date) WHERE due_date IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. sustainability_reports + esg_scores
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sustainability_reports (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id               uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  reporting_period_start  date NOT NULL,
  reporting_period_end    date NOT NULL CHECK (reporting_period_end >= reporting_period_start),
  scope1_emissions        numeric(14,3),
  scope2_emissions        numeric(14,3),
  scope3_emissions        numeric(14,3),
  renewable_energy_pct    numeric(5,2) CHECK (renewable_energy_pct IS NULL OR (renewable_energy_pct >= 0 AND renewable_energy_pct <= 100)),
  waste_diverted_pct      numeric(5,2) CHECK (waste_diverted_pct IS NULL OR (waste_diverted_pct >= 0 AND waste_diverted_pct <= 100)),
  water_usage_liters      numeric(14,2),
  certifications          text[] NOT NULL DEFAULT '{}',
  report_file_url         text,                           -- storage path
  status                  text NOT NULL DEFAULT 'submitted'
                            CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected')),
  submitted_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_by             text,                           -- internal user
  reviewed_at             timestamptz,
  rejection_reason        text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sustain_vendor ON sustainability_reports (vendor_id);
CREATE INDEX IF NOT EXISTS idx_sustain_status ON sustainability_reports (status);
CREATE INDEX IF NOT EXISTS idx_sustain_period ON sustainability_reports (reporting_period_start, reporting_period_end);

CREATE TABLE IF NOT EXISTS esg_scores (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  period_start          date NOT NULL,
  period_end            date NOT NULL CHECK (period_end >= period_start),
  environmental_score   numeric(5,2) CHECK (environmental_score IS NULL OR (environmental_score >= 0 AND environmental_score <= 100)),
  social_score          numeric(5,2) CHECK (social_score IS NULL OR (social_score >= 0 AND social_score <= 100)),
  governance_score      numeric(5,2) CHECK (governance_score IS NULL OR (governance_score >= 0 AND governance_score <= 100)),
  overall_score         numeric(5,2) CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)),
  score_breakdown       jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_esg_vendor_period
  ON esg_scores (vendor_id, period_start, period_end);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. diversity_profiles
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS diversity_profiles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id               uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  business_type           text[] NOT NULL DEFAULT '{}',    -- e.g. minority_owned, women_owned, veteran_owned, lgbtq_owned, disability_owned, small_business, hub_zone
  certifying_body         text,                            -- NMSDC | WBENC | NVBDC | SBA ...
  certification_number    text,
  certification_expiry    date,
  certificate_file_url    text,                            -- storage path
  verified                boolean NOT NULL DEFAULT false,
  verified_at             timestamptz,
  verified_by             text,                            -- internal user
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_diversity_vendor   ON diversity_profiles (vendor_id);
CREATE INDEX IF NOT EXISTS idx_diversity_verified ON diversity_profiles (verified);
CREATE INDEX IF NOT EXISTS idx_diversity_expiry   ON diversity_profiles (certification_expiry) WHERE certification_expiry IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. compliance automation
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS compliance_automation_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  document_type_id       uuid NOT NULL REFERENCES compliance_document_types(id) ON DELETE CASCADE,
  trigger_type           text NOT NULL CHECK (trigger_type IN ('expiry_approaching', 'status_change', 'periodic_review')),
  days_before_expiry     integer CHECK (days_before_expiry IS NULL OR days_before_expiry >= 0),
  auto_request           boolean NOT NULL DEFAULT false,
  escalation_after_days  integer CHECK (escalation_after_days IS NULL OR escalation_after_days > 0),
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_entity    ON compliance_automation_rules (entity_id);
CREATE INDEX IF NOT EXISTS idx_automation_doc_type  ON compliance_automation_rules (document_type_id);
CREATE INDEX IF NOT EXISTS idx_automation_active    ON compliance_automation_rules (is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_entity_doc_trigger
  ON compliance_automation_rules (entity_id, document_type_id, trigger_type);

CREATE TABLE IF NOT EXISTS compliance_audit_trail (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  document_id         uuid REFERENCES compliance_documents(id) ON DELETE SET NULL,
  action              text NOT NULL CHECK (action IN ('uploaded', 'reviewed', 'approved', 'rejected', 'expired', 'renewed', 'requested')),
  performed_by_type   text NOT NULL CHECK (performed_by_type IN ('vendor', 'internal', 'system')),
  performed_by        text,                               -- vendor_user_id / internal user / null for system
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_vendor   ON compliance_audit_trail (vendor_id);
CREATE INDEX IF NOT EXISTS idx_audit_document ON compliance_audit_trail (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_action   ON compliance_audit_trail (action);
CREATE INDEX IF NOT EXISTS idx_audit_created  ON compliance_audit_trail (created_at DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 6. marketplace
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id            uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  title                text NOT NULL,
  description          text,
  category             text,
  capabilities         text[] NOT NULL DEFAULT '{}',
  certifications       text[] NOT NULL DEFAULT '{}',
  geographic_coverage  text[] NOT NULL DEFAULT '{}',
  min_order_value      numeric(14,2),
  lead_time_range      text,                              -- e.g. "2-4 weeks"
  featured             boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'published', 'suspended')),
  views                integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_vendor   ON marketplace_listings (vendor_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_status   ON marketplace_listings (status);
CREATE INDEX IF NOT EXISTS idx_marketplace_category ON marketplace_listings (category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_featured ON marketplace_listings (featured) WHERE featured = true;

CREATE TABLE IF NOT EXISTS marketplace_inquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id     uuid NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  entity_id      uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  inquired_by    text NOT NULL,                           -- internal user id
  message        text NOT NULL,
  status         text NOT NULL DEFAULT 'sent'
                   CHECK (status IN ('sent', 'responded', 'converted_to_rfq')),
  response       text,
  responded_at   timestamptz,
  rfq_id         uuid REFERENCES rfqs(id) ON DELETE SET NULL,  -- set when converted
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiries_listing ON marketplace_inquiries (listing_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_entity  ON marketplace_inquiries (entity_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_status  ON marketplace_inquiries (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 7. benchmark_data (anonymised aggregate only — no vendor_id)
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS benchmark_data (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category        text NOT NULL,
  metric          text NOT NULL CHECK (metric IN ('unit_price', 'lead_time', 'payment_terms', 'on_time_pct')),
  percentile_25   numeric(14,4),
  percentile_50   numeric(14,4),
  percentile_75   numeric(14,4),
  percentile_90   numeric(14,4),
  sample_size     integer NOT NULL CHECK (sample_size >= 0),
  period_start    date NOT NULL,
  period_end      date NOT NULL CHECK (period_end >= period_start),
  generated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_benchmark_category ON benchmark_data (category);
CREATE INDEX IF NOT EXISTS idx_benchmark_metric   ON benchmark_data (metric);
CREATE INDEX IF NOT EXISTS idx_benchmark_period   ON benchmark_data (period_start, period_end);

-- ══════════════════════════════════════════════════════════════════════════
-- 8. RLS — anon-permissive so internal apps with anon key keep working,
--         vendor-authenticated policies scope vendor reads to their own rows.
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE ai_insights                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_workspaces     ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_pins               ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_tasks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sustainability_reports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE esg_scores                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE diversity_profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_automation_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_audit_trail       ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_listings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_inquiries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE benchmark_data               ENABLE ROW LEVEL SECURITY;

-- anon-permissive on all Phase 9 tables (internal apps use the anon key)
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'ai_insights', 'collaboration_workspaces', 'workspace_pins', 'workspace_tasks',
    'sustainability_reports', 'esg_scores', 'diversity_profiles',
    'compliance_automation_rules', 'compliance_audit_trail',
    'marketplace_listings', 'marketplace_inquiries', 'benchmark_data'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Vendor-authenticated reads scoped to their own vendor_id
DROP POLICY IF EXISTS "vendor_own_ai_insights" ON ai_insights;
CREATE POLICY "vendor_own_ai_insights" ON ai_insights
  FOR SELECT TO authenticated
  USING (vendor_id IS NULL OR vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_workspaces" ON collaboration_workspaces;
CREATE POLICY "vendor_own_workspaces" ON collaboration_workspaces
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_workspace_pins" ON workspace_pins;
CREATE POLICY "vendor_own_workspace_pins" ON workspace_pins
  FOR ALL TO authenticated
  USING (workspace_id IN (
    SELECT w.id FROM collaboration_workspaces w
    JOIN vendor_users vu ON vu.vendor_id = w.vendor_id
    WHERE vu.auth_id = auth.uid()
  ));

DROP POLICY IF EXISTS "vendor_own_workspace_tasks" ON workspace_tasks;
CREATE POLICY "vendor_own_workspace_tasks" ON workspace_tasks
  FOR ALL TO authenticated
  USING (workspace_id IN (
    SELECT w.id FROM collaboration_workspaces w
    JOIN vendor_users vu ON vu.vendor_id = w.vendor_id
    WHERE vu.auth_id = auth.uid()
  ));

DROP POLICY IF EXISTS "vendor_own_sustain_select" ON sustainability_reports;
CREATE POLICY "vendor_own_sustain_select" ON sustainability_reports
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_sustain_insert" ON sustainability_reports;
CREATE POLICY "vendor_own_sustain_insert" ON sustainability_reports
  FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_esg" ON esg_scores;
CREATE POLICY "vendor_own_esg" ON esg_scores
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_diversity_select" ON diversity_profiles;
CREATE POLICY "vendor_own_diversity_select" ON diversity_profiles
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_diversity_upsert" ON diversity_profiles;
CREATE POLICY "vendor_own_diversity_upsert" ON diversity_profiles
  FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_audit" ON compliance_audit_trail;
CREATE POLICY "vendor_own_audit" ON compliance_audit_trail
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- marketplace_listings: any authenticated (incl. vendors) can read published,
-- vendors can write/update only their own.
DROP POLICY IF EXISTS "published_marketplace_read" ON marketplace_listings;
CREATE POLICY "published_marketplace_read" ON marketplace_listings
  FOR SELECT TO authenticated
  USING (status = 'published' OR vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_marketplace_write" ON marketplace_listings;
CREATE POLICY "vendor_own_marketplace_write" ON marketplace_listings
  FOR ALL TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- marketplace_inquiries: vendors see inquiries against their listings
DROP POLICY IF EXISTS "vendor_own_inquiries" ON marketplace_inquiries;
CREATE POLICY "vendor_own_inquiries" ON marketplace_inquiries
  FOR SELECT TO authenticated
  USING (listing_id IN (
    SELECT l.id FROM marketplace_listings l
    JOIN vendor_users vu ON vu.vendor_id = l.vendor_id
    WHERE vu.auth_id = auth.uid()
  ));

-- benchmark_data: anonymised, readable by any authenticated user (incl. vendors)
DROP POLICY IF EXISTS "benchmark_read_all" ON benchmark_data;
CREATE POLICY "benchmark_read_all" ON benchmark_data
  FOR SELECT TO authenticated USING (true);

-- compliance_automation_rules: internal-only (no authenticated vendor policy)
