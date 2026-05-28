# Tangerine P6 — Bank/CC Feeds + Reconciliation Architecture Pass

Status: **DRAFT** (2026-05-28 morning). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the revised plan-approval-not-implementation rule.

Implements **M7 (Bank/CC Feeds)** + **M8 (Reconciliation Engine)** from the roadmap. P5 just shipped the close mechanics + four primary financial statements + year-end close. The next gap is operator's ability to **reconcile the cash side** — match bank/CC transactions against `v_cash_receipts_journal` (P4) + AP payments + manual JEs. Without that, the accountant manually checks every bank line against the GL each month, which is the single largest manual-effort line item left in the close workflow.

---

## 0. Scope guardrails

**In scope (this phase):**
- **Bank feeds** — connect to bank/CC accounts and ingest daily transaction lines into `bank_transactions`.
  - **Plaid** is the primary integration (US bank/CC coverage, OAuth, ~$0.30/account/month).
  - **CSV upload** is the fallback for non-Plaid accounts (small banks, foreign CCs).
  - **Manual entry** as a tertiary path for one-off corrections.
- **Bank account master** — extend the existing `bank_accounts` GL-mapping table with Plaid item/account ids, current_balance cache, last_sync_at.
- **Reconciliation engine** — match each `bank_transactions` row against candidate GL postings (cash JE lines). State machine: `unmatched` → `matched` / `manual_je_created` / `ignored`.
- **Match candidates view** — a JOIN view that pairs each unmatched bank transaction with possible GL matches (amount + date proximity + same bank account).
- **Match RPC** — applies an operator's match decision atomically (updates `bank_transactions.matched_je_line_id`, marks status, records audit row).
- **Standalone bank fees/interest** — for bank lines that don't match an existing GL line (e.g. monthly bank service fee, CC processing fee, interest income), allow one-click "Create JE" that posts a single-line adjustment.
- **Reconciliation report** — per-bank-account per-period: GL balance vs bank-statement balance vs uncleared transactions = reconciliation difference. The "is the bank statement reconciled to GL?" answer.
- **Admin UI panels** — Bank Accounts (extend existing), Bank Transactions (new — unmatched queue), Reconciliation Report.
- **Cross-cutter hooks** — M27 approvals on auto-JE creation above a threshold; M28 notifications when stale unreconciled balance exceeds operator-set threshold; M29 documents (attach bank statement PDFs to the recon period).

**Explicitly OUT of scope (deferred):**
- **Plaid Identity / Income / Asset products** — only Transactions is needed. Identity is for KYC (M40+); Income/Asset are for lending decisions (not relevant).
- **Multi-currency bank accounts** — single-currency USD per locked decision.
- **Automatic JE creation without operator confirmation** — every auto-suggest still requires an operator click to commit. ML auto-match is post-MVP.
- **Bank statement OCR** — PDF statements live in M29 (Documents) but are not parsed. Operator types reconciliation difference manually if needed.
- **Wire/ACH origination** — outbound payments to vendors happen via separate banking workflow (P21+); this phase only consumes incoming bank-side data.
- **Cash forecasting / liquidity dashboards** — that's M16+ (Revenue Ops) and M21 (Budgets). P6 only handles historical reconciliation, not forward-looking projections.

---

## 1. Existing state (one-paragraph map)

After P5: dual-basis GL with closing mechanics + the four primary financial statements + year-end close. `bank_accounts` already exists (from P2/P3 era — used by AP `apInvoicePaid` posting rule as the `default_bank_account_id` on entities). `v_cash_receipts_journal` (P4-1) lists every AR receipt as a JE-line snapshot. AP payments land in `journal_entry_lines` joined through `journal_entries.source_table='payments'` / `'invoice_payments'`. **There is no `bank_transactions` table yet** — no place to land bank-side data. **There is no recon state machine yet** — operator's accountant manually checks bank statements against GL each month outside the system. **Plaid is not integrated.**

---

## 2. Decisions feeding this pass

