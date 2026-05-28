-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P7-8 — Customer Service / Cases schema (arch §6)
--
-- Two new tables:
--   1. cases          — ticket master (status / severity / assignee / linked invoice|RMA|SO)
--   2. case_comments  — thread comments (internal vs customer-visible)
--
-- Forward FKs:
--   - cases.rma_id        nullable, no FK yet (M23 ships P19; column reserved)
--   - cases.sales_order_id nullable, no FK yet (M10 ships P16; column reserved)
--
-- case_number format: 'CASE-YYYY-NNNNN' (operator UI generates; entity-unique)
--
-- See docs/tangerine/P7-revenue-ops-architecture.md §6.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. cases ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  case_number        text NOT NULL,                                        -- 'CASE-2026-00042'
  customer_id        uuid REFERENCES customers(id) ON DELETE SET NULL,
  ar_invoice_id      uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  rma_id             uuid,                                                 -- forward column (M23 / P19)
  sales_order_id     uuid,                                                 -- forward column (M10 / P16)
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','resolved','closed')),
  severity           text NOT NULL DEFAULT 'normal'
                     CHECK (severity IN ('low','normal','high','urgent')),
  subject            text NOT NULL,
  body               text,
  assignee_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  external_email     text,                                                 -- inbound Resend sender
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT cases_number_per_entity_unique UNIQUE (entity_id, case_number),
  CONSTRAINT cases_subject_nonempty CHECK (char_length(trim(subject)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_cases_status_severity
  ON cases (status, severity);
CREATE INDEX IF NOT EXISTS idx_cases_customer
  ON cases (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cases_assignee
  ON cases (assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cases_invoice
  ON cases (ar_invoice_id) WHERE ar_invoice_id IS NOT NULL;

COMMENT ON TABLE cases IS 'P7 M47: lightweight customer-service ticket. Resolves once status flips to resolved/closed.';
COMMENT ON COLUMN cases.rma_id IS 'Forward column for M23 (P19 RMA). FK added once rmas table exists.';
COMMENT ON COLUMN cases.sales_order_id IS 'Forward column for M10 (P16 SO). FK added once sales_orders table exists.';
COMMENT ON COLUMN cases.external_email IS 'Inbound email sender (Resend webhook). Null for cases created in-app.';

-- Touch updated_at on every update (mirrors P1 pattern on other tables).
CREATE OR REPLACE FUNCTION cases_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  IF NEW.status IN ('resolved','closed') AND OLD.status NOT IN ('resolved','closed') THEN
    NEW.resolved_at = COALESCE(NEW.resolved_at, now());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cases_set_updated_at_trg ON cases;
CREATE TRIGGER cases_set_updated_at_trg
  BEFORE UPDATE ON cases
  FOR EACH ROW
  EXECUTE FUNCTION cases_set_updated_at();

-- ─── 2. case_comments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS case_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (char_length(trim(body)) > 0),
  is_internal     boolean NOT NULL DEFAULT true,
  external_email  text,                                                    -- inbound thread reply
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_comments_case
  ON case_comments (case_id, created_at);

COMMENT ON TABLE case_comments IS 'P7 M47: per-case thread. is_internal=true (default) means visible to internal users only; false reserved for future customer-portal exposure.';

-- ─── 3. RLS template (anon read filtered by entity / auth write) ───────────
ALTER TABLE cases          ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_comments  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_cases' AND tablename = 'cases') THEN
    CREATE POLICY anon_all_cases          ON cases          FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_case_comments' AND tablename = 'case_comments') THEN
    CREATE POLICY anon_all_case_comments  ON case_comments  FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 4. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
