-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P9-1 — Parallel-Run reconciliation schema foundation
--
-- First chunk of P9 (Parallel-Run reconciliation — see
-- docs/tangerine/P9-parallel-run-architecture.md + PR #516 architecture
-- refresh). Operator-confirmed decisions D1, D2, D8, D11 and the
-- architecture-recommended values for D3-D7, D9, D10, D12.
--
-- Builds the schema that supports weekly recon batches (D1) per domain
-- (AP / AR / Cash / GL / Inventory) against locked thresholds (D2),
-- with a 60-day clean-window solo-cutover trail (D8) and replay
-- semantics (D11).
--
-- This chunk = SCHEMA ONLY. The weekly recon cron, per-domain matchers,
-- variance triage UI, dashboards, and replay RPC land in P9-2..P9-8.
--
-- Tables (all idempotent CREATE TABLE IF NOT EXISTS):
--   1. recon_runs              — top-level recon batch per (entity, domain, run_date)
--   2. recon_variances         — per-row variance records (one per source row mismatch)
--   3. recon_cleared_log       — manual clearance trail (auditor-required)
--   4. recon_cutover_signoffs  — D8 solo-cutover per (entity, domain, source_tag)
--
-- Plus:
--   - entities.parallel_run_status jsonb extension (D10): domain-level
--     flip state + source-tag (D7) channel granularity. Operator flips
--     each domain independently; flip is reversible per arch §6.
--   - anon_all_* + auth_internal_* RLS template on all 4 new tables
--   - entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())
--     on the 2 entity-scoped roots (recon_runs + recon_cutover_signoffs)
--     so the cron handler can INSERT without resolving entity_id
--     client-side (P10-2 GUC-aware fallback)
--   - replay_of_id self-reference on recon_runs (D11: replay points back
--     to original; auditable history shows "originally clean, re-run
--     found $X variance")
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS, ALTER TABLE ... ADD
-- COLUMN IF NOT EXISTS, RLS policies wrapped in DO $$ ... EXCEPTION
-- WHEN duplicate_object. No COMMENT-concat (see migration lint).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. recon_runs ────────────────────────────────────────────────────────
--
-- Top-level recon batch. One row per (entity, domain, run_date) under
-- normal weekly cadence; cadence='manual' for ad-hoc reruns and
-- cadence='replay' for D11 historical re-mirror + re-compare (with
-- replay_of_id pointing back to the original run). totals_jsonb is
-- intentionally schemaless — the per-domain matcher writes whatever
-- summary stats it needs (rows_compared, variances_found,
-- total_variance_cents, threshold_ceiling_cents, etc.).

CREATE TABLE IF NOT EXISTS recon_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id()) REFERENCES entities(id) ON DELETE RESTRICT,
  domain        text NOT NULL CHECK (domain IN ('ap','ar','cash','gl','inventory')),
  run_date      date NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  cadence       text NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('weekly','manual','replay')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','clean','variance','error')),
  started_at    timestamptz,
  completed_at  timestamptz,
  totals_jsonb  jsonb NOT NULL DEFAULT '{}'::jsonb,
  replay_of_id  uuid REFERENCES recon_runs(id) ON DELETE SET NULL,
  replay_reason text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recon_runs_entity_domain_date_idx
  ON recon_runs (entity_id, domain, run_date DESC);
CREATE INDEX IF NOT EXISTS recon_runs_replay_idx
  ON recon_runs (replay_of_id) WHERE replay_of_id IS NOT NULL;

COMMENT ON TABLE recon_runs IS 'P9-1: weekly recon batch per (entity, domain, run_date). cadence=weekly default; manual=operator-triggered; replay=D11 historical re-mirror with replay_of_id pointing back. totals_jsonb is per-domain matcher output.';
COMMENT ON COLUMN recon_runs.replay_of_id IS 'D11: replay run points back to the original. Auditable history shows "originally clean, re-run found $X variance" without losing either result.';
COMMENT ON COLUMN recon_runs.totals_jsonb IS 'Per-domain summary: rows_compared, variances_found, total_variance_cents, threshold_ceiling_cents, etc. Schemaless so each matcher (AP/AR/Cash/GL/Inventory) can populate what it needs.';