- **Plaid as primary feed.** US apparel operator with a handful of bank+CC accounts; Plaid is the industry standard, ~$3.60/account/year. Manual sync via existing `daily_check` cron pattern. Single-entity for launch keeps the cost trivial.
- **CSV fallback.** Operator uploads a CSV exported from their bank's online portal. Same `bank_transactions` table, source flag `'csv_upload'` vs `'plaid'`. Operator can paste a CSV at any time to recover a missed sync or backfill historical data pre-Plaid.
- **Single-currency USD throughout.** Foreign-currency CC transactions (rare for operator) flagged and excluded from auto-match — operator handles via manual JE.
- **Rule-based matching, ML later.** MVP uses (amount, date ±3 days, bank_account) for exact match candidates; operator manually picks among candidates. M46 (BI/Analytics) can add ML auto-match in P24.
- **Continuous sync + monthly reconciliation.** Plaid pulls every 4 hours via existing cron infrastructure. Operator runs the reconciliation report monthly as part of the close workflow (P5-1 close pre-flight gets a new check: "all bank transactions through period-end are reconciled or ignored").
- **Audit immutability.** Once a bank transaction is matched to a JE line, the match record is append-only. Unmatching creates a `match_reversal` row, not a destructive update. Same pattern as `inventory_consumption` (P3-3) for FIFO consumption.
- **Auto-JE for bank fees/interest is opt-in.** Operator opts in per bank account via a `bank_accounts.auto_post_fee_rules` JSONB column. Without rules, every standalone line waits for operator review.

---

## 3. M7 — Bank/CC Feeds schema

### 3.1 `bank_accounts` (extension)

Existing table from P3 era — extended:

```sql
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS
  plaid_item_id     text,              -- Plaid Item.item_id (one Item per linked institution)
  plaid_account_id  text,              -- Plaid Account.account_id (sub-account inside Item)
  plaid_access_token_ciphertext bytea, -- service-role only; encrypted at rest
  last_synced_at    timestamptz,
  current_balance_cents bigint,        -- last-known balance from Plaid; staleness check via last_synced_at
  feed_source       text NOT NULL DEFAULT 'manual'
                    CHECK (feed_source IN ('plaid','csv_upload','manual')),
  auto_post_fee_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
                                       -- e.g. [{"match":"NSF FEE","account":"<gl_account_uuid>"}]
  is_active         boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX uq_bank_accounts_plaid
  ON bank_accounts(plaid_account_id)
  WHERE plaid_account_id IS NOT NULL;
```

`plaid_access_token_ciphertext` is bytea (encrypted with the existing `pgsodium`/vault pattern used in P3 for the M4 backfill paths — or a simpler `pgcrypto` PGP_SYM_ENCRYPT if pgsodium is overkill). Decryption is service-role only — the handler decrypts before calling Plaid.

### 3.2 `bank_transactions` (new)

The raw transaction feed. One row per bank/CC line, regardless of source:

```sql
CREATE TABLE bank_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  bank_account_id   uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  source            text NOT NULL CHECK (source IN ('plaid','csv_upload','manual')),
  external_txn_id   text,             -- Plaid transaction_id, or CSV row id, or null for manual
  posted_date       date NOT NULL,
  amount_cents      bigint NOT NULL,  -- signed: positive=deposit, negative=withdrawal
  description       text,
  merchant_name     text,
  category          text[],           -- Plaid category hierarchy, optional
  pending           boolean NOT NULL DEFAULT false,  -- Plaid pending flag; recon ignores pending
  status            text NOT NULL DEFAULT 'unmatched'
                    CHECK (status IN ('unmatched','matched','manual_je_created','ignored','reversed')),
  matched_je_line_id uuid REFERENCES journal_entry_lines(id) ON DELETE SET NULL,
  matched_at        timestamptz,
  matched_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  match_confidence  smallint,          -- 0..100; 100 = exact (amount + date) match; null for manual matches
  notes             text,
  raw_payload       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- full Plaid response for audit
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_transactions_external_unique
    UNIQUE (bank_account_id, external_txn_id) DEFERRABLE
);

CREATE INDEX idx_bank_txns_account_date  ON bank_transactions (bank_account_id, posted_date DESC);
CREATE INDEX idx_bank_txns_unmatched     ON bank_transactions (entity_id, status) WHERE status = 'unmatched';
CREATE INDEX idx_bank_txns_matched_je    ON bank_transactions (matched_je_line_id) WHERE matched_je_line_id IS NOT NULL;
CREATE INDEX idx_bank_txns_amount_date   ON bank_transactions (entity_id, amount_cents, posted_date);  -- match-candidate lookup
```

