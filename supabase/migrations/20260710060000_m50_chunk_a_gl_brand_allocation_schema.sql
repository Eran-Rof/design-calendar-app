-- 20260710060000_m50_chunk_a_gl_brand_allocation_schema.sql
-- ════════════════════════════════════════════════════════════════════════════
-- M50 GL Brand Allocation — Chunk A: schema.
--
-- Per docs/tangerine/P15-brand-gl-allocation-architecture.md. Pure NEW table +
-- two NEW columns on gl_accounts — zero changes to posting behavior (the engine
-- arrives in chunk C, gated). gl_accounts already has parent_account_id +
-- is_postable, so we only add the brand markers.
--
--   • gl_accounts.brand_id     — set on a brand-CHILD account (e.g. 6000-PT).
--                                NULL on normal/parent accounts.
--   • gl_accounts.brand_rollup — true on a PARENT that splits across brands
--                                (renders as header → children → subtotal on
--                                the Income Statement).
--   • brand_account_allocations — the %-allocation rule per (account, brand).
--                                 SUM(pct) per account = 100 (deferred check).
--                                 is_default marks the brand a posting defaults
--                                 to (ROF Wholesale convention set in the UI).
--
-- Idempotent. Applies to manual JE + AP-invoice expense postings (chunk C); AR
-- revenue uses the invoice's own brand directly (no allocation).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Brand markers on gl_accounts ─────────────────────────────────────────
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master(id) ON DELETE RESTRICT;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS brand_rollup boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_gl_accounts_brand  ON gl_accounts (brand_id);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent ON gl_accounts (parent_account_id);

-- ─── 2. brand_account_allocations — the %-split rule ─────────────────────────
CREATE TABLE IF NOT EXISTS brand_account_allocations (
  account_id   uuid NOT NULL REFERENCES gl_accounts(id)  ON DELETE CASCADE,
  brand_id     uuid NOT NULL REFERENCES brand_master(id) ON DELETE RESTRICT,
  pct          numeric(7,4) NOT NULL CHECK (pct >= 0 AND pct <= 100),
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_brand_acct_alloc_account ON brand_account_allocations (account_id);
-- At most one default brand per account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_acct_alloc_default
  ON brand_account_allocations (account_id) WHERE is_default;

-- ─── 3. SUM(pct)=100 per account — deferred constraint trigger ───────────────
-- Deferred so multi-row rule edits (delete+reinsert) are valid mid-transaction;
-- only the committed state must total 100. Accounts with NO allocation rows are
-- unconstrained (not split). 0.01 tolerance for numeric rounding.
CREATE OR REPLACE FUNCTION brand_account_allocations_sum_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct uuid := COALESCE(NEW.account_id, OLD.account_id);
  total numeric;
  n int;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(pct), 0) INTO n, total
  FROM brand_account_allocations WHERE account_id = acct;
  IF n > 0 AND ABS(total - 100) > 0.01 THEN
    RAISE EXCEPTION 'brand_account_allocations for account % must total 100%% (got %)', acct, total;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_brand_acct_alloc_sum ON brand_account_allocations;
CREATE CONSTRAINT TRIGGER trg_brand_acct_alloc_sum
  AFTER INSERT OR UPDATE OR DELETE ON brand_account_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION brand_account_allocations_sum_check();

-- ─── 4. T11 audit + RLS (anon read-only; writes via service-role COA handler) ─
DROP TRIGGER IF EXISTS trg_brand_acct_alloc_audit ON brand_account_allocations;
CREATE TRIGGER trg_brand_acct_alloc_audit
  AFTER INSERT OR UPDATE OR DELETE ON brand_account_allocations
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

ALTER TABLE brand_account_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_brand_acct_alloc" ON brand_account_allocations;
CREATE POLICY "anon_read_brand_acct_alloc" ON brand_account_allocations FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
