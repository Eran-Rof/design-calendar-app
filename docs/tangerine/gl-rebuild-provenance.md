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

---

## 6. Intentional divergences from the pure Xoro mirror

The mirror is a faithful 1:1 copy of Xoro's GL. Where ROF's chart is more
granular than Xoro's and the correct split is *deterministically recoverable*
from the mirrored data, we layer a visible, reversible correction on top of the
mirror rather than mutating it. Each such divergence is **revenue-/expense-
group-internal and net-zero**, so the Trial Balance, Net Income, and any
period total (incl. Net Sales) are UNCHANGED — only the account-level split
differs from Xoro's lump. These are the only places Tangerine's GL intentionally
disagrees with Xoro account-by-account.

### 6.1 ROF Ecom revenue: 4005 → 4011  (#1725, 2026-07-13, CEO-directed)

**CEO:** *"sales revenue ecom should be on the sales revenue ecom account not
the rof brands income account."*

Xoro posts both ROF **wholesale** and ROF **ecom** sales into one account,
"Sales Revenue ROF Brands" → ROF **4005**; Xoro's website-revenue account is $0,
so ROF **4011 "Sales Revenue - ROF Ecom"** was empty. The channel is recovered
from the **invoice-number prefix** embedded in every mirror JE description
(`Xoro GL mirror - Invoice ROF ECOM-I##### (date)`): `ROF ECOM-I…` = ROF ecom,
`ROF-I…` = ROF wholesale. (`ar_invoices.channel_id` is **NOT** usable — 100% of
mirrored invoices default to "Wholesale / EDI", incl. all 13,379 ecom invoices;
the invoice prefix is the authoritative signal.)

- **Migration:** `20260985000000_channel_revenue_reclass_ecom.sql`.
- **Mechanism:** `channel_reclass` JEs via `gl_post_journal_entry()` (T11-audited
  posting path — sets `app.audit_reason`, fires all guard triggers). Chosen over
  mutating the mirror lines so pure Xoro provenance is preserved and the
  correction is visible/reversible.
- **Postings:** one balanced JE per calendar month with ROF-ecom revenue on 4005
  — `DR 4005 / CR 4011` for the month's net ecom credit. **23 JEs**, Sep-2024 →
  Jul-2026, dated to the **max ecom posting_date** in each month (a real Xoro
  txn date in-period; never today).
- **Total moved:** **$620,441.47** (4005 → 4011). Idempotent (guarded on
  `source_table='channel_reclass'`, `source_id='channel_reclass:rof_ecom:4005->4011:YYYY-MM'`);
  amount recomputed live from the original mirror lines, so apply-now +
  apply-on-merge is a safe no-op after the first.
- **Invariance proof (May-2026):** revenue-account net = **$3,136,128.01** and
  revenue-less-contra = **$3,127,848.14** are **unchanged**; 4005 fell exactly
  **$18,619.35** (→ $2,225,093.92) and 4011 rose exactly **$18,619.35**
  (→ $18,619.35). Global DR−CR imbalance = **$0.00**. The IS panel's **Net Sales
  = revenue 4000–4899 − contra_revenue = $3,127,848.14 − $2,566.02 =
  $3,125,282.12 — UNCHANGED** (both 4005 and 4011 sit in the 4000–4899 Net Sales
  band, so moving between them cannot change the total; the only Net-Sales input
  that changed is the 4005-vs-4011 split).
- **Companion COGS split — see §6.2** (the "NOT reclassed" item below is now
  DONE). A tiny amount of PT-prefixed revenue ($1,397.70) and "PBPT" ($332.10)
  also sits on 4005; left in place (out of the ecom scope).

### 6.2 ROF Ecom COGS: 5010 → 5014  (#1727, 2026-07-13, CEO-directed)

