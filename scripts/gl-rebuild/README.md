# Xoro GL full rebuild (#xoro-gl-full-rebuild, 2026-07-13)

One-time, CEO-approved operation that replaced Tangerine's bottom-up GL
reconstructions with a faithful 1:1 double-entry mirror of the complete Xoro
General Ledger. Run once against PROD via `node scripts/run-sql-prod.mjs <file>`.
All steps are idempotent / resumable.

## Result
- **99,160** `journal_entries` (journal_type `xoro_gl_mirror`, one per Xoro
  `txn_id`), **694,527** lines, every JE balanced, global imbalance **$0.00**,
  DR=CR **$556,878,909.72**.
- Tangerine trial balance now equals Xoro **account-by-account to the cent**
  (total residual **$0.49**, isolated to 8001 Penny Rounding).
- 8007 Uncategorized Expense **$855K → $19.86**.
- May-2026 Net Income **$264,193.99** vs Xoro's $264,194.37 (±$0.38 rounding);
  Net Sales ties exactly at $3,125,282.12.

## Stages
- **Stage 0a** `stage0a_snapshot.sql` — reversible snapshot
  (`je_backup_20260713`, `jel_backup_20260713`, `tb_before_rebuild`). **Keep
  these tables — they are the one-step rollback.**
- **Stage 0b** — COA + `xoro_account_map` completion to 100%. Codified in
  migration `20260982000000_xoro_gl_full_rebuild.sql`.
- **Stage 1** `stage1_post_month_template.sql` — per-month set-based post
  (substitute `__YM__`, e.g. `sed 's/__YM__/2025-05/g'`). Posts every Xoro txn
  NOT already mirrored (idempotent by `source_id`=`txn_id`). Guards: a txn posts
  only if every leg maps AND rounded legs net to $0 (|residual| ≤ $1.00 routed to
  8001 Penny Rounding; > $1.00 skipped+reported). Triggers disabled atomically
  in a DO block. Skipped: 332 all-zero txns (no GL impact).
- **Stage 2** `stage2_delete_batch.sql` — retire bottom-up JEs in batches
  (all journal_types except `xoro_gl_mirror`; 41,875 deleted). Pre-null
  `ap_bill_register_import` NO-ACTION FKs first; other FKs are ON DELETE SET NULL.
- **Stage 3** `stage3_relink.sql` — re-link `ar_invoices` / `invoices`
  `accrual_je_id` to the mirror JE by document number (`invoice_number` = Xoro
  `ref_number`). AR 27,510 / AP 3,574 linked. Unmatched + amount-recon exported
  to `docs/tangerine/gl-rebuild-*.csv`. `cash_je_id` is NOT matchable by
  doc-number (Xoro payment txns carry their own payment refs) — done in Stage 4.
- **Stage 4** `stage4_cash_relink.sql` — re-link `ar_invoices` / `invoices`
  **`cash_je_id`** to the paying mirror JE. Key: Xoro payment legs name the
  document in their **memo** — *Invoice Payment* → `Invoice Ref # <invoice_number>`,
  *Bill Payment* → `…Bill# <invoice_number> Amount Paid …`; the paying JE is the
  mirror JE whose `source_id` = the payment `txn_id`. Deterministic
  single-payment matches only (paid across >1 txn → left null; a single FK can't
  hold several payment JEs). Result: **AR 8,755 / AP 3,186** cash-linked. FK-only
  on the subledger; no GL change. Idempotent.

## Audit / provenance
- Migration `20260983000000_gl_rebuild_audit_record.sql` writes the durable
  approved-event record to `audit_logs` (`entity_type='gl_rebuild'`): one row for
  the bulk mirror load, one for the Stage-4 cash re-link. Per-JE provenance is
  `source_id`=Xoro `TxnId` (triggers were disabled for the bulk load, so there
  are no per-JE T11 rows). Full controller record: `docs/tangerine/gl-rebuild-provenance.md`.

## Rollback
Restore `journal_entries` / `journal_entry_lines` from `je_backup_20260713` /
`jel_backup_20260713` (with immutability + period-lock + audit triggers
disabled), then re-null the subledger `accrual_je_id`/`cash_je_id` links.
