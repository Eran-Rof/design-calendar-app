-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 5
-- gl_accounts: Chart of Accounts. Schema only; the seed COA arrives as a
-- separate data migration once the accountant supplies the canonical list
-- (see docs/tangerine/accountant-coa-request-email.md).
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gl_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code                 text NOT NULL,
  name                 text NOT NULL,
  account_type         text NOT NULL,
  account_subtype      text,
  parent_account_id    uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  normal_balance       text NOT NULL,
  is_postable          boolean NOT NULL DEFAULT true,
  is_control           boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'active',
  description          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT gl_accounts_code_unique UNIQUE (entity_id, code),
  CONSTRAINT gl_accounts_type_check
    CHECK (account_type IN ('asset','liability','equity','revenue','expense','contra_asset','contra_revenue')),
  CONSTRAINT gl_accounts_status_check
    CHECK (status IN ('active','inactive')),
  CONSTRAINT gl_accounts_normal_balance_check
    CHECK (normal_balance IN ('DEBIT','CREDIT'))
);

CREATE INDEX IF NOT EXISTS idx_gl_accounts_entity_type   ON gl_accounts (entity_id, account_type);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent        ON gl_accounts (parent_account_id);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_entity_status ON gl_accounts (entity_id, status);

COMMENT ON TABLE  gl_accounts                    IS 'Chart of Accounts. One row per postable or roll-up account per entity. Seed via accountant-supplied list (docs/tangerine/accountant-coa-request-email.md).';
COMMENT ON COLUMN gl_accounts.normal_balance     IS 'DEBIT or CREDIT. Derived from account_type at insert time (assets/expenses = DEBIT; liabilities/equity/revenue = CREDIT). Stored explicitly so the posting service can validate without re-deriving.';
COMMENT ON COLUMN gl_accounts.is_postable        IS 'False = roll-up parent only; the posting service rejects direct JE lines against non-postable accounts.';
COMMENT ON COLUMN gl_accounts.is_control         IS 'True for AR / AP / Inventory style accounts. Posting service requires subledger_type + subledger_id on every line hitting a control account.';

-- Bridging trigger: keep updated_at + updated_by fresh on every UPDATE.
CREATE OR REPLACE FUNCTION gl_accounts_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gl_accounts_touch_trg ON gl_accounts;
CREATE TRIGGER gl_accounts_touch_trg
  BEFORE UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION gl_accounts_touch();
