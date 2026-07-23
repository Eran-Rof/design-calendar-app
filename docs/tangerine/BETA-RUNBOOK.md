# Beta Runbook — beta window tagging and cleanup guardrails

> Chunk A (this document's initial version) covers the data layer: the beta
> switch, the created-docs registry, and the ZZ-BETA test masters.
> Chunk B adds the beta user role; chunk C adds the Beta Data screen and will
> extend this runbook with the operational procedures.

## What this is

Real users use PRODUCTION during the beta. Every document a beta user creates
must be identifiable later so cleanup can be a **reviewed** operation, not
guesswork. Migration `20265900000000_beta_config_registry_test_masters.sql`
installs three pieces:

### 1. `beta_config` — the beta switch

A single-row global table (singleton enforced by a unique index on a constant
expression, `beta_config_singleton`):

| column | meaning |
| --- | --- |
| `active` | `true` while the beta window is open. Default `false`. |
| `started_at` / `ended_at` | window bounds, stamped when the switch is flipped |
| `started_by_user_id` | who opened the window |
| `notes` | free text (e.g. PITR timestamp reference, participant list) |

While `active = false` the entire mechanism is a no-op — zero effect on
normal operation.

### 2. `beta_created_docs` — the registry

Central log of every row INSERTed into a registered table while the beta
window is active. One row per `(table_name, row_id)` (unique). Columns:
`table_name`, `row_id` (uuid), `doc_label` (best-effort human identifier —
invoice/SO/PO/case number, CUST-/VEND-/RFQ- code, style or SKU code, name,
title), `source`, `created_by_user_id`, `entity_id`, `created_at`.

Populated exclusively by one generic trigger function, `fn_beta_registry()`
(AFTER INSERT, per row):

1. Reads `beta_config.active` — if not `true`, returns immediately.
2. **Human-origin guard** — if the row carries a `source` column and its value
   is NOT one of `manual`, `tangerine`, `buyer`, `api` (or NULL), the row is
   skipped. This keeps mirror/feed traffic (`xoro_mirror`, `shopify`, `fba`,
   `walmart`, `faire`, `edi_3pl`, `plaid_sync`, `system`, `excel`,
   `schedule`) out of the registry — those rows are machine-origin and must
   never be swept up in beta cleanup.
3. Extracts `id` (uuid), a doc label, `source`, `created_by_user_id`, and
   `entity_id` from the row and inserts into `beta_created_docs` with
   `ON CONFLICT DO NOTHING`.
4. The ENTIRE function body is wrapped in
   `BEGIN ... EXCEPTION WHEN OTHERS THEN RETURN NEW; END` — registration can
   **never** fail or block the business insert. Worst case a row goes
   unregistered; the insert always succeeds.

Trigger name on every table: `trg_beta_registry`.

#### Tables with the registry trigger attached (headers only, never line tables)

| table | doc_label source |
| --- | --- |
| `ar_invoices` | `invoice_number` |
| `ar_receipts` | `reference` (falls back NULL) |
| `invoices` (AP bills) | `invoice_number` |
| `invoice_payments` | `reference` |
| `journal_entries` | `description` |
| `sales_orders` | `so_number` |
| `purchase_orders` | `po_number` |
| `cases` | `case_number` |
| `customers` | `customer_code` / `code` (CUST-NNNNN) |
| `vendors` | `code` (VEND-NNNNN) / `name` |
| `style_master` | `style_code` |
| `ip_item_master` | `sku_code` |
| `inventory_adjustments` | `reason` |
| `inventory_transfers` | (id only) |
| `rfqs` | `code` (RFQ-NNNNN) / `title` |

Line tables (`ar_invoice_lines`, `sales_order_lines`, `purchase_order_lines`,
`journal_entry_lines`, ...) are intentionally NOT triggered — the header row
identifies the whole document, and cleanup of a header cascades or is handled
document-by-document during review.

### 3. ZZ-BETA test masters (permanent fixtures)

Seeded idempotently by the same migration, **before** the triggers attach and
while `active = false`, so they are never registered — they are permanent
fixtures, not beta debris:

| fixture | notes |
| --- | --- |
| customer `ZZ-BETA TEST CUSTOMER` | next free CUST-NNNNN code (MAX+1) |
| vendor `ZZ-BETA TEST VENDOR` | next free VEND-NNNNN code (MAX+1) |
| styles `ZZBETA001`, `ZZBETA002` | lifecycle `active`, marked "do not sell" in description |

Beta users should be directed to these fixtures for test documents whenever
possible; documents against real customers/vendors are still caught by the
registry.

## Start of beta — checklist (stub; chunk C extends this)

1. **Note the timestamp** (UTC) in `beta_config.notes` before flipping the
   switch — this is the PITR reference point if a full rollback is ever
   needed.
2. **Flip `beta_config.active` to `true`** via the Beta Data screen (chunk C).
   `started_at` / `started_by_user_id` are stamped at that moment.
3. **Assign participating users the beta role** (chunk B).

## End of beta — outline (chunk C will detail)

1. Flip `beta_config.active` to `false` (stamps `ended_at`).
2. Review `beta_created_docs` grouped by `table_name` on the Beta Data screen.
3. Reviewed cleanup: keep real documents, delete/void test debris —
   document-by-document, never a blind bulk delete.
