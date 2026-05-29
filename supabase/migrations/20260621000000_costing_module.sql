-- ════════════════════════════════════════════════════════════════════════════
-- Costing Module — schema (Chunk 1)
--
-- Replaces the ad-hoc BOYS-style Excel costing sheet with a database-backed
-- Costing Project: header (sales rep, customer, brand, dates) + grid of styles,
-- multi-vendor quotes, computed margin, LY + trailing-3-month comp, compliance
-- checklist. On award, /select-quote also writes the chosen cost into
-- ip_item_avg_cost.standard_unit_price (Chunk 8 — handler side).
--
-- 4 tables:
--   1. costing_projects          — header (project_name, brand, rep, customer, dates, status)
--   2. costing_lines             — per-style row (style_master_id + denormalized style_code)
--   3. costing_line_vendors      — multi-quote per line (vendor_id, cost, status)
--   4. costing_line_compliance   — row-per-requirement checklist
--
-- Conventions matched from P7-4 commissions + P8-1 CRM schemas:
--   • entity_id uuid NOT NULL REFERENCES entities(id), DEFAULT current_entity_id()
--     (the P10-2 helper that supersedes rof_entity_id).
--   • RLS enabled with anon_all_* permissive policy; auth happens in handlers.
--   • COMMENT ON TABLE/COLUMN uses single string literals (no || concat).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + DO $$ guards on policies.
-- Bundle source: iCloud/Producton Orders/sql/2026_05_29_costing_module.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. costing_projects ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS costing_projects (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 uuid NOT NULL DEFAULT current_entity_id()
                            REFERENCES entities(id) ON DELETE RESTRICT,
  project_name              text NOT NULL,
  brand                     text,
  gender_code               text,
  sales_rep_id              uuid REFERENCES sales_reps(id) ON DELETE SET NULL,
  customer_id               uuid REFERENCES customers(id) ON DELETE SET NULL,
  request_date              date,
  due_date                  date,
  projected_delivery_date   date,
  status                    text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','in_progress','quoted','awarded','closed','cancelled')),
  notes                     text,
  grid_state                jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT costing_projects_name_per_entity_unique UNIQUE (entity_id, project_name)
);

