# 14. Payment Terms

Tangerine P3 Chunk 9 (2026-05-27). The Payment Terms panel is reference data — short structured codes that let AP and AR invoices compute their due date automatically from a posting date, instead of pasting "Net 30" or "due in 45 days" into a free-text field on every vendor / customer.

URL: `/tangerine` → top nav → 📆 **Payment Terms** (Master Data group).

## What payment terms are and how they're used

Each row is `(code, name, due_days, discount_pct, discount_days, is_active)`. The only fields the posting flow consumes today are `name` and `due_days`; the discount fields are reserved for an early-payment workflow that lands in a later P-phase.

**Codes are server-generated and read-only.** Every row gets an organized sequential code `TERM-00001`, `TERM-00002`, … assigned automatically on save (you never type it). The codes are display labels only — nothing in the app matches on the code value (vendors, customers, invoices, and costing all reference a term by its internal id or by `name`). The existing rows were renumbered into one contiguous `TERM-NNNNN` block, and each new term continues the sequence.

The chain at posting time:

```
invoice.posting_date + payment_terms.due_days = invoice.due_date
```

That's surfaced via a Postgres helper function `compute_due_date(anchor_date, payment_terms_id)` that returns `NULL` if either argument is null. AP and AR posting code calls this when stamping a freshly-posted invoice with its due date.

Each vendor and customer can have a default `payment_terms_id`. The invoice's own `payment_terms_id` overrides the counterparty default — useful when a specific PO ships with non-standard terms.

## Seeded defaults

The migration seeds the common terms for the ROF entity on first deploy (originally with semantic codes like `NET30` / `COD`; these were later renumbered to the organized `TERM-NNNNN` scheme — the **Name** is now the human-facing identifier):

| Name | Due days | Discount % | Discount days |
|---|---:|---:|---:|
| Cash on Delivery | 0 | — | — |
| Due on Receipt | 0 | — | — |
| Net 10 | 10 | — | — |
| Net 15 | 15 | — | — |
| Net 30 | 30 | — | — |
| Net 45 | 45 | — | — |
| Net 60 | 60 | — | — |
| Net 90 | 90 | — | — |
| 2/10 Net 30 | 30 | 2.00% | 10 |

The seed is defensive — it skips if any `payment_terms` rows already exist for ROF, so re-running the migration is safe. Operators have since added the DDP / longer-net variants (DDP 30…180, Net 120/150/180) directly in the panel.

## Adding a new term (e.g. Net 75)

1. **Open the panel.** `/tangerine` → 📆 **Payment Terms**.
2. **Click `+ Add term`.**
3. **Fill in:**
   - **Code:** read-only — shows `(auto-generated on save)` and is stamped with the next `TERM-NNNNN` automatically. The Code box in the add/edit form matches the Due Date field's width and the Name field's height.
   - **Name:** `Net 75` — anything human-readable; this is what appears in the vendor / customer dropdowns and is the identifier the rest of the app keys off.
   - **Due days:** `75` — integer, ≥ 0.
   - **Discount % / Discount days:** leave at 0 unless you're encoding a discount like `5/15 Net 60` (`discount_pct=0.05`, `discount_days=15`, `due_days=60`).
   - **Active:** checked.
4. **Click Create.** The modal shows a live preview of the due date if an invoice were posted today — useful sanity check.

## Editing or retiring a term

- **Edit** lets you change the name, due days, discount fields, and active flag. The `code` is server-generated and read-only at all times — there's nothing to get wrong; just edit the **Name** if the label is off.
- **Delete** does a hard delete, but only if no vendor / customer / invoice references the row. If any do, the panel surfaces a 409 with counts:
  > Cannot delete — still referenced by:
  > 3 vendor(s)
  > 1 customer(s)
  > 12 invoice(s)
- **To retire** a term that has references, simply toggle **`is_active=false`**. It stops appearing in new-record dropdowns but stays referenceable on existing rows.

## `compute_due_date` worked example

You receive a vendor bill on **2026-06-10**. The vendor's default terms are `NET30` (`due_days=30`).

```sql
SELECT compute_due_date('2026-06-10', '<vendor.payment_terms_id>');
-- returns: 2026-07-10
```

If the vendor invoice carries its own `payment_terms_id` (e.g. an opportunistic `COD` arrangement for a single shipment), that overrides the vendor default — the AP posting handler reads `invoice.payment_terms_id` first, then falls back to `vendor.payment_terms_id`.

## Backfill behavior — legacy free-text values

Vendors and customers shipped before P3-9 had a free-text `payment_terms` column. The migration leaves that column intact (read-only display) and attempts a best-effort match into the new structured FK:

- Normalizes by uppercasing + stripping whitespace + collapsing `/` and `-` to `_`. So `"Net 30"` → `NET30`, `"due on receipt"` → `DUE_ON_RECEIPT`, `"2/10 net 30"` → `2_10_NET30`.
- For unambiguous matches, sets `vendors.payment_terms_id` (or `customers.payment_terms_id`) automatically.
- For ambiguous or unmatched values, leaves the FK null and emits a `RAISE NOTICE` line per row so the operator can find them in the migration log.

After the migration runs, open Vendor Master and look for rows where the Payment Terms column shows the legacy text in italic grey (instead of a code like `NET30`). Click Edit, pick the right term from the dropdown, Save. The italic indicator goes away once the FK is set.

## Auditing

The panel respects the standard P1 RLS template (`anon_all` plus `auth_internal_*`). Internal entity users see + edit their own entity's terms; service-role calls (the dispatcher) bypass.

There's no audit trail on `payment_terms` itself — the table is small (~10-20 rows per entity) and edits are rare. If you need a history, the standard fix is to deactivate the old term and create a new one with a versioned code (e.g. `NET30_V2`).

## Related

- [02-master-data.md](02-master-data.md) — overall Master Data section
- [13-accounts-payable.md](13-accounts-payable.md) — how AP invoices consume payment terms at posting
- P3 architecture doc § 3.9 — the schema rationale