Touch trigger on `updated_at`. P1 RLS template.

### 3.3 `bank_recon_runs` (new — reconciliation report state)

One row per (bank_account, period) reconciliation:

```sql
CREATE TABLE bank_recon_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  bank_account_id   uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  period_id         uuid NOT NULL REFERENCES gl_periods(id) ON DELETE CASCADE,
  bank_statement_balance_cents bigint,   -- operator-typed from bank statement
  gl_balance_cents  bigint,              -- snapshot at period-end of v_balance_sheet for this bank account
  uncleared_txn_cents bigint,            -- bank_transactions still unmatched as of period-end
  reconciled_diff_cents bigint,          -- gl_balance + uncleared - bank_statement; should = 0 to reconcile
  status            text NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','reconciled','flagged')),
  notes             text,
  reconciled_at     timestamptz,
  reconciled_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, period_id)
);

CREATE INDEX idx_bank_recon_runs_period ON bank_recon_runs (period_id, status);
```

Touch trigger + RLS.

### 3.4 `bank_match_audit` (new — append-only audit log)

```sql
CREATE TABLE bank_match_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  action              text NOT NULL
                      CHECK (action IN ('match','unmatch','create_je','ignore','manual_override')),
  je_line_id          uuid REFERENCES journal_entry_lines(id) ON DELETE SET NULL,
  je_id_created       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  notes               text,
  actor_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_match_audit_txn ON bank_match_audit (bank_transaction_id, performed_at DESC);
```

Append-only — no UPDATE or DELETE policies in RLS.

---

## 4. M8 — Reconciliation Engine

### 4.1 Match candidate view `v_bank_match_candidates`

For each unmatched `bank_transactions` row, list every `journal_entry_lines` row that could plausibly match:

```sql
CREATE OR REPLACE VIEW v_bank_match_candidates AS
SELECT
  bt.id              AS bank_transaction_id,
  bt.entity_id,
  bt.bank_account_id,
  bt.posted_date     AS bank_date,
  bt.amount_cents    AS bank_amount_cents,
  bt.description     AS bank_description,
  jel.id             AS je_line_id,
  je.id              AS je_id,
  je.posting_date    AS je_date,
  je.description     AS je_description,
  je.journal_type,
  je.basis,
  jel.account_id,
  ga.code            AS account_code,
  ga.name            AS account_name,
  -- Signed cents on the JE side: positive when this line is a DR on a bank
  -- account (= incoming deposit on GL side), negative when CR (= withdrawal).
  CASE
    WHEN ga.normal_balance = 'DEBIT' THEN jel.debit - jel.credit
    ELSE jel.credit - jel.debit
  END::bigint        AS je_amount_cents,
  ABS(bt.posted_date - je.posting_date)::int AS days_apart,
  -- 100 = exact same amount + date; falls off with date distance
  GREATEST(
    0,
    100 - (ABS(bt.posted_date - je.posting_date)::int * 5)
  )::smallint        AS confidence
FROM bank_transactions bt
JOIN bank_accounts ba ON ba.id = bt.bank_account_id
JOIN journal_entry_lines jel ON jel.account_id = ba.gl_account_id
JOIN journal_entries je ON je.id = jel.journal_entry_id
JOIN gl_accounts ga ON ga.id = jel.account_id
WHERE bt.status = 'unmatched'
  AND bt.pending = false
  AND je.status = 'posted'
  AND je.basis = 'CASH'   -- cash-book only; accrual is invariant w.r.t. bank movement
  AND ABS(je.posting_date - bt.posted_date) <= 5
  AND (
    -- amount match: signed deposit/withdrawal sign matches the JE side
    bt.amount_cents = CASE
      WHEN ga.normal_balance = 'DEBIT' THEN jel.debit - jel.credit
      ELSE jel.credit - jel.debit
    END
  )
  -- skip JE lines that already have a bank match
  AND NOT EXISTS (
    SELECT 1 FROM bank_transactions bt2
    WHERE bt2.matched_je_line_id = jel.id
  );

COMMENT ON VIEW v_bank_match_candidates IS 'M8: per-unmatched bank transaction, list of plausible GL match lines (cash basis, same bank account, ±5 days, exact-amount). Operator picks via the Bank Transactions admin panel.';
```