CREATE INDEX IF NOT EXISTS idx_costing_projects_entity_status
  ON costing_projects (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_costing_projects_customer
  ON costing_projects (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costing_projects_rep
  ON costing_projects (sales_rep_id) WHERE sales_rep_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costing_projects_due_date
  ON costing_projects (entity_id, due_date) WHERE due_date IS NOT NULL;

COMMENT ON TABLE costing_projects IS 'Costing Module header: a named costing project (e.g. "BOYS 7/1 DDP QTN") with sales rep, customer, brand, and target dates. Lines hang off this row via costing_lines.project_id.';
COMMENT ON COLUMN costing_projects.brand IS 'Freeform brand label (matches brands.name); not FK because brand list is currently env-specific.';
COMMENT ON COLUMN costing_projects.grid_state IS 'Persisted UI state — column widths, sort order, filters. Non-business data; safe to clear.';
COMMENT ON COLUMN costing_projects.status IS 'Lifecycle: draft → in_progress → quoted → awarded → closed (or cancelled). Drives the Plan Flow widget bucketing.';

-- ─── 2. costing_lines ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS costing_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 uuid NOT NULL DEFAULT current_entity_id()
                            REFERENCES entities(id) ON DELETE RESTRICT,
  project_id                uuid NOT NULL REFERENCES costing_projects(id) ON DELETE CASCADE,
  sort_order                int  NOT NULL DEFAULT 0,

  style_master_id           uuid REFERENCES style_master(id) ON DELETE SET NULL,
  style_code                text,
  style_name                text,
  description               text,
  picture_url               text,

  size_scale_id             uuid REFERENCES scale_master(id) ON DELETE SET NULL,
  size_scale_label          text,
  fabric_code               text,
  fit                       text,
  color                     text,
  bottom_closure            text,
  waist_type                text,
  waste_type                text,
  category_id               uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  sub_category_id           uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  style_state               text CHECK (style_state IS NULL OR style_state IN ('cad','tech_pack','sample','none')),
  comment                   text,
  remarks                   text,

  target_qty                numeric(12,2),
  target_cost               numeric(12,4),
  sell_target               numeric(12,4),
  sell_price                numeric(12,4),
  priced_date               date,
  fob_cost                  numeric(12,4),
  duty_rate                 numeric(7,4),
  freight                   numeric(12,4),
  insurance                 numeric(12,4),
  other_costs               numeric(12,4),
  landed_cost               numeric(12,4),
  margin_pct                numeric(7,4),

  selected_vendor_quote_id  uuid,

  ly_qty                    numeric(14,2),
  ly_unit_cost              numeric(12,4),
  ly_total_margin           numeric(14,2),
  ly_margin_pct             numeric(7,4),

  t3_qty                    numeric(14,2),
  t3_unit_cost              numeric(12,4),
  t3_total_cost             numeric(14,2),
  t3_margin_pct             numeric(7,4),

  comp_refreshed_at         timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costing_lines_project_order
  ON costing_lines (project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_costing_lines_style_code
  ON costing_lines (style_code) WHERE style_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costing_lines_style_master
  ON costing_lines (style_master_id) WHERE style_master_id IS NOT NULL;

COMMENT ON TABLE costing_lines IS 'Costing Module grid row — one per style. style_master_id is nullable so free-typed rows can exist while in draft; style_code is denormalized for comp aggregation joins that survive style rename.';
COMMENT ON COLUMN costing_lines.target_cost IS 'Seeded by src/shared/costResolution.resolveCost() on style pick (fallback cascade direct → sibling → open-PO → margin-derived).';
COMMENT ON COLUMN costing_lines.landed_cost IS 'Computed by src/techpack/calc.ts recomputeCosting from fob_cost + duty_rate + freight + insurance + other_costs. Persisted on UPDATE so the grid renders without recomputing client-side.';
COMMENT ON COLUMN costing_lines.selected_vendor_quote_id IS 'Back-pointer to costing_line_vendors.id with status=selected. Drives the Award stage in the Plan Flow widget and triggers the ip_item_avg_cost write-back (Chunk 8).';
COMMENT ON COLUMN costing_lines.ly_qty IS 'Last-year comp snapshot — qty over the same calendar window 12 months ago. Refreshed by POST /api/internal/costing/comp/ly. Filtered by qty_grain to avoid PPK double-count.';
COMMENT ON COLUMN costing_lines.t3_qty IS 'Trailing 3-month comp snapshot — qty over today − 3 months window. Refreshed by POST /api/internal/costing/comp/t3.';

-- ─── 3. costing_line_vendors ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS costing_line_vendors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL DEFAULT current_entity_id()
                      REFERENCES entities(id) ON DELETE RESTRICT,
  costing_line_id     uuid NOT NULL REFERENCES costing_lines(id) ON DELETE CASCADE,
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  quoted_cost         numeric(12,4) NOT NULL CHECK (quoted_cost >= 0),
  currency            char(3) NOT NULL DEFAULT 'USD',
  lead_time_days      int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  moq                 int CHECK (moq IS NULL OR moq >= 0),
  quoted_date         date NOT NULL DEFAULT current_date,
  valid_until         date,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','received','selected','rejected','expired')),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costing_line_vendors_line
  ON costing_line_vendors (costing_line_id);
CREATE INDEX IF NOT EXISTS idx_costing_line_vendors_vendor
  ON costing_line_vendors (vendor_id);

CREATE UNIQUE INDEX IF NOT EXISTS costing_line_vendors_one_selected
  ON costing_line_vendors (costing_line_id) WHERE status = 'selected';

ALTER TABLE costing_lines
  DROP CONSTRAINT IF EXISTS costing_lines_selected_quote_fk;
ALTER TABLE costing_lines
  ADD CONSTRAINT costing_lines_selected_quote_fk
  FOREIGN KEY (selected_vendor_quote_id)
  REFERENCES costing_line_vendors(id) ON DELETE SET NULL;

COMMENT ON TABLE costing_line_vendors IS 'Vendor quote per costing line — multiple per line. Exactly one may be status=selected (partial unique index); selection triggers the ip_item_avg_cost write-back in Chunk 8.';
COMMENT ON COLUMN costing_line_vendors.vendor_id IS 'References vendors (operational), not ip_vendor_master — Chunk 8 cost-write and future RFQ promotion both target the operational chain.';

-- ─── 4. costing_line_compliance ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS costing_line_compliance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL DEFAULT current_entity_id()
                      REFERENCES entities(id) ON DELETE RESTRICT,
  costing_line_id     uuid NOT NULL REFERENCES costing_lines(id) ON DELETE CASCADE,
  requirement_code    text NOT NULL,
  status              text NOT NULL DEFAULT 'required'
                      CHECK (status IN ('na','required','submitted','approved','rejected')),
  notes               text,
  attachment_url      text,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT costing_line_compliance_unique UNIQUE (costing_line_id, requirement_code)
);

CREATE INDEX IF NOT EXISTS idx_costing_line_compliance_line
  ON costing_line_compliance (costing_line_id);

COMMENT ON TABLE costing_line_compliance IS 'Per-line compliance checklist (CPSIA, PROP65, FLAMMABILITY, LABEL_FIBER_CONTENT, COO, etc). Row-per-requirement so future promotion to the global compliance table is a straight INSERT.';

-- ─── 5. updated_at triggers ────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $fn$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_costing_projects_updated_at        ON costing_projects;
DROP TRIGGER IF EXISTS trg_costing_lines_updated_at           ON costing_lines;
DROP TRIGGER IF EXISTS trg_costing_line_vendors_updated_at    ON costing_line_vendors;
DROP TRIGGER IF EXISTS trg_costing_line_compliance_updated_at ON costing_line_compliance;

CREATE TRIGGER trg_costing_projects_updated_at        BEFORE UPDATE ON costing_projects        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_costing_lines_updated_at           BEFORE UPDATE ON costing_lines           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_costing_line_vendors_updated_at    BEFORE UPDATE ON costing_line_vendors    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_costing_line_compliance_updated_at BEFORE UPDATE ON costing_line_compliance FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 6. RLS template (matches P7-4 / P8-1 convention) ──────────────────────
ALTER TABLE costing_projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE costing_lines           ENABLE ROW LEVEL SECURITY;
ALTER TABLE costing_line_vendors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE costing_line_compliance ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_costing_projects' AND tablename = 'costing_projects') THEN
    CREATE POLICY anon_all_costing_projects        ON costing_projects        FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_costing_lines' AND tablename = 'costing_lines') THEN
    CREATE POLICY anon_all_costing_lines           ON costing_lines           FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_costing_line_vendors' AND tablename = 'costing_line_vendors') THEN
    CREATE POLICY anon_all_costing_line_vendors    ON costing_line_vendors    FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_costing_line_compliance' AND tablename = 'costing_line_compliance') THEN
    CREATE POLICY anon_all_costing_line_compliance ON costing_line_compliance FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 7. PostgREST schema reload ────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