-- ─── 2. recon_variances ───────────────────────────────────────────────────
--
-- Per-row variance record. One row per (recon_run, source_table,
-- source_id) where Tangerine and Xoro disagree. status starts at 'over'
-- when ABS(variance) crosses the per-row threshold; 'within' for
-- below-threshold rows we still want to log; 'cleared' once an operator
-- manually clears via recon_cleared_log; 'suppressed' for known-noise
-- patterns (e.g. rounding cells the matcher classifier suppresses
-- automatically).
--
-- source_tag mirrors the T10 source-tagging enforcement memory rule
-- (every external integration uses a source enum + UI badge) so
-- channel-level variance trends are queryable.

CREATE TABLE IF NOT EXISTS recon_variances (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recon_run_id           uuid NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
  source_table           text NOT NULL,
  source_id              text NOT NULL,
  source_tag             text,
  tangerine_amount_cents bigint NOT NULL,
  xoro_amount_cents      bigint NOT NULL,
  variance_amount_cents  bigint NOT NULL,
  variance_percent       numeric(8,4),
  status                 text NOT NULL DEFAULT 'over' CHECK (status IN ('within','over','cleared','suppressed')),
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recon_variances_run_idx
  ON recon_variances (recon_run_id);
CREATE INDEX IF NOT EXISTS recon_variances_source_idx
  ON recon_variances (source_table, source_id);
CREATE INDEX IF NOT EXISTS recon_variances_status_idx
  ON recon_variances (recon_run_id, status) WHERE status = 'over';

COMMENT ON TABLE recon_variances IS 'P9-1: per-row variance record. status=over above threshold; within below; cleared after operator clearance via recon_cleared_log; suppressed for known-noise patterns. source_tag follows T10 source-tagging convention (shopify/fba/walmart/faire/xoro_mirror/NULL).';
COMMENT ON COLUMN recon_variances.source_tag IS 'D7 channel-level slicing: shopify | fba | walmart | faire | xoro_mirror | NULL. Same enum used across ar_invoices/journal_entries source columns (T10).';
COMMENT ON COLUMN recon_variances.variance_amount_cents IS 'tangerine_amount_cents - xoro_amount_cents. Signed so the variance dashboard can show direction (Tangerine over-stating vs under-stating Xoro).';

-- ─── 3. recon_cleared_log ─────────────────────────────────────────────────
--
-- Manual clearance audit trail. One row per clearance action. Both
-- cleared_by_auth_id (auth.users) and cleared_by_employee_id (employees)
-- are tracked so the audit trail survives both auth churn and employee
-- termination — auditor sees who, even if the auth row is later
-- recycled. reason is REQUIRED (NOT NULL) — clearing a variance without
-- a written justification breaks the audit trail.

CREATE TABLE IF NOT EXISTS recon_cleared_log (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recon_variance_id      uuid NOT NULL REFERENCES recon_variances(id) ON DELETE CASCADE,
  cleared_by_auth_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cleared_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  reason                 text NOT NULL,
  cleared_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recon_cleared_log_variance_idx
  ON recon_cleared_log (recon_variance_id);

COMMENT ON TABLE recon_cleared_log IS 'P9-1: manual variance clearance audit trail. reason NOT NULL so the audit trail always has the written justification. Both auth_id and employee_id captured so the trail survives auth churn or employee termination.';

-- ─── 4. recon_cutover_signoffs ────────────────────────────────────────────
--
-- D8: per (entity, domain, source_tag) sign-off snapshot capturing the
-- 60-day clean-window evidence at the moment the operator flips the
-- domain (or a single channel within the domain) from xoro_truth to
-- tangerine_truth. UNIQUE (entity_id, domain, source_tag) means a
-- domain or channel can only be signed-off once at a time — a
-- subsequent revert + re-sign-off requires deleting the prior row (or
-- the model can be extended to append-only with a deleted_at later).
--
-- source_tag is NULLABLE — NULL means the entire domain cuts over at
-- once (typical for GL, inventory, cash). For AR and AP the operator
-- may want to cut over individual channels first (D7): e.g.
-- (entity, 'ar', 'shopify') solo-cutover while (entity, 'ar', 'walmart')
-- is still xoro_truth.

CREATE TABLE IF NOT EXISTS recon_cutover_signoffs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id()) REFERENCES entities(id) ON DELETE RESTRICT,
  domain              text NOT NULL,
  source_tag          text,
  clean_window_start  date NOT NULL,
  clean_window_end    date NOT NULL,
  total_recons        int NOT NULL,
  signoff_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  signoff_at          timestamptz NOT NULL DEFAULT now(),
  notes               text,
  UNIQUE (entity_id, domain, source_tag)
);

