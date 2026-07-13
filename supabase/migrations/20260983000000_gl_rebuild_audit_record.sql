-- ════════════════════════════════════════════════════════════════════════════
-- GL full-rebuild — durable audit / provenance record  (2026-07-13, CEO-approved)
--
-- The 99,160 xoro_gl_mirror journal_entries (694,527 lines) were bulk-loaded
-- with the immutability / period-lock / T11 audit triggers disabled (a single
-- CEO-approved batch operation, not per-JE operator edits), so they carry no
-- per-JE audit rows. Per-JE provenance instead lives on each JE as
-- source_id = the originating Xoro TxnId (journal_type='xoro_gl_mirror').
--
-- This migration writes ONE durable narrative record of that approved event to
-- the general audit table (audit_logs), plus a companion record for the Stage-4
-- subledger cash_je_id re-link. Both are idempotent (guarded by the event key
-- in new_values->>'event') so a re-apply on merge is a no-op.
-- ════════════════════════════════════════════════════════════════════════════
DO $mig$
DECLARE
  v_rof text := rof_entity_id()::text;
BEGIN
  -- 1) Bulk mirror-load provenance record ─────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE entity_type='gl_rebuild' AND new_values->>'event'='xoro_gl_full_rebuild_bulk_load'
  ) THEN
    INSERT INTO audit_logs (entity_type, entity_id, action, old_values, new_values, user_label, source, created_at)
    VALUES (
      'gl_rebuild',
      v_rof,
      'bulk_mirror_load',
      NULL,
      jsonb_build_object(
        'event',            'xoro_gl_full_rebuild_bulk_load',
        'event_date',       '2026-07-13',
        'approved_by',      'CEO (Eran) — approved 2026-07-13; "go with your recommendation"',
        'performed_by',     'system / gl-rebuild batch (scripts/gl-rebuild/*, run once via run-sql-prod.mjs)',
        'summary',          'Replaced Tangerine''s bottom-up GL reconstructions with a faithful 1:1 double-entry mirror of the complete Xoro General Ledger.',
        'jes_loaded',       99160,
        'lines_loaded',     694527,
        'source_table',     'xoro_gl_transactions (99,492 Xoro txns; 332 all-zero txns skipped)',
        'journal_type',     'xoro_gl_mirror',
        'per_je_provenance','source_id = Xoro TxnId on every mirror JE (1 JE per Xoro txn_id)',
        'triggers_note',    'Immutability / period-lock / T11 audit triggers were disabled for the bulk load; that is why per-JE T11 rows are absent. This record is the approved-event substitute.',
        'bottomup_retired', 41875,
        'rollback_snapshot',jsonb_build_object(
                              'journal_entries', 'je_backup_20260713',
                              'journal_entry_lines', 'jel_backup_20260713',
                              'trial_balance', 'tb_before_rebuild'),
        'tie_out',          'Tangerine TB = Xoro account-by-account to the cent (residual $0.49, isolated to 8001 Penny Rounding); DR=CR $556,878,909.72.',
        'codified_in',      'migration 20260982000000_xoro_gl_full_rebuild.sql (schema/ref-data); scripts/gl-rebuild/README.md (operation)'
      ),
      'CEO-approved bulk mirror load (system batch)',
      'migration',
      '2026-07-13T00:00:00Z'
    );
  END IF;

  -- 2) Stage-4 subledger cash_je_id re-link provenance record ─────────────────
  IF NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE entity_type='gl_rebuild' AND new_values->>'event'='xoro_gl_full_rebuild_cash_relink'
  ) THEN
    INSERT INTO audit_logs (entity_type, entity_id, action, old_values, new_values, user_label, source, created_at)
    VALUES (
      'gl_rebuild',
      v_rof,
      'subledger_cash_relink',
      NULL,
      jsonb_build_object(
        'event',        'xoro_gl_full_rebuild_cash_relink',
        'event_date',   '2026-07-13',
        'summary',      'Re-linked subledger cash_je_id (payment JE) to the paying Xoro-mirror JE. FK-only on ar_invoices / invoices; no GL change.',
        'method',       'AR: Invoice Payment legs carry memo ''Invoice Ref # <invoice_number>''. AP: Bill Payment legs carry memo ''...Bill# <invoice_number> Amount Paid <amt>''. Paying JE = mirror JE whose source_id = the payment txn_id. Deterministic single-payment matches only; invoices/bills paid across >1 payment txn left null (a single FK cannot represent multiple payment JEs).',
        'ar_cash_linked', 8755,
        'ar_left_null',   19999,
        'ar_null_reason', 'unpaid/open, settled via Apply Customer Deposit/Credit (non-cash), Tangerine-native (non-Xoro) invoices, or 45 multi-payment-txn ambiguous',
        'ap_cash_linked', 3186,
        'ap_left_null',   534,
        'ap_null_reason', 'unpaid/open, other payment types, or 147 multi-payment-txn ambiguous',
        'script',       'scripts/gl-rebuild/stage4_cash_relink.sql (run once via run-sql-prod.mjs)'
      ),
      'GL-rebuild cash-side re-link (system batch)',
      'migration',
      '2026-07-13T00:00:00Z'
    );
  END IF;
END $mig$;
