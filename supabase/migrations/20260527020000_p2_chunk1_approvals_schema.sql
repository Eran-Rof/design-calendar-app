-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P2 / Chunk 1 / Migration 1
-- M27 Workflow/Approvals — schema for approval_rules, approval_requests,
-- approval_request_steps, approval_decisions.
--
-- Per docs/tangerine/P2-cross-cutters-architecture.md §4.
--
-- Loose-coupling note: downstream modules (M3 AP, M4 AR, M11 PO) call
-- api/_lib/approvals/index.js. They DO NOT take direct FKs on
-- approval_requests; context is stored as (context_table, context_id).
--
-- Role values in approval_request_steps.role_required must match
-- entity_users.role CHECK ('admin','accountant','staff','readonly') for the
-- decide() path to find approvers. Future role-vocabulary expansion goes
-- through ALTER CONSTRAINT entity_users_role_check.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- approval_rules: a row is a JSONB-driven matcher + step list. At
-- requestIfRequired() time, the matcher collects every is_active=true rule
-- whose .match clause matches the call payload, then unions their steps.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  kind                 text NOT NULL,
  name                 text NOT NULL,
  match                jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps                jsonb NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT approval_rules_steps_is_array CHECK (jsonb_typeof(steps) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_active
  ON approval_rules (entity_id, kind)
  WHERE is_active = true;

COMMENT ON TABLE  approval_rules IS 'JSONB-spec approval rules. .match supports: min_amount_cents, max_amount_cents, source_kind, entity_id, vendor_new, and {or:[],and:[]} composition. .steps is an array of {step_order, mode:any|all, role_required}.';
COMMENT ON COLUMN approval_rules.kind   IS 'Discriminator (ap_invoice, je_post, po_release, customer_credit_limit, ...). Extend by adding new rules; no enum constraint.';
COMMENT ON COLUMN approval_rules.match  IS 'JSONB matcher. Empty object = match all. See api/_lib/approvals/matcher.js for the supported operator vocabulary.';
COMMENT ON COLUMN approval_rules.steps  IS 'Ordered array of approval steps. Each step: { step_order:int, mode:"any"|"all", role_required:text }.';

-- ────────────────────────────────────────────────────────────────────────────
-- approval_requests: one row per "this needs approval before it can proceed"
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_requests (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  kind                     text NOT NULL,
  context_table            text NOT NULL,
  context_id               uuid NOT NULL,
  requested_amount_cents   bigint,
  currency                 char(3) NOT NULL DEFAULT 'USD',
  status                   text NOT NULL DEFAULT 'pending',
  final_decided_at         timestamptz,
  expires_at               timestamptz,
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT approval_requests_status_check
    CHECK (status IN ('pending','approved','rejected','cancelled','expired'))
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_entity_status
  ON approval_requests (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_context
  ON approval_requests (context_table, context_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON approval_requests (kind, status)
  WHERE status = 'pending';

COMMENT ON TABLE  approval_requests IS 'One row per pending/decided approval. context_table+context_id point at the row this is about (loose coupling — no FK). payload snapshots the requester row for audit.';
COMMENT ON COLUMN approval_requests.status IS 'pending → approved | rejected | cancelled | expired. Transitions logged in approval_decisions.';

-- ────────────────────────────────────────────────────────────────────────────
-- approval_request_steps: ordered steps that must each fulfill in step_order
-- order for the request to flip to approved. mode=any → first approval at
-- that step closes it; mode=all → every entity_users row with role_required
-- must approve.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_request_steps (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id               uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_order               smallint NOT NULL,
  mode                     text NOT NULL,
  role_required            text NOT NULL,
  fulfilled_at             timestamptz,
  fulfilled_by_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                    text,
  CONSTRAINT approval_request_steps_unique UNIQUE (request_id, step_order),
  CONSTRAINT approval_request_steps_mode_check CHECK (mode IN ('any','all'))
);

CREATE INDEX IF NOT EXISTS idx_approval_request_steps_open
  ON approval_request_steps (request_id, step_order)
  WHERE fulfilled_at IS NULL;

COMMENT ON TABLE  approval_request_steps IS 'Ordered steps within an approval_request. Current step = first step in step_order order with fulfilled_at IS NULL.';

-- ────────────────────────────────────────────────────────────────────────────
-- approval_decisions: append-only audit trail of every approve/reject/changes
-- action. A step may receive multiple decisions if reset/re-routed; the audit
-- is preserved.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_decisions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id               uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_id                  uuid NOT NULL REFERENCES approval_request_steps(id) ON DELETE CASCADE,
  decision                 text NOT NULL,
  decided_by_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_at               timestamptz NOT NULL DEFAULT now(),
  notes                    text,
  CONSTRAINT approval_decisions_decision_check
    CHECK (decision IN ('approve','reject','request_changes'))
);

CREATE INDEX IF NOT EXISTS idx_approval_decisions_request
  ON approval_decisions (request_id, decided_at DESC);

COMMENT ON TABLE approval_decisions IS 'Append-only audit log of every approval/rejection. INSERT only — UPDATE/DELETE blocked by RLS pattern (no policy granted).';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — P1 template reuse: anon_all + auth_internal_* via entity_users.auth_id
-- approval_decisions is append-only: SELECT + INSERT to authenticated, no
-- UPDATE/DELETE policy at all.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE approval_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_request_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions     ENABLE ROW LEVEL SECURITY;

-- Anon-key SPA path — full access.
CREATE POLICY "anon_all_approval_rules" ON approval_rules
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_approval_requests" ON approval_requests
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_approval_request_steps" ON approval_request_steps
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_approval_decisions" ON approval_decisions
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- Authenticated internal users — entity-scoped.
CREATE POLICY "auth_internal_approval_rules" ON approval_rules
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

CREATE POLICY "auth_internal_approval_requests" ON approval_requests
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- Steps inherit entity scoping via their parent request.
CREATE POLICY "auth_internal_approval_request_steps" ON approval_request_steps
  FOR ALL TO authenticated
  USING (request_id IN (
    SELECT ar.id FROM approval_requests ar
    JOIN entity_users eu ON eu.entity_id = ar.entity_id
    WHERE eu.auth_id = auth.uid()
  ))
  WITH CHECK (request_id IN (
    SELECT ar.id FROM approval_requests ar
    JOIN entity_users eu ON eu.entity_id = ar.entity_id
    WHERE eu.auth_id = auth.uid()
  ));

-- Decisions: SELECT + INSERT only for authenticated. No UPDATE/DELETE
-- policy = forbidden by default.
CREATE POLICY "auth_internal_approval_decisions_select" ON approval_decisions
  FOR SELECT TO authenticated
  USING (request_id IN (
    SELECT ar.id FROM approval_requests ar
    JOIN entity_users eu ON eu.entity_id = ar.entity_id
    WHERE eu.auth_id = auth.uid()
  ));

CREATE POLICY "auth_internal_approval_decisions_insert" ON approval_decisions
  FOR INSERT TO authenticated
  WITH CHECK (request_id IN (
    SELECT ar.id FROM approval_requests ar
    JOIN entity_users eu ON eu.entity_id = ar.entity_id
    WHERE eu.auth_id = auth.uid()
  ));

-- ════════════════════════════════════════════════════════════════════════════
-- Touched-at triggers (parity with P1 tables)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION approval_rules_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approval_rules_touch_trg ON approval_rules;
CREATE TRIGGER approval_rules_touch_trg
  BEFORE UPDATE ON approval_rules
  FOR EACH ROW EXECUTE FUNCTION approval_rules_touch();
