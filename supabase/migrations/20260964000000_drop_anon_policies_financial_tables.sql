-- Security sprint (re-rate 2026-07-08, gap #1/#2): the financial tables all had
-- RLS enabled but carried blanket `anon_all_*` FOR ALL USING(true) policies —
-- equivalent to no protection, since the anon key ships in every browser
-- bundle. Drop the anon policies on the ledger + AR/AP + bank + commitments
-- set.
--
-- What keeps working after this:
--   - /api/internal handlers: service role bypasses RLS entirely.
--   - Internal users with a Supabase Auth session: `auth_internal_*` policies
--     (entity_users membership via auth.uid()) are untouched.
--   - Vendor portal: `vendor_own_*` policies (vendor_users via auth.uid())
--     on invoices / invoice_line_items / payments are untouched.
--   - `entities` keeps its anon read policy (vendor PortalLogin resolves the
--     entity name pre-auth; no financial data).
--
-- Verified before writing: no src/ (browser) code reads these tables with the
-- anon client — all financial panels go through /api/internal/*.

DROP POLICY IF EXISTS anon_all_journal_entries      ON journal_entries;
DROP POLICY IF EXISTS anon_all_journal_entry_lines  ON journal_entry_lines;
DROP POLICY IF EXISTS anon_all_gl_accounts          ON gl_accounts;
DROP POLICY IF EXISTS anon_all_gl_periods           ON gl_periods;
DROP POLICY IF EXISTS anon_all_gl_period_status_log ON gl_period_status_log;
DROP POLICY IF EXISTS anon_all_payments             ON payments;
DROP POLICY IF EXISTS anon_all_invoice_payments     ON invoice_payments;
DROP POLICY IF EXISTS anon_all_invoices             ON invoices;
DROP POLICY IF EXISTS anon_all_invoice_line_items   ON invoice_line_items;
DROP POLICY IF EXISTS anon_all_ar_invoices          ON ar_invoices;
DROP POLICY IF EXISTS anon_all_ar_invoice_lines     ON ar_invoice_lines;
DROP POLICY IF EXISTS anon_all_ar_receipts          ON ar_receipts;
DROP POLICY IF EXISTS anon_all_bank_accounts        ON bank_accounts;
DROP POLICY IF EXISTS anon_all_bank_transactions    ON bank_transactions;
DROP POLICY IF EXISTS anon_all_bank_recon_runs      ON bank_recon_runs;
DROP POLICY IF EXISTS anon_all_po_commitments       ON po_commitments;
DROP POLICY IF EXISTS anon_all_commission_accruals  ON commission_accruals;
DROP POLICY IF EXISTS anon_all_commission_payouts   ON commission_payouts;
