# Beta Runbook — running beta users on PRODUCTION safely

> Operator guide for the beta-guardrails feature (3 chunks): **A** — the beta
> window (`beta_config`) + automatic tagging registry (`beta_created_docs`) +
> ZZ-BETA master records; **B** — the restricted `beta` RBAC role; **C** — the
> **Beta Data** admin screen (Admin group) with the window toggle, tagged-doc
> review, and the safe cleanup engine.
>
> The premise: beta users work on the LIVE production database. These guardrails
> make that survivable — everything they create is tagged while the window is
> open, they can never post or void, and after the beta the tagged rows are
> reviewed and removed through a guarded engine that refuses anything that has
> entered the books.

---

## Before the beta (pre-flight)

1. **Record a PITR restore point.** Supabase dashboard → project → Database →
   Backups / Point-in-time. Note the timestamp; after you start the window,
   `beta_config.started_at` is the canonical reference — record both together
   (they should be within minutes of each other). PITR is the disaster lever
   only; normal cleanup goes through the Beta Data screen.
2. **Assign the `beta` role** to each beta user in **Admin → User Access**
   (pick the user, set Role = `beta`). The role is read/write/export
   everywhere and **never post/void** — a beta user cannot put anything into
   the GL. Do NOT hand out admin or accountant to beta users.
   ⚠️ **Legacy-role caveat:** the auth provisioning flow (`auth/provision.js`)
   stamps every newly provisioned user with the LEGACY role `admin`
   (`entity_users.role` — a separate, older field from the RBAC role above).
   A handful of legacy handlers still guard on that field, so after a beta
   user first signs in, set their legacy role to a non-admin value (e.g.
   `staff`) in User Management. The known exploitable combination
   (legacy-admin + gl-periods reopen) was closed in chunk B by making
   gl-periods close/reopen post-grade, but keep beta users off legacy admin
   as defense in depth.
3. **Verify `RBAC_MODE=enforce`** is set in the Vercel production environment
   (it has been live since 2026-07-08 — just confirm nobody flipped it). With
   enforcement off, the `beta` role's post/void denial is not applied.
4. **Verify the ZZ-BETA masters exist** (chunk A seeds them): the ZZ-BETA
   customer/vendor/style sandbox records beta users should transact against.
   Steer beta users toward them in your kickoff notes.
5. **Start the window**: Admin → **Beta Data** → *Start beta window* (add a
   note describing the cohort). Starting flips `beta_config.active`; from that
   moment the AFTER-INSERT triggers tag every new document/master row into
   `beta_created_docs` automatically, with the creating user and timestamp.

## During the beta

- **Tagging is automatic.** No operator action needed; the registry fills as
  beta users create documents (whoever creates them — the window is global,
  which is also why real staff work during the window shows up in the registry;
  that is expected and is what the review step is for).
- **Spot-check weekly** in Admin → Beta Data: the summary shows per-table
  totals; the outstanding table shows each tagged doc with a LIVE dry-run
  eligibility verdict. Nothing on this screen writes anything until you run a
  cleanup.
- If a beta user reports a 403 on post/void — that is the design, not a bug.

## Ending the beta

1. Admin → Beta Data → **End beta window**. Tagging stops; the registry keeps
   everything already tagged.
2. **Review the outstanding list.** Every row carries a verdict:
   - `deletable` — safe to remove (unposted, unpaid, unreferenced).
   - `refused` — with the reason (`posted — reverse instead`, `has payments`,
     `has receipts`, `has shipments/allocations`, `still referenced (…)`,
     `protected table`). Refused rows are never touched.
   - `already gone` — the row was deleted by other means; cleanup just marks
     the registry entry.
3. **Run the cleanup** on reviewed selections (checkboxes → *Clean up
   selected* → confirm modal lists exactly what will delete vs refuse). The
   engine re-checks every row against live data at delete time, deletes
   atomically (lines + header in one transaction via `beta_cleanup_delete()` —
   a refusal can never leave a half-deleted document), and stamps
   `cleaned_at`/`cleanup_note` on the registry. Per-row outcomes are shown
   after the run.
4. **Posted test documents get REVERSED, not deleted.** Anything the engine
   refuses as `posted — reverse instead` goes through the normal
   reversal/void flow in its own module, with a reason (T11 requires one on
   every posting/void). The GL history stays intact — that is the point.
5. **ZZ-BETA masters STAY.** They are permanent sandbox fixtures for the next
   beta round; do not delete them (they will typically refuse anyway as
   `still referenced` once documents have touched them).
6. When the outstanding list is empty (or everything left is intentionally
   kept), the beta is closed. Keep the registry rows — `cleaned_at` +
   `cleanup_note` are the audit trail of what was removed, by whom, when.

## What the cleanup engine will NEVER do

- Delete a posted document (AR/AP invoice, receipt, payment, JE) — refuse.
- Delete a paid/applied document — refuse.
- Delete a PO with receipts or an SO with shipments/allocations — refuse.
- Touch `journal_entry_lines`, any `gl_*` table, any `*_ledger` table,
  `xoro_gl_mirror`, `row_changes`, or the beta tables themselves — refuse.
- Cascade beyond a document's own lines table — anything else still
  referencing a row makes the database refuse the delete (surfaced as
  `still referenced (<constraint>)`), and the transaction rolls the lines
  delete back with it.
- Bulk SQL. Every delete is a per-document operation through the guarded
  `beta_cleanup_delete()` function (allowlisted tables only, service-role
  execute only), so audit triggers fire normally.

## Code map

- Window + registry (chunk A): `beta_config`, `beta_created_docs` + tagging
  triggers; ZZ-BETA seed.
- `beta` role (chunk B): RBAC seed — read/write/export everywhere, no
  post/void anywhere; not granted `beta_data`.
- Screen: `src/tanda/InternalBetaData.tsx` (Admin → Beta Data).
- API: `api/_handlers/internal/beta-data/index.js`
  (`GET` review payload; `POST` `start_window` / `end_window` / `cleanup`).
- Engine: `api/_lib/betaData.js` (pure verdicts unit-tested in
  `api/_lib/__tests__/betaData.test.js`) + `beta_cleanup_delete()` SQL
  function (atomic delete; migration 20266100000000).
- Migration (chunk C): `supabase/migrations/20266100000000_beta_data_module_and_cleanup_cols.sql`
  (registry cleanup columns + `beta_data` module_key — admin-only via the
  admin-derivation view + the atomic delete function).
- User guide: `docs/tangerine/user-guide/24-user-access-rbac.md` (Beta section).

---

## Appendix — data-layer reference (chunk A)

Migration `20265900000000_beta_config_registry_test_masters.sql` installs
three pieces:

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
title), `source`, `created_by_user_id`, `entity_id`, `created_at`, plus the
chunk-C cleanup bookkeeping (`cleaned_at`, `cleanup_note`).

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
identifies the whole document, and cleanup handles each document atomically.

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
