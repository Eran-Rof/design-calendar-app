-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P6-1 — Bank/CC Feeds + Reconciliation schema foundation
--
-- Adds four new tables for M7 (bank feeds) + M8 (reconciliation):
--   1. bank_accounts          — master record per bank/CC account, links to
--                                its GL cash account, holds Plaid credentials
--                                + sync metadata + auto-post fee rules.
--   2. bank_transactions      — raw transaction feed (Plaid / CSV / manual).
--                                State machine: unmatched → matched /
--                                manual_je_created / ignored / reversed.
--   3. bank_recon_runs        — per (account, period) reconciliation report.
--                                Captures bank-statement balance vs GL +
--                                uncleared txns; "reconciled" requires diff=0.
--   4. bank_match_audit       — append-only audit log; one row per match /
--                                unmatch / create_je / ignore action.
--
-- IMPORTANT: This migration does NOT rewire existing entities.default_bank_account_id
-- (which references gl_accounts directly per P3-1). The new bank_accounts table
-- is the NEW canonical reconciliation entity; the existing GL cash account FK
-- on entities continues to work unchanged. P6-2 / P6-5 handlers will resolve
-- bank_accounts.id via gl_account_id lookup as needed.
--
-- See docs/tangerine/P6-bank-recon-architecture.md §3, §4.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. bank_accounts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  gl_account_id       uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  account_kind        text NOT NULL DEFAULT 'checking'
                      CHECK (account_kind IN ('checking','savings','credit_card','line_of_credit','other')),
  institution_name    text,
  mask                text,              -- last 4 digits of account number (display only)

  -- Plaid linkage (nullable for CSV/manual accounts)
  plaid_item_id       text,
  plaid_account_id    text,
  plaid_access_token_ciphertext bytea,   -- pgcrypto-encrypted; service-role only
  plaid_cursor        text,              -- /transactions/sync cursor for incremental pulls

  feed_source         text NOT NULL DEFAULT 'manual'
                      CHECK (feed_source IN ('plaid','csv_upload','manual')),

  -- CSV-upload column mapping (operator-configured per account)
  csv_column_mapping  jsonb,             -- e.g. {"date":"Date","amount":"Amount","description":"Memo"}

  -- Auto-post fee/interest rules — JSONB array of
  --   { match: "regex", target_account_id: "<gl_uuid>", max_amount_cents: 1000 }
  -- Sync handler iterates these; lines matching get auto-JE'd.
  auto_post_fee_rules jsonb NOT NULL DEFAULT '[]'::jsonb,

  last_synced_at      timestamptz,
  current_balance_cents bigint,
  is_active           boolean NOT NULL DEFAULT true,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT bank_accounts_name_per_entity_unique UNIQUE (entity_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_accounts_plaid
  ON bank_accounts (plaid_account_id)
  WHERE plaid_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_accounts_entity
  ON bank_accounts (entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_gl_account
  ON bank_accounts (gl_account_id);

COMMENT ON TABLE bank_accounts IS 'P6 M7: master record per bank/CC account. Links to a GL cash account (gl_account_id) so reconciliation can JOIN to journal_entry_lines.';
COMMENT ON COLUMN bank_accounts.plaid_access_token_ciphertext IS 'pgcrypto pgp_sym_encrypt of the Plaid access_token, keyed by PLAID_TOKEN_ENC_KEY env var. Service-role only.';
COMMENT ON COLUMN bank_accounts.plaid_cursor IS 'Plaid /transactions/sync cursor for incremental pulls. Reset to NULL forces a full re-sync via /transactions/get.';
COMMENT ON COLUMN bank_accounts.auto_post_fee_rules IS 'JSONB array of {match, target_account_id, max_amount_cents}. Sync handler auto-JEs matching transactions; operator reviews the audit log.';

-- ─── 2. bank_transactions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  bank_account_id     uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  source              text NOT NULL CHECK (source IN ('plaid','csv_upload','manual')),
  external_txn_id     text,              -- Plaid transaction_id / CSV row hash / null for manual
  posted_date         date NOT NULL,
  amount_cents        bigint NOT NULL,   -- signed: positive=deposit, negative=withdrawal
  description         text,
  merchant_name       text,
  category            text[],            -- Plaid category hierarchy
  pending             boolean NOT NULL DEFAULT false,

  status              text NOT NULL DEFAULT 'unmatched'
                      CHECK (status IN ('unmatched','matched','manual_je_created','ignored','reversed')),
  matched_je_line_id  uuid REFERENCES journal_entry_lines(id) ON DELETE SET NULL,
  matched_at          timestamptz,
  matched_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  match_confidence    smallint,          -- 0..100

  notes               text,
  raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bank_txn_external_unique
    UNIQUE (bank_account_id, external_txn_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_txns_account_date
  ON bank_transactions (bank_account_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txns_unmatched
  ON bank_transactions (entity_id, status)
  WHERE status = 'unmatched';
CREATE INDEX IF NOT EXISTS idx_bank_txns_matched_je
  ON bank_transactions (matched_je_line_id)
  WHERE matched_je_line_id IS NOT NULL;
-- Critical for v_bank_match_candidates: lookup by (entity, amount, posted_date).
CREATE INDEX IF NOT EXISTS idx_bank_txns_amount_date
  ON bank_transactions (entity_id, amount_cents, posted_date);

COMMENT ON TABLE bank_transactions IS 'P6 M7: raw bank/CC transaction feed. State machine: unmatched → matched / manual_je_created / ignored / reversed. amount_cents signed (positive=deposit, negative=withdrawal).';
COMMENT ON COLUMN bank_transactions.match_confidence IS 'Match confidence 0..100. 100 = exact (amount + date) match. Populated by v_bank_match_candidates / bank_match_apply RPC.';

-- ─── 3. bank_recon_runs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_recon_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  bank_account_id     uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  period_id           uuid NOT NULL REFERENCES gl_periods(id) ON DELETE CASCADE,

  bank_statement_balance_cents bigint,    -- operator-typed from bank statement
  gl_balance_cents             bigint,    -- snapshot from v_balance_sheet at period_end
  uncleared_txn_cents          bigint,    -- sum of unmatched bank_transactions ≤ period_end
  reconciled_diff_cents        bigint,    -- gl + uncleared - bank_statement; 0 = reconciled

  status              text NOT NULL DEFAULT 'in_progress'
                      CHECK (status IN ('in_progress','reconciled','flagged')),
  notes               text,
  reconciled_at       timestamptz,
  reconciled_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bank_recon_unique UNIQUE (bank_account_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_runs_period
  ON bank_recon_runs (period_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_recon_runs_entity
  ON bank_recon_runs (entity_id, status, created_at DESC);

COMMENT ON TABLE bank_recon_runs IS 'P6 M8: per (bank_account, period) reconciliation report. status=reconciled requires reconciled_diff_cents=0.';

-- ─── 4. bank_match_audit ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_match_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  action              text NOT NULL
                      CHECK (action IN ('match','unmatch','create_je','ignore','manual_override','auto_post')),
  je_line_id          uuid REFERENCES journal_entry_lines(id) ON DELETE SET NULL,
  je_id_created       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  notes               text,
  actor_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_match_audit_txn
  ON bank_match_audit (bank_transaction_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_match_audit_entity
  ON bank_match_audit (entity_id, performed_at DESC);

COMMENT ON TABLE bank_match_audit IS 'P6 M8: append-only audit log; one row per match/unmatch/create_je/ignore action on a bank_transactions row.';

-- ─── 5. Touch triggers ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bank_accounts_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS bank_accounts_touch_trg ON bank_accounts;
CREATE TRIGGER bank_accounts_touch_trg
  BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION bank_accounts_touch();

CREATE OR REPLACE FUNCTION bank_transactions_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS bank_transactions_touch_trg ON bank_transactions;
CREATE TRIGGER bank_transactions_touch_trg
  BEFORE UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION bank_transactions_touch();

CREATE OR REPLACE FUNCTION bank_recon_runs_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS bank_recon_runs_touch_trg ON bank_recon_runs;
CREATE TRIGGER bank_recon_runs_touch_trg
  BEFORE UPDATE ON bank_recon_runs FOR EACH ROW EXECUTE FUNCTION bank_recon_runs_touch();

-- ─── 6. RLS — standard P1 template ─────────────────────────────────────────
ALTER TABLE bank_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_recon_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_match_audit     ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_all_bank_accounts" ON bank_accounts
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bank_accounts" ON bank_accounts
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon_all_bank_transactions" ON bank_transactions
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bank_transactions" ON bank_transactions
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon_all_bank_recon_runs" ON bank_recon_runs
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bank_recon_runs" ON bank_recon_runs
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- bank_match_audit: append-only — SELECT + INSERT policies only (no UPDATE/DELETE)
DO $$ BEGIN
  CREATE POLICY "anon_all_bank_match_audit_select_insert" ON bank_match_audit
    FOR SELECT TO anon USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_insert_bank_match_audit" ON bank_match_audit
    FOR INSERT TO anon WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bank_match_audit_select" ON bank_match_audit
    FOR SELECT TO authenticated
    USING (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bank_match_audit_insert" ON bank_match_audit
    FOR INSERT TO authenticated
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
