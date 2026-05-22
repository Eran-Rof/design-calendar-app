-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 8
-- gl_subledger_balances_v: read-only view of running subledger balances by
-- account × basis × subledger. View-only in P1 (per arch §4.1); promote to
-- materialized view after AR backfill load test (P4) if performance demands.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW gl_subledger_balances_v AS
SELECT
  je.entity_id,
  jel.account_id,
  je.basis,
  jel.subledger_type,
  jel.subledger_id,
  SUM(jel.debit)  AS balance_debit,
  SUM(jel.credit) AS balance_credit,
  SUM(jel.debit) - SUM(jel.credit) AS net_balance_debit,
  SUM(jel.credit) - SUM(jel.debit) AS net_balance_credit,
  MAX(je.posting_date) AS as_of_date
FROM journal_entry_lines jel
JOIN journal_entries     je  ON je.id = jel.journal_entry_id
WHERE je.status = 'posted'
GROUP BY je.entity_id, jel.account_id, je.basis, jel.subledger_type, jel.subledger_id;

COMMENT ON VIEW gl_subledger_balances_v IS 'Running balance per (entity, account, basis, subledger). Only posted journal_entries contribute. net_balance_debit is positive when the account has a debit balance; net_balance_credit is its negation. Promote to materialized view if posted-JE volume makes the live aggregation too slow.';