COMMENT ON TABLE recon_cutover_signoffs IS 'P9-1: D8 solo-cutover sign-off trail. UNIQUE (entity_id, domain, source_tag) so each (domain, channel) pair has at most one active sign-off. source_tag NULL = whole-domain cutover; non-NULL = channel-level (D7).';
COMMENT ON COLUMN recon_cutover_signoffs.source_tag IS 'D7 channel-level cutover: e.g. shopify can cut over to Tangerine-truth while walmart stays xoro_truth in the same AR domain. NULL = whole-domain cutover.';

-- ─── 5. entities.parallel_run_status (D10) ────────────────────────────────
--
-- jsonb flag on entities. Shape per arch §6:
--   { "ap":  { "status": "parallel" | "tangerine_truth" | "xoro_truth",
--              "since":  "2026-05-29",
--              "cutover_at": "2026-08-01" },
--     "ar":  { "status": "solo", "cutover_at": "...",
--              "source_tags_solo": ["shopify"] },
--     ... }
-- Empty default {} = pre-P9 state (everything is xoro_truth implicitly).
-- The recon cron + dashboards read this to know which side to trust.

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS parallel_run_status jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN entities.parallel_run_status IS 'P9-1 D10: per-domain (and per-channel via source_tags_solo) flip state. Shape: { domain: { status, since, cutover_at, source_tags_solo[] } }. Empty {} = pre-P9 (everything xoro_truth implicitly).';

-- ─── 6. RLS — anon_all_* + auth_internal_* template ───────────────────────
--
-- Four new tables follow the standard P1 template (anon_all_* for the
-- service-role / anon-key API surface; auth_internal_* scoped to
-- entity_users via auth.uid()).
--
-- recon_runs + recon_cutover_signoffs are entity-scoped directly.
-- recon_variances + recon_cleared_log gate through the parent
-- recon_run / recon_variance respectively.

ALTER TABLE recon_runs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE recon_variances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE recon_cleared_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE recon_cutover_signoffs  ENABLE ROW LEVEL SECURITY;

-- recon_runs
DO $$ BEGIN
  CREATE POLICY "anon_all_recon_runs" ON recon_runs
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_recon_runs" ON recon_runs
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recon_variances — gated through parent recon_run
DO $$ BEGIN
  CREATE POLICY "anon_all_recon_variances" ON recon_variances
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_recon_variances" ON recon_variances
    FOR ALL TO authenticated
    USING      (recon_run_id IN (
                  SELECT rr.id FROM recon_runs rr
                  WHERE rr.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (recon_run_id IN (
                  SELECT rr.id FROM recon_runs rr
                  WHERE rr.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recon_cleared_log — gated through parent recon_variance → recon_run
DO $$ BEGIN
  CREATE POLICY "anon_all_recon_cleared_log" ON recon_cleared_log
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_recon_cleared_log" ON recon_cleared_log
    FOR ALL TO authenticated
    USING      (recon_variance_id IN (
                  SELECT rv.id FROM recon_variances rv
                  JOIN recon_runs rr ON rr.id = rv.recon_run_id
                  WHERE rr.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (recon_variance_id IN (
                  SELECT rv.id FROM recon_variances rv
                  JOIN recon_runs rr ON rr.id = rv.recon_run_id
                  WHERE rr.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recon_cutover_signoffs
DO $$ BEGIN
  CREATE POLICY "anon_all_recon_cutover_signoffs" ON recon_cutover_signoffs
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_recon_cutover_signoffs" ON recon_cutover_signoffs
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 7. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