CEO (2026-07-13): "move cogs to correct account for ecom." Companion to §6.1 so
each channel shows a **true** gross margin (previously ecom revenue sat on 4011
while its cost stayed on 5010, giving the ecom line a ~100% fake margin and
loading ecom's cost onto ROF wholesale).

- **Migration:** `20260986000000_channel_cogs_reclass_ecom.sql`.
- **Mechanism:** identical to §6.1 — `channel_reclass` JEs via
  `gl_post_journal_entry()`, dated to each period's MAX ecom-COGS posting date.
- **Basis:** the SAME invoice-number prefix (`ROF ECOM-%`) on the mirror JE
  descriptions used for revenue, so ecom revenue and ecom cost move on the same
  invoice population → the ecom gross margin is internally consistent.
- **Postings:** one balanced JE per calendar month with ROF-ecom COGS on 5010 —
  `DR 5014 / CR 5010`. **23 JEs**, Sep-2024 → Jul-2026.
- **Total moved:** **$193,033.72** (5010 → 5014). 5010 $9,592,240.80 →
  **$9,399,207.08**; 5014 $0 → **$193,033.72**. Idempotent (guarded on
  `source_id='channel_reclass:rof_ecom_cogs:5010->5014:YYYY-MM'`).
- **Net effect:** COGS-internal, net-zero — total COGS (5010+5013+5014) =
  **$9,592,240.80 UNCHANGED**; Gross Profit unchanged. Global GL imbalance
  **$0.00**.

### 6.3 Psycho Tuna ecom: 4009→4008 revenue + 5012→5013 COGS  (#1729, 2026-07-13, CEO-directed)

CEO (2026-07-13): *"in xoro all pt ecom invoices carry Shopify psychotuna as the
customer … can you do the same for invoices and Cogs."* Companion to §6.1/§6.2 so
the PT ecom channel shows a true gross margin.

**Correcting an earlier wrong read:** a first probe keyed off the Xoro *store*
dimension and concluded PT ecom was $0 — because the store "Psycho Tuna Ecom"
(406 lines) carries only ecom **operating expenses** (Shopify fees/hosting, Meta +
Google ads, logistics, ~$100K). The PT ecom **sales and COGS** actually post under
store "Psycho Tuna" and are tagged by the **customer** — not a store or an invoice
prefix (every PT sale is `PT-I…`). Xoro puts all PT sales on **4009 "Sales Revenue
- PT"** and all PT COGS on **5012 "Cost of Goods Sold PT"**; the ecom slice is the
subset whose contact is **"Shopify psychotuna"** (both spellings, incl. a trailing
space). This is the same customer Tangerine uses to separate PT ecom inventory.

- **Migration:** `20260987000000_channel_reclass_pt_ecom.sql`.
- **Channel signal:** `xoro_gl_transactions.entity_full_name ILIKE '%shopify psychotuna%'`.
  The customer lives on the raw mirror **leg**, not the mirror JE lines, so PT-ecom
  transactions are the set of Xoro `txn_id`s with that customer, matched to mirror
  JEs via `journal_entries.source_id = txn_id` (one mirror JE = one Xoro txn).
  (Direct leg↔JE-line join would cartesian-explode — the raw table is ~7 legs/txn.)
- **Postings:** two balanced `channel_reclass` JEs per month —
  `DR 4009 / CR 4008` (revenue) and `DR 5013 / CR 5012` (COGS). **46 JEs**
  (23 rev + 23 COGS), Sep-2024 → Jul-2026.
- **Totals moved:** revenue **$190,772.06** (4009 $-631,165.29→**$-440,393.23**;
  4008 $0→**$-190,772.06**); COGS **$62,105.09** (5012 $429,116.06→**$367,010.97**;
  5013 $0→**$62,105.09**). PT ecom gross margin ≈ **67.4%**.
- **Net effect:** revenue-internal + COGS-internal, net-zero — PT total revenue
  ($-631,165.29) and PT total COGS ($429,116.06) **UNCHANGED**; Net Sales / Gross
  Profit unchanged; global GL imbalance **$0.00**. Idempotent (`source_id`
  `channel_reclass:pt_ecom_rev:4009->4008:YYYY-MM` and `…pt_ecom_cogs:5012->5013:…`).
