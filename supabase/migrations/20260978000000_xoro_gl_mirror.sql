-- ════════════════════════════════════════════════════════════════════════════
-- Xoro GL transaction mirror (#xoro-gl-truth, 2026-07-12)
--
-- CEO directive: Xoro's General Ledger is the 100% source of truth for every
-- remaining classification question. The AP bill-line feed (bill/getbill,
-- #1695) returns EXPENSE bills HEADER-ONLY over REST — so ~$6.81M of bills
-- carried no line/account evidence ("no-signal"). Xoro's dedicated GL endpoint
-- (accounting/getgltransactions, private app key scope "GL Details") exposes
-- the actual posted GL rows for EVERY transaction type, so those bills' expense
-- legs become visible. This table mirrors that endpoint, kept current nightly
-- by rof_xoro_project/scripts/rest_gl_sync.py -> POST /api/xoro/sync-gl.
--
-- ── ENDPOINT SHAPE (probed 2026-07-12) ──────────────────────────────────────
-- GET https://res.xorosoft.io/api/xerp/accounting/getgltransactions
--   Auth  : Basic base64(KEY:SECRET) — keyring service 'xoro-api-gl-details'.
--   Params: start_date/end_date (YYYY-MM-DD, MANDATORY pair), page_size
--           (MAX 100 — server rejects >100), page_number, and optional
--           filters account_gl_codes / account_ids / txn_numbers /
--           ref_numbers / exclude_closing_entries.
--   Body  : { Data:{ transactionList:[...], deletedTxnNumbers:[...] },
--             Page, TotalPages, Result, Message }.
--
-- ── PAGINATION IS PER-TRANSACTION, NOT PER-ROW (critical) ────────────────────
-- page_size counts TRANSACTIONS, not GL rows. Each page returns ALL GL rows for
-- its <=100 transactions, so rows-per-page VARIES wildly (637..4401 observed in
-- one 2-day window). TotalPages = ceil(distinct_txns / page_size). Walk pages
-- 1..TotalPages; a page's Data.transactionList holds the flattened GL rows.
--
-- ── DEBIT / CREDIT CONVENTION (probed & DOCUMENTED, per CEO ask) ─────────────
-- Amount / AmountHomeCurrency are a SINGLE SIGNED number per (txn, account)
-- leg. There are NO separate debit/credit columns and NO paired mirror rows —
-- one row per GL posting line.
--     POSITIVE Amount  = DEBIT
--     NEGATIVE Amount  = CREDIT
-- Every transaction's rows SUM TO 0.00 in AmountHomeCurrency (verified: 872/872
-- transactions in the probe window netted to zero). Worked example — Bill
-- 113590 (Venbrook, RefNumber ROF-B006546, $12,742.09):
--     row1  F_AccountingName '5006 General and Administrative:Rent Expense'
--           (OperatingExpenses)   Amount = +12742.09   -> DEBIT the expense
--     row2  F_AccountingName 'Accounts Payable (A/P)'
--           (AccountsPayable)     Amount = -12742.09   -> CREDIT AP (2000)
-- So to read a Bill's expense/asset distribution: take its rows where Amount>0
-- (or F_AccountingTypeName<>'AccountsPayable'); the negative AP leg is the 2000
-- credit. `amount`/`amount_home` are stored VERBATIM with Xoro's sign.
--
-- ── NATURAL KEY / IDEMPOTENCY ───────────────────────────────────────────────
-- No field combination is unique: (TxnId, F_AccountingId) had 1,404 dup keys in
-- the probe; even (TxnId,F_AccountingId,ItemId,Amount,Memo,EntityAccountId,Qty,
-- RefNumber2,StoreId) left 16 genuinely-identical rows (e.g. an invoice with two
-- identical revenue lines). A transaction is therefore the atomic unit. The
-- sync handler UPSERTS BY DELETE-THEN-INSERT PER txn_id: it deletes every
-- existing row for each incoming TxnId, then inserts the fresh set with a
-- per-txn ordinal `row_seq` (0-based, assignment order within the txn). This is
-- fully idempotent regardless of row order and correctly handles edited txns
-- (row count changes). The UNIQUE(txn_id, row_seq) index is the defensive guard.
--
-- ── DELETIONS ───────────────────────────────────────────────────────────────
-- Data.deletedTxnNumbers lists transactions voided/deleted in Xoro. The handler
-- DELETEs all mirror rows whose txn_number is in that list (hard delete — the
-- mirror reflects Xoro's live GL; the raw payload is retained per-row in `raw`
-- for surviving rows only). Counts are surfaced in the sync response.
--
-- RLS: financial data — service-role only, NO anon policies (matches the
-- 20260964 security-sprint posture and the 3-way-match / month-end tables).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS xoro_gl_transactions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id             uuid NOT NULL DEFAULT rof_entity_id(),

  -- transaction identity
  txn_id                text NOT NULL,            -- Xoro TxnId (stable per txn)
  txn_type_id           integer,                  -- TxnTypeId (101 = Bill, ...)
  txn_type_name         text,                     -- TxnTypeName (Bill/Invoice/...)
  txn_number            text,                     -- TxnNumber (Xoro internal seq)
  txn_date              date,                     -- TxnDate (MM/DD/YYYY -> date)
  row_seq               integer NOT NULL,         -- 0-based ordinal within txn

  -- counterparty
  entity_account_id     text,                     -- EntityAccountId (vendor/cust)
  entity_full_name      text,                     -- EntityFullName
  store_id              integer,                  -- StoreId
  store_name            text,                     -- StoreName

  -- the GL account this leg posts to (the classification truth)
  accounting_id         text,                     -- F_AccountingId
  accounting_type_id    integer,                  -- F_AccountingTypeId
  accounting_type_name  text,                     -- F_AccountingTypeName
  accounting_name       text,                     -- F_AccountingName (code:path)
  gl_code               text,                     -- GLCode (often empty)

  -- source-document reference
  ref_id                bigint,                   -- RefId
  ref_number            text,                     -- RefNumber (e.g. ROF-B006546)
  ref_number2           text,                     -- RefNumber2

  -- money (SIGNED: positive = debit, negative = credit)
  amount                numeric,                  -- Amount (txn currency)
  amount_home           numeric,                  -- AmountHomeCurrency (USD)
  currency_id           integer,                  -- CurrencyId
  currency              text,                     -- CurrencyName
  exchange_rate         numeric,                  -- ExchangeRate

  -- item / misc
  item_id               text,                     -- ItemId
  item_type_id          integer,                  -- ItemTypeId
  item_number           text,                     -- ItemNumber
  qty                   numeric,                  -- Qty
  memo                  text,                     -- Memo
  description           text,                     -- Description
  project_class_id      integer,                  -- ProjectClassId
  project_class_name    text,                     -- ProjectClassName
  sales_rep_id          text,                     -- SalesRepId
  custom_field          text,                     -- CustomField

  -- flags + provenance
  is_adjusting          boolean,                  -- IsAdjustingTransaction
  reconciled            boolean,                  -- ReconciledFlag
  deposited             boolean,                  -- DepositedFlag
  create_dttm           text,                     -- CreateDttm (raw Xoro string)
  create_source         text,                     -- CreateSource
  modify_dttm           text,                     -- ModifyDttm (raw Xoro string)
  modify_source         text,                     -- ModifySource

  raw                   jsonb,                    -- full source row (fidelity)
  synced_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  xoro_gl_transactions IS 'Mirror of Xoro accounting/getgltransactions (GL Details scope). One row per posted GL leg. Amount is SIGNED: +=debit, -=credit; every txn nets to 0 in amount_home. Upserted delete-then-insert per txn_id (rest_gl_sync.py -> /api/xoro/sync-gl). #xoro-gl-truth.';
COMMENT ON COLUMN xoro_gl_transactions.amount IS 'SIGNED leg amount in txn currency. POSITIVE = DEBIT, NEGATIVE = CREDIT (see migration header). Verbatim Xoro sign.';
COMMENT ON COLUMN xoro_gl_transactions.amount_home IS 'SIGNED leg amount in home currency (USD). Sum over a txn_number = 0.00.';
COMMENT ON COLUMN xoro_gl_transactions.accounting_name IS 'Xoro GL account path, e.g. ''5006 General and Administrative:Rent Expense''. Resolve to a ROF gl_accounts id via api/_lib/accounting/xoroAccountMap.js (leaf + code-prefix, exact only).';
COMMENT ON COLUMN xoro_gl_transactions.row_seq IS '0-based ordinal within a txn (assignment order). With txn_id it is the idempotency key; the handler deletes all rows for a txn_id before re-inserting.';

-- idempotency guard (delete-then-insert per txn makes reruns safe)
CREATE UNIQUE INDEX IF NOT EXISTS uq_xoro_gl_txn_row ON xoro_gl_transactions(txn_id, row_seq);

-- query paths used by gl-verify + reconciliation
CREATE INDEX IF NOT EXISTS idx_xoro_gl_txn_date       ON xoro_gl_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_xoro_gl_ref_number     ON xoro_gl_transactions(ref_number);
CREATE INDEX IF NOT EXISTS idx_xoro_gl_accounting_name ON xoro_gl_transactions(accounting_name);
CREATE INDEX IF NOT EXISTS idx_xoro_gl_entity_name    ON xoro_gl_transactions(entity_full_name);
CREATE INDEX IF NOT EXISTS idx_xoro_gl_txn_type       ON xoro_gl_transactions(txn_type_name);
CREATE INDEX IF NOT EXISTS idx_xoro_gl_txn_id         ON xoro_gl_transactions(txn_id);

ALTER TABLE xoro_gl_transactions ENABLE ROW LEVEL SECURITY;
-- No anon policies (financial table): service-role access only.

NOTIFY pgrst, 'reload schema';