Confidence formula is conservative — same-day exact amount = 100; ±5 days = 75. Operator filters to confidence ≥ 90 by default.

### 4.2 Match RPC

```sql
CREATE OR REPLACE FUNCTION bank_match_apply(
  p_bank_transaction_id uuid,
  p_je_line_id          uuid,
  p_actor_user_id       uuid DEFAULT NULL,
  p_notes               text DEFAULT NULL
) RETURNS bank_transactions
LANGUAGE plpgsql
```

Validates:
- bank_transaction is `unmatched`
- je_line is on the same bank account
- je_line is not already matched by another bank_transaction

On success: UPDATEs `bank_transactions` (status='matched', matched_je_line_id, matched_at, matched_by_user_id, match_confidence), inserts `bank_match_audit` row with action='match'. Returns the updated bank_transaction.

### 4.3 Unmatch RPC

```sql
CREATE OR REPLACE FUNCTION bank_unmatch(
  p_bank_transaction_id uuid,
  p_actor_user_id       uuid DEFAULT NULL,
  p_notes               text DEFAULT NULL
) RETURNS bank_transactions
```

Sets status='unmatched', clears matched_je_line_id, inserts audit row with action='unmatch'.

### 4.4 Manual-JE-from-bank-transaction RPC

```sql
CREATE OR REPLACE FUNCTION bank_create_je_for_transaction(
  p_bank_transaction_id uuid,
  p_target_gl_account_id uuid,  -- the OTHER side of the JE (e.g. bank fee expense)
  p_actor_user_id       uuid DEFAULT NULL,
  p_memo                text DEFAULT NULL
) RETURNS jsonb
```

For standalone bank lines (fees, interest, transfers between accounts not in our books). Builds a 2-line JE: DR/CR bank account + opposite side on `p_target_gl_account_id`. Posts via `gl_post_journal_entry`. Marks bank_transaction status='manual_je_created' and matches it to the new JE line. Inserts audit row with action='create_je'.

### 4.5 Auto-suggest from `auto_post_fee_rules`

When Plaid sync inserts a bank_transactions row, the cron post-step iterates `bank_accounts.auto_post_fee_rules` (JSONB array of `{match: regex, account: gl_account_uuid}`) — if the transaction's description matches a rule's regex AND the amount is below a per-account threshold, automatically calls `bank_create_je_for_transaction`. Operator can review the auto-posted JE in the audit log + reverse if needed.

---

## 5. Plaid integration

### 5.1 Architecture

- **Item linking**: operator initiates via the Tangerine Bank Accounts panel → backend calls Plaid's `/link/token/create` → returns a public link_token → frontend renders Plaid Link → operator picks bank + signs in → Plaid returns a public_token → backend exchanges via `/item/public_token/exchange` → gets access_token → encrypted + stored in `bank_accounts.plaid_access_token_ciphertext`.
- **Webhook receiver** (`api/webhooks/plaid.js`): Plaid pings us on `DEFAULT_UPDATE` (new transactions available) and `INITIAL_UPDATE` (first sync ready). The webhook handler enqueues a sync job and returns 200 immediately.
- **Sync cron** (`api/cron/bank-feed-sync.js`): runs every 4 hours per `vercel.json`. For each active bank_account with plaid_access_token, calls Plaid `/transactions/sync` (the cursor-based incremental endpoint, NOT the deprecated `/transactions/get`), upserts rows by `(bank_account_id, external_txn_id)`, updates `current_balance_cents` + `last_synced_at`.
- **Secret storage**: `PLAID_CLIENT_ID` + `PLAID_SECRET` in Vercel env. Access tokens encrypted via pgcrypto's `pgp_sym_encrypt(token, encryption_key)` with the key in env. Decryption is sealed inside an RPC `bank_get_plaid_access_token(p_bank_account_id)` that requires service-role to call.

### 5.2 Costs

Plaid's "Production" tier billing:
- Transactions product: **$0.30/Item/month** + free webhooks
- Operator's expected setup: 1 checking + 2 CC = 3 Items × $0.30 = **$0.90/month**. Trivial.

