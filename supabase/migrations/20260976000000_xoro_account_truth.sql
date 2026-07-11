-- #xoro-account-truth (2026-07-11): persist the GL expense account that
-- Xoro's REST bill feed (bill/getbill) already carries on each bill line.
--
-- CEO directive (NON-NEG): Xoro's GL is the 100% source of truth for bill
-- classifications; nothing posts from name/pattern heuristics. The nightly
-- rof_xoro_project scripts/rest_ap_sync.py now emits an 'Expense Account'
-- column (billItemLineArr[].ItemExpenseAccountName, header
-- AccountExpenseName fallback — e.g. '5006 General and
-- Administrative:Logistics Warehouse Expense') plus an 'Item Type' column
-- (ItemTypeName; 'Inventory' means Xoro posts the line to the inventory
-- asset). /api/ap/sync-bills stores both verbatim and resolves the account
-- name to a ROF gl_accounts id when the leaf name matches exactly
-- (deterministic resolution in api/_lib/accounting/xoroAccountMap.js — no
-- fuzzy matching; unresolved names stay name-only for the mapping report).

ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS xoro_expense_account_name text,
  ADD COLUMN IF NOT EXISTS xoro_item_type text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS xoro_expense_account_name text;

COMMENT ON COLUMN public.invoice_line_items.xoro_expense_account_name IS
  'Verbatim Xoro GL account path for this bill line (bill/getbill billItemLineArr[].ItemExpenseAccountName, header AccountExpenseName fallback). CEO directive 2026-07-11: Xoro GL is the source of truth for bill classification. Resolved to expense_account_id via xoroAccountMap.js when the leaf name matches a ROF account exactly.';

COMMENT ON COLUMN public.invoice_line_items.xoro_item_type IS
  'Xoro ItemTypeName for the line (Inventory, Non-Inventory, Service, Miscellaneous, Expense). Inventory means Xoro itself posts the line to the inventory asset - classification truth for lines carrying no expense account name.';

COMMENT ON COLUMN public.invoices.xoro_expense_account_name IS
  'The single distinct Xoro expense account name across this bill''s lines when unambiguous (null when the lines carry zero or more than one distinct name). Header-grain convenience for the AP sweep and the 8007 xoro-verify recon.';

-- Compact per-bill evidence rollup for the 8007 xoro-verify recon
-- (scripts/reclass-8007.mjs). One row per (invoice, xoro account name, item
-- type, item-linked flag) keeps the client read small (~15k rows) instead of
-- paging ~150k raw lines through PostgREST.
CREATE OR REPLACE VIEW public.v_ap_bill_xoro_evidence AS
SELECT
  l.invoice_id,
  l.xoro_expense_account_name,
  l.xoro_item_type,
  (l.inventory_item_id IS NOT NULL) AS item_linked,
  count(*)::int AS n_lines,
  sum(round(coalesce(l.line_total, 0)::numeric * 100))::bigint AS cents
FROM public.invoice_line_items l
GROUP BY l.invoice_id, l.xoro_expense_account_name, l.xoro_item_type,
         (l.inventory_item_id IS NOT NULL);

COMMENT ON VIEW public.v_ap_bill_xoro_evidence IS
  'Per-bill rollup of Xoro GL account evidence on bill lines (#xoro-account-truth). Used by scripts/reclass-8007.mjs xoro-verify to compare where the 8007 reclass JEs put each (vendor, month) against where Xoro says the money belongs.';
