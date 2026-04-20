-- 20260420100000_inventory_planning_phase6.sql
--
-- Demand & Inventory Planning — Phase 6 (Execution + optional ERP writeback).
--
-- Turns approved recommendations (Phase 3 + 5) into executable batches of
-- actions. Export-first by default; ERP writeback lives behind config and
-- dry-run gates.
--
-- Safety rules enforced at the DB layer:
--   • Batch status transitions are enforced in app code (state machine in
--     executionBatchService) — not at SQL, to keep error messages helpful.
--   • Unique (batch, recommendation) keeps the same recommendation from
--     being mapped twice into the same batch.
--   • erp_writeback_config defaults `enabled=false`, `dry_run_default=true`.

-- ── ip_execution_batches ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_execution_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id     uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE RESTRICT,
  scenario_id         uuid REFERENCES ip_scenarios(id) ON DELETE SET NULL,
  batch_name          text NOT NULL,
  -- 'buy_plan' | 'expedite_plan' | 'reduce_plan' | 'cancel_plan'
  -- | 'reserve_update' | 'protection_update' | 'reallocation_plan'
  batch_type          text NOT NULL
                        CHECK (batch_type IN (
                          'buy_plan', 'expedite_plan', 'reduce_plan', 'cancel_plan',
                          'reserve_update', 'protection_update', 'reallocation_plan'
                        )),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN (
                          'draft', 'ready', 'approved', 'exported', 'submitted',
                          'partially_executed', 'executed', 'failed', 'archived'
                        )),
  created_by          text,
  approved_by         text,
  approved_at         timestamptz,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_exec_batches_run      ON ip_execution_batches (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_exec_batches_scenario ON ip_execution_batches (scenario_id);
CREATE INDEX IF NOT EXISTS idx_ip_exec_batches_status   ON ip_execution_batches (status);
CREATE INDEX IF NOT EXISTS idx_ip_exec_batches_type     ON ip_execution_batches (batch_type);

DROP TRIGGER IF EXISTS trg_ip_exec_batches_updated ON ip_execution_batches;
CREATE TRIGGER trg_ip_exec_batches_updated BEFORE UPDATE ON ip_execution_batches
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_execution_actions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_execution_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_batch_id    uuid NOT NULL REFERENCES ip_execution_batches(id) ON DELETE CASCADE,
  recommendation_id     uuid REFERENCES ip_inventory_recommendations(id) ON DELETE SET NULL,
  -- 'create_buy_request' | 'increase_po' | 'reduce_po' | 'cancel_po_line' |
  -- 'expedite_po' | 'shift_inventory' | 'reserve_inventory' |
  -- 'release_reserve' | 'update_protection_qty'
  action_type           text NOT NULL
                          CHECK (action_type IN (
                            'create_buy_request', 'increase_po', 'reduce_po',
                            'cancel_po_line', 'expedite_po', 'shift_inventory',
                            'reserve_inventory', 'release_reserve',
                            'update_protection_qty'
                          )),
  sku_id                uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  vendor_id             uuid REFERENCES ip_vendor_master(id)    ON DELETE SET NULL,
  customer_id           uuid REFERENCES ip_customer_master(id)  ON DELETE SET NULL,
  channel_id            uuid REFERENCES ip_channel_master(id)   ON DELETE SET NULL,
  po_number             text,
  period_start          date,
  suggested_qty         numeric(14, 3) NOT NULL DEFAULT 0,
  approved_qty          numeric(14, 3),   -- null until reviewed; edits set this
  -- 'pending' | 'approved' | 'exported' | 'submitted' | 'succeeded'
  -- | 'failed' | 'cancelled'
  execution_status      text NOT NULL DEFAULT 'pending'
                          CHECK (execution_status IN (
                            'pending', 'approved', 'exported', 'submitted',
                            'succeeded', 'failed', 'cancelled'
                          )),
  -- 'export_only' | 'manual_erp_entry' | 'api_writeback'
  execution_method      text NOT NULL DEFAULT 'export_only'
                          CHECK (execution_method IN (
                            'export_only', 'manual_erp_entry', 'api_writeback'
                          )),
  action_reason         text,
  payload_json          jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_json         jsonb,
  error_message         text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- A given recommendation can be mapped to at most one action within a
-- batch — avoids accidental duplicates when re-running the mapper.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_exec_action_batch_rec
  ON ip_execution_actions (execution_batch_id, recommendation_id)
  WHERE recommendation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ip_exec_action_batch    ON ip_execution_actions (execution_batch_id);
CREATE INDEX IF NOT EXISTS idx_ip_exec_action_sku      ON ip_execution_actions (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_exec_action_type     ON ip_execution_actions (action_type);
CREATE INDEX IF NOT EXISTS idx_ip_exec_action_status   ON ip_execution_actions (execution_status);
CREATE INDEX IF NOT EXISTS idx_ip_exec_action_method   ON ip_execution_actions (execution_method);

DROP TRIGGER IF EXISTS trg_ip_exec_actions_updated ON ip_execution_actions;
CREATE TRIGGER trg_ip_exec_actions_updated BEFORE UPDATE ON ip_execution_actions
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_execution_audit_log ─────────────────────────────────────────────────
-- Append-only event log. The batch detail view reads this by batch_id.
CREATE TABLE IF NOT EXISTS ip_execution_audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_batch_id  uuid NOT NULL REFERENCES ip_execution_batches(id) ON DELETE CASCADE,
  execution_action_id uuid REFERENCES ip_execution_actions(id) ON DELETE CASCADE,
  -- 'batch_created' | 'batch_approved' | 'batch_exported' | 'batch_submitted'
  -- | 'batch_archived' | 'action_approved_qty_set' | 'action_method_changed'
  -- | 'action_removed' | 'action_submitted' | 'action_succeeded'
  -- | 'action_failed' | 'action_retried' | 'dry_run'
  event_type          text NOT NULL,
  old_status          text,
  new_status          text,
  event_message       text,
  actor               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_exec_audit_batch  ON ip_execution_audit_log (execution_batch_id);
CREATE INDEX IF NOT EXISTS idx_ip_exec_audit_action ON ip_execution_audit_log (execution_action_id);
CREATE INDEX IF NOT EXISTS idx_ip_exec_audit_event  ON ip_execution_audit_log (event_type);
CREATE INDEX IF NOT EXISTS idx_ip_exec_audit_created ON ip_execution_audit_log (created_at DESC);

-- ── ip_erp_writeback_config ────────────────────────────────────────────────
-- Tells the writeback API which action types are enabled for which system,
-- and whether dry-run is the default. Default row set is all-disabled so
-- a fresh environment can't surprise anyone.
CREATE TABLE IF NOT EXISTS ip_erp_writeback_config (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_name          text NOT NULL,                  -- e.g. 'xoro'
  action_type          text NOT NULL,                  -- matches ip_execution_actions.action_type
  enabled              boolean NOT NULL DEFAULT false, -- master switch
  approval_required    boolean NOT NULL DEFAULT true,
  dry_run_default      boolean NOT NULL DEFAULT true,
  endpoint_reference   text,                           -- human-readable pointer, e.g. '/api/xoro/writeback/create-buy-request'
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_writeback_cfg_grain
  ON ip_erp_writeback_config (system_name, action_type);

DROP TRIGGER IF EXISTS trg_ip_writeback_cfg_updated ON ip_erp_writeback_config;
CREATE TRIGGER trg_ip_writeback_cfg_updated BEFORE UPDATE ON ip_erp_writeback_config
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- Seed: Xoro rows for every action type, all disabled + dry-run by default.
INSERT INTO ip_erp_writeback_config (system_name, action_type, enabled, approval_required, dry_run_default, endpoint_reference, note)
VALUES
  ('xoro', 'create_buy_request',    false, true, true, '/api/xoro/writeback/create-buy-request',    'Create a new PO / buy request'),
  ('xoro', 'increase_po',           false, true, true, '/api/xoro/writeback/update-po',             'Raise qty on an existing PO line'),
  ('xoro', 'reduce_po',             false, true, true, '/api/xoro/writeback/update-po',             'Lower qty on an existing PO line'),
  ('xoro', 'cancel_po_line',        false, true, true, '/api/xoro/writeback/cancel-po-line',        'Cancel a PO line outright'),
  ('xoro', 'expedite_po',           false, true, true, '/api/xoro/writeback/expedite-po',           'Request expedite / pull-in date'),
  ('xoro', 'shift_inventory',       false, true, true, NULL,                                        'No Xoro endpoint yet — export-only'),
  ('xoro', 'reserve_inventory',     false, true, true, '/api/xoro/writeback/reserve-update',        'Reserve/protect inventory qty'),
  ('xoro', 'release_reserve',       false, true, true, '/api/xoro/writeback/reserve-update',        'Release previous reserve'),
  ('xoro', 'update_protection_qty', false, true, true, '/api/xoro/writeback/reserve-update',        'Adjust protection qty')
ON CONFLICT (system_name, action_type) DO NOTHING;

-- ── ip_action_templates ────────────────────────────────────────────────────
-- Optional per-action-type templates that the mapper can pre-fill.
CREATE TABLE IF NOT EXISTS ip_action_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name         text NOT NULL,
  action_type           text NOT NULL,
  payload_template_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_action_tpl_type   ON ip_action_templates (action_type);
CREATE INDEX IF NOT EXISTS idx_ip_action_tpl_active ON ip_action_templates (active) WHERE active;

DROP TRIGGER IF EXISTS trg_ip_action_tpl_updated ON ip_action_templates;
CREATE TRIGGER trg_ip_action_tpl_updated BEFORE UPDATE ON ip_action_templates
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE ip_execution_batches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_execution_actions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_execution_audit_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_erp_writeback_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_action_templates      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ip_execution_batches',
    'ip_execution_actions',
    'ip_execution_audit_log',
    'ip_erp_writeback_config',
    'ip_action_templates'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