### 5.3 Plaid Sandbox

For development + tests: `PLAID_ENV=sandbox` uses Plaid's free sandbox tier. Switch via env var; no code change. The sandbox supplies a mock bank "Tartan Bank" with synthetic transactions.

### 5.4 Out-of-scope

- **Investments product** — no holdings reporting needed.
- **Identity / Income / Assets** — none relevant.
- **Transfer (ACH origination)** — separate phase.

---

## 6. CSV upload path

Operator exports a CSV from their online banking portal (every US bank supports this in 2026). Format varies — handler is permissive:

- Parses headers; tries to match common column names (`Date`, `Description`, `Amount` / `Debit` + `Credit`, etc.)
- Operator confirms mapping in a one-time setup modal per bank account
- INSERT rows with `source='csv_upload'` + `external_txn_id` = a hash of `(posted_date|amount_cents|description)` for dedup across re-uploads

Same downstream matching engine. Operator can re-upload the same CSV; dedup blocks duplicates.

### 6.1 Migration data path

For historical data (operator wants reconciled books going back to 2024-08-31 per P4-8): export bank statements as CSV monthly, upload one at a time, run match engine, reconcile each historical period. This is the "backfill the bank side" companion to P4-8's AR backfill.

---

## 7. Admin UI surfaces

Tangerine → 💼 Accounting gets two new panels:

| Panel | Emoji | Purpose |
|---|---|---|
| **Bank Accounts** | 🏦 | Existing concept, extended. Link Plaid + manage CSV upload + view current balance. |
| **Bank Transactions** | 🔁 | Unmatched-queue browser. Per-row: match suggestion, Apply / Create JE / Ignore buttons. |
| **Reconciliation** | ⚖️ | Per-bank-account per-period recon report. Shows GL balance vs bank statement vs uncleared. "Mark reconciled" button. |

Existing **Periods** panel pre-flight gets one more check (P5-7 extension): `bank_recon_complete` — all bank_accounts for the entity have a `bank_recon_runs` row with `status='reconciled'` for this period.

---

## 8. RLS

All new tables (`bank_transactions`, `bank_recon_runs`, `bank_match_audit`) use the standard P1 template — `anon_all` + `auth_internal_*` scoped through `entity_users.auth_id`.

`bank_match_audit` has SELECT + INSERT-only policies (no UPDATE/DELETE) for append-only audit.

`bank_accounts.plaid_access_token_ciphertext` is service-role only — exposing it to auth/anon would defeat the encryption. Achieved via a column-level SELECT GRANT revoke or via storing in a separate `bank_account_secrets` table with restricted RLS.

---

## 9. Cross-cutter hooks (M27/M28/M29 recap)

- **M27 Approvals**: new rule kinds `bank_match_above_threshold` (manual matches > $X require admin approval) and `bank_auto_je_above_threshold` (auto-posted bank fees > $X require approval). Defaults: no rule = no gate. Operator opts in via M27 admin panel.
- **M28 Notifications**: new kinds `bank_sync_failed` (Plaid sync error), `bank_unmatched_high_count` (> 50 unmatched older than 30 days), `bank_recon_period_diff` (recon difference non-zero at period close).
- **M29 Documents**: bank-statement PDFs attached per `bank_recon_runs` row via existing DocumentAttachmentList drop-in. New context table allowed: `bank_recon_runs` with kinds `['bank_statement','adjustment_memo','other']`.

---

## 10. Chunk split (implementation — DO NOT start until operator approves)

| Chunk | Scope | Tests target |
|---|---|---|
| **P6-1** | Schema: bank_accounts extension + bank_transactions table + bank_recon_runs + bank_match_audit + RLS + indexes | 40-60 |
| **P6-2** | Plaid integration: link-token + public-token-exchange handlers + encrypted token storage + sync cron | 50-70 |
| **P6-3** | CSV upload handler + per-account column mapping config | 30-40 |
| **P6-4** | Match RPCs (apply / unmatch / create-je) + v_bank_match_candidates view | 40-60 |
| **P6-5** | Bank Transactions admin panel (unmatched queue + match flow) | 30-40 |
| **P6-6** | Reconciliation Report panel + bank_recon_runs CRUD + period-close pre-flight integration | 40-60 |
| **P6-7** | Auto-post fee rules + cron sync auto-suggest path | 30-40 |

