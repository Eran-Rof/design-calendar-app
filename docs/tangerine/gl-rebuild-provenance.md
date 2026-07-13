# GL full-rebuild — provenance, rollback & controller sign-off

**Status:** OPERATIONAL (applied to prod 2026-07-13). CEO-approved.
**Related:** `scripts/gl-rebuild/README.md` (the operation), migration
`20260982000000_xoro_gl_full_rebuild.sql` (schema/ref-data), migration
`20260983000000_gl_rebuild_audit_record.sql` (the durable audit record),
`docs/tangerine/user-guide/03-accounting.md` (operator callout).

This is the durable record the controller reviews. It documents *what the GL now
is*, *how each entry is traceable*, *how to undo it*, and *the sign-off items*.

---

## 1. Architecture — the GL is now the Xoro mirror

Tangerine's General Ledger is a faithful **1:1 double-entry mirror of Xoro's
complete General Ledger**, not a bottom-up reconstruction from the AR/AP
subledgers. Every posted Xoro transaction (table `xoro_gl_transactions`, the
nightly mirror of Xoro's `accounting/getgltransactions`) becomes exactly **one**
`journal_entries` row:

- **journal_type** = `xoro_gl_mirror`
- **source_id** = the Xoro `TxnId` (1 JE per Xoro `txn_id`; idempotent)
- **posting_date** = the Xoro transaction date (never the import date)
- each Xoro leg's signed `amount_home` → one JE line (**positive = debit,
  negative = credit**); Xoro account name → ROF account via `xoro_account_map`
- every JE balances by construction (each Xoro txn nets to $0); sub-cent
  precision drift is absorbed into **8001 Penny Rounding** (whole-ledger < $1)

**Scale:** 99,160 JEs / 694,527 lines, from 99,492 Xoro txns (332 all-zero txns
skipped). DR = CR **$556,878,909.72**. The bottom-up reconstructions
(41,875 JEs: `ar/ap_*_historical`, `vendor_*_reclass`, `ar_receipt_xoro`,
`ar_xoro_mirror_daily`, `ap_adjustment_historical`) were retired — the GL is now
**100% mirror**.

**Tie-out:** Tangerine trial balance = Xoro account-by-account **to the cent**
(residual $0.49, isolated to 8001 Penny Rounding). `8007 Uncategorized Expense`
fell from ~$855K to $19.86. May-2026 Net Sales ties exactly at $3,125,282.12;
Net Income $264,193.99 vs Xoro's $264,194.37 (±$0.38 rounding).

---

## 2. Provenance model — how each entry is traceable

The 99,160 mirror JEs were **bulk-loaded once** with the immutability,
period-lock, and T11 audit triggers disabled (a single approved batch operation,
not per-JE operator edits). As a result they carry **no per-JE T11 audit rows**.
This is intentional and CEO-approved. Provenance is instead carried on the row
itself:

> **Every mirror JE's `source_id` = the originating Xoro `TxnId`.**

Given any Tangerine mirror JE you can retrieve the exact Xoro transaction that
produced it (and vice-versa) — `xoro_gl_transactions.txn_id = journal_entries.source_id`
where `journal_type='xoro_gl_mirror'`. This is a complete, deterministic,
1:1 audit trail from the Tangerine GL back to the Xoro source ledger.

**Subledger links.** Invoice/bill detail still lives in Tangerine and re-links to
the mirror JE:

| Link | Table.column | Key | Coverage |
|---|---|---|---|
| Accrual (booking) | `ar_invoices.accrual_je_id` | `invoice_number` = Xoro `ref_number` | AR 27,510 |
| Accrual (booking) | `invoices.accrual_je_id` (AP) | `invoice_number` = Xoro `ref_number` | AP 3,574 |
| Cash (payment) | `ar_invoices.cash_je_id` | payment memo `Invoice Ref # <inv>` → payment `txn_id` → mirror JE | AR 8,755 |
| Cash (payment) | `invoices.cash_je_id` (AP) | payment memo `Bill# <bill> Amount Paid` → payment `txn_id` → mirror JE | AP 3,186 |

Cash links are **deterministic single-payment only**: an invoice/bill paid across
more than one payment transaction is left `NULL` (a single FK can't represent
several payment JEs). The remaining nulls are open/unpaid documents, deposits/
credits applied (non-cash), Tangerine-native (non-Xoro) documents, or the small
multi-payment set left null on purpose (AR 45, AP 147).

---

## 3. Rollback path (one step)

The pre-rebuild GL is preserved verbatim in snapshot tables. **Do not drop them.**

| Snapshot | Contents |
|---|---|
| `je_backup_20260713` | all `journal_entries` as they were before the rebuild |
| `jel_backup_20260713` | all `journal_entry_lines` as they were before the rebuild |
| `tb_before_rebuild` | the pre-rebuild trial balance |

**To restore:** with the immutability / period-lock / T11 audit triggers
disabled, truncate+reload `journal_entries` / `journal_entry_lines` from
`je_backup_20260713` / `jel_backup_20260713`, then re-null the subledger
`accrual_je_id` / `cash_je_id` links (they point at mirror JEs that would no
longer exist). See `scripts/gl-rebuild/README.md` §Rollback.

---

## 4. The durable audit record

Because the bulk load produced no per-JE T11 rows, the approved event itself is
recorded as a durable narrative in the general audit table **`audit_logs`**
(`entity_type='gl_rebuild'`), written by migration `20260983000000`:

| `new_values->>'event'` | action | what it records |
|---|---|---|
| `xoro_gl_full_rebuild_bulk_load` | `bulk_mirror_load` | the 99,160-JE / 694,527-line mirror load: source table, counts, `source_id` provenance mechanism, the disabled-triggers note, the rollback snapshot table names, tie-out, and CEO approval |
| `xoro_gl_full_rebuild_cash_relink` | `subledger_cash_relink` | the Stage-4 cash re-link: method, AR/AP linked counts, and the null counts + reasons |

Both rows are idempotent (guarded on the event key), `source='migration'`,
`entity_id` = the Ring of Fire entity. This is the single approved-event record
in lieu of 99,160 individual audit rows.

---

## 5. Controller sign-off items

1. **The deletions.** 41,875 bottom-up JEs (all `journal_type` except
   `xoro_gl_mirror`) were retired and replaced by the mirror. They are preserved
   in `je_backup_20260713` / `jel_backup_20260713`; nothing is unrecoverable.
2. **The audit approach.** Mirror JEs were bulk-loaded with audit/immutability
   triggers disabled → no per-JE T11 rows; provenance is `source_id` = Xoro
   `TxnId`, and the approved event is recorded once in `audit_logs`. **CEO
   approved this approach.**
3. **The tie-out.** Tangerine TB = Xoro TB account-by-account to the cent
   (residual $0.49 in 8001 Penny Rounding); DR=CR $556,878,909.72.
4. **Go-forward.** New Xoro transactions self-post nightly via the Xoro GL sync;
   operator-entered native JEs still post through the normal Journal Entry panel
   under the full posting guards. The rebuild deleted only superseded bottom-up
   reconstructions, never a native operator entry.
5. **Known residual.** A 2025 subledger line-total defect means some invoice
   detail line totals disagree with the (authoritative) mirror GL amount — the
   detail row is the one to true up (`docs/tangerine/gl-rebuild-amount-recon.csv`).