Implementation order: P6-1 → P6-2 + P6-3 (parallel — different file scopes) → P6-4 → P6-5 + P6-6 (parallel) → P6-7. Total ~7 chunks, similar to P4/P5.

---

## 11. Sub-decisions deferred to implementation

- **Encryption library:** `pgcrypto` (built-in, requires manual key management) vs Supabase Vault (managed, but adds a dependency). Recommend pgcrypto for simplicity; the key lives in Vercel env (`PLAID_TOKEN_ENC_KEY`).
- **Match-candidate confidence formula:** the 100 − (days_apart × 5) shape is a starting point. If operator finds too many false-positives, tighten to ±2 days + bump the penalty to ×10.
- **Per-account opening balance bootstrap:** how do we set GL balance = bank statement at recon launch? Either (a) operator enters opening balance as a one-time adjustment JE during P6-1, or (b) defer to first reconciliation cycle. Recommend (a) for clarity.
- **Plaid webhook signature verification:** Plaid signs webhooks with a JWT. Recommend full verification (the `Plaid-Verification` header pattern) to prevent spoofed requests.
- **CSV column-mapping persistence:** stored on `bank_accounts.attributes` jsonb (cheap) or a dedicated `bank_account_csv_columns` table (cleaner). Recommend attributes-jsonb for MVP.

---

## 12. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Plaid access tokens leak (e.g. in logs) | low | severe | Token never logged; encrypted at rest; rotation supported via Plaid `/item/access_token/update` |
| Duplicate bank_transactions rows from Plaid pagination | low | medium | UNIQUE (bank_account_id, external_txn_id) + ON CONFLICT DO NOTHING on insert |
| Plaid /transactions/sync cursor gets out of sync | medium | medium | Store cursor on bank_accounts; on cursor-invalid error, full re-pull via `/transactions/get` with date window; alert operator |
| Operator matches the wrong JE line | medium | medium | Audit log captures every match; unmatch is one click; M27 rule gates can require admin approval for matches > $X |
| CSV format varies per bank → bad parse | medium | medium | Permissive parser + one-time column mapping per account + manual edit path |
| Bank statement balance typed wrong → recon shows false reconciled | medium | severe | Recon report flags "diff > $0.01 but status='reconciled'" with a yellow warning; operator must confirm |
| pgcrypto encryption key rotation | low | medium | Keep key in env; rotation requires re-encrypting all `plaid_access_token_ciphertext` blobs; ship a migration helper for this |

---

## 13. Out of scope (explicit recap)

1. Plaid Identity / Income / Assets / Investments / Transfer products
2. Multi-currency bank accounts
3. ML auto-match (M46 BI in P24)
4. Bank statement OCR
5. Outbound wire/ACH origination
6. Cash forecasting / liquidity dashboards (M16 + M21)
7. Bank reconciliation across multiple legal entities (single-entity at launch)

---

## 14. Approval handshake

This arch doc auto-merges on CI green per the revised plan-approval-not-implementation rule. **Implementation chunks (P6-1 through P6-7) require explicit operator approval before the first PR opens**. Operator's "continue with P6" on the implementation step counts as blanket approval; chunks roll forward automatically.

**Kickoff prerequisites:**
- Operator decides: Plaid Production tier ($0.90/mo for 3 accounts) — confirm enrollment willingness, or fall back to CSV-only mode (no monthly cost; manual sync each time).
- Operator obtains Plaid credentials and adds `PLAID_CLIENT_ID` + `PLAID_SECRET` + `PLAID_ENV` (sandbox/production) + `PLAID_TOKEN_ENC_KEY` to Vercel env. Without these, P6-2 ships in sandbox-only mode.
- Operator confirms encryption library choice (pgcrypto vs Vault — recommend pgcrypto).
- Operator confirms match-candidate window (±5 days default; tighter if false-positive heavy).
- Operator types opening balance for each bank account at P6-6 launch — bootstraps GL balance = bank statement.

**Dispatch order once approved:** P6-1 first (foundation schema), then P6-2 + P6-3 in parallel, then P6-4, then P6-5 + P6-6 in parallel, then P6-7. Estimated 1-2 sessions at the pace P5 set.
