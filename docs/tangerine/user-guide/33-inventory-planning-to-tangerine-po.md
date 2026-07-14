# 33. Inventory Planning ⇄ Tangerine (M31 / P17)

> **Status (2026-06-03):** the Inventory Planning app (`/planning`) is surfaced in the Tangerine shell (📈 Planning) and now connects to Tangerine in **both directions**: **(A)** an approved buy plan → draft native Tangerine POs (§33.1–33.7), and **(B)** a planning run can read its supply (on-hand + open POs) from Tangerine instead of the Xoro/ATS mirror (§33.8). Both are choices, not replacements — the legacy paths stay intact.

## 33.1 What this connects

Inventory Planning forecasts demand, reconciles supply, and emits **buy recommendations**. You gather the ones you want into an **execution batch** (a "buy plan") on **`/planning` → Execution**. Historically a batch was exported to xlsx or written back to Xoro. This integration adds a third, native target:

> **One approved buy plan → one DRAFT Tangerine purchase order per vendor**, created directly in Procurement, ready for you to review and issue.

No Xoro involvement. The buy plan reads planning data; the POs are real native `purchase_orders` rows you then manage in **Tangerine → Procurement → Purchase Orders** (chapter 28 / 32).

## 33.2 Running it (Execution screen)

On a batch that is **approved** (or exported / submitted / partially executed):

1. **🔍 Preview POs** — a dry run. Nothing is written. You see exactly which vendors would get a PO, how many lines, the dollar total, and — importantly — **which actions would be skipped and why**. Always preview first.
2. **🍊 Create Tangerine POs** — does it for real. Each `create_buy_request` action becomes a PO line; lines are grouped by vendor into one **draft** PO each.

Both buttons require the **`run_writeback`** planning permission (admin / operations_user roles). They are disabled with a tooltip if your role lacks it.

After a real run, each created PO shows a **`open in Procurement →`** link, and every action in the table gets a persistent **Tangerine PO** chip (`draft 1a2b3c4d`) that deep-links to the PO panel — so the link survives a page refresh, not just the result banner.

## 33.3 How each line is built

| PO field | Source |
|---|---|
| Line item (`inventory_item_id`) | action `sku_id` = `ip_item_master.id` (direct, no lookup) |
| Quantity | `approved_qty` if set, else `suggested_qty` (must be > 0) |
| Vendor | `ip_vendor_master.portal_vendor_id` → Tangerine `vendors.id` |
| Unit cost | `ip_item_master.unit_cost` → **fallback** `ip_item_avg_cost.avg_cost` → `standard_unit_price` → $0 |
| Expected date | earliest action `period_start` in the group |

**Cost fallback (new):** if the item master has no `unit_cost`, the line uses the last-known average cost, then the standard unit price, before giving up. Only a line that resolves to $0 from *every* source raises a cost warning — edit it before issuing.

The POs are created **`status='draft'`**: no PO number, no open commitments. Issuing them in Procurement (chapter 28) is what assigns the number and opens commitments — that step is deliberately yours.

## 33.4 Why an action gets skipped

The preview / result shows a coded breakdown. The common ones:

| Skip | Meaning / fix |
|---|---|
| **no vendor on action** | the buy rec has no vendor — assign one in the buy plan, or populate `ip_vendor_master` |
| **vendor not linked to Tangerine** | the planning vendor has no `portal_vendor_id` — use the **🔗 Link** suggestion (§33.6) |
| **vendor not in planning master** | the action's `vendor_id` isn't an `ip_vendor_master` row |
| **SKU not in item master** | the action's `sku_id` isn't an `ip_item_master` row |
| **zero approved qty** | set an approved qty > 0 |
| **cancelled action** | the action was cancelled |
| **already linked to a PO** | idempotency — this action already created a PO. (If you deleted that draft in Procurement, the next run re-creates it.) |

Skips never block the other actions — eligible lines still create their POs.

## 33.5 Prerequisites (what must exist first)

This integration is the *last mile*. As of 2026-06-03 the planning pipeline has **9 runs and 7,807 recommendations**, but **0 execution batches** and an **empty `ip_vendor_master`** — so a run today would skip everything. To actually produce POs:

1. **Populate planning vendors** (`ip_vendor_master`) and make sure buy recommendations carry a vendor.
2. **Create + approve an execution batch** from the recommendations (Execution screen).
3. **Link each planning vendor → its Tangerine vendor** (§33.6).

## 33.6 Linking a planning vendor to a Tangerine vendor

When a vendor is unlinked, the preview offers **🔗 Link** chips: the server matched the planning vendor against Tangerine `vendors` by **code**, **name**, or **alias** and shows each candidate (with what it matched on). Click one to set `ip_vendor_master.portal_vendor_id` in place, then the preview re-runs and those lines move into the eligible set. If no candidate matches, create/align the vendor in **Vendors** first.

## 33.7 Access note

The flow is permission-gated by the planning RBAC (`ip_user_roles` / `ip_roles`), which is separate from the app-level `permissions.planning` flag that shows the Planning app at all. The CEO (`eran@`) was granted the planning **admin** role (migration `20260725000000`) so the buy-plan→PO buttons are usable; reverse or re-scope that grant in `ip_user_roles` if you prefer a narrower role.

## 33.8 Choosing your supply source (direction B)

By default, the planning **Supply** screen (`/planning` → Supply) reconciles demand against the **Xoro / ATS mirror** — on-hand from the nightly ATS snapshot and open POs from the PO WIP app. Direction B lets a planning run instead read supply from **native Tangerine ERP**, so you can compare buy recommendations against Tangerine's own numbers.

It's a **per-run choice**, set when you create a reconciliation run:

- **Supply source: Xoro / ATS mirror** *(default)* — unchanged behavior.
- **Supply source: Tangerine ERP** — on-hand from Tangerine FIFO inventory (`inventory_layers`), open POs from native Tangerine purchase orders (issued / in-transit).

The chosen source shows as a badge on the run (`supply: Tangerine ERP`). The two sources never mix — a Tangerine run sees only Tangerine supply, a Xoro run sees only the mirror.

**Populating Tangerine supply.** Tangerine supply data is pulled on demand. Click **🍊 Sync Tangerine supply** on the Supply workbench (needs the `manage_integrations` planning permission). It refreshes both:

| Planning input | From Tangerine |
|---|---|
| On-hand (`ip_inventory_snapshot`, `source='tangerine'`) | Σ `inventory_layers.remaining_qty` per SKU × warehouse |
| Open POs (`ip_open_purchase_orders`, `source='tangerine'`) | native `purchase_orders` in **issued / in_transit** status + their open line qty |

Then **Run reconciliation** on the Tangerine-source run to apply it.

**Notes & current state.**
- On-hand maps directly: a Tangerine inventory layer's `item_id` is the same SKU id (`ip_item_master.id`) the planner already uses — no remapping.
- Today Tangerine on-hand totals ~**1.35M units across ~7,700 SKUs** (it ties exactly to the FIFO layer sum). Native open POs are **0** until you issue POs in Procurement (e.g. from a buy plan via direction A), so the Tangerine open-PO input is empty until then.
- The sync is safe to re-run (idempotent on-hand upsert; open-PO full rebuild) and only touches `source='tangerine'` rows, never your Xoro/manual data.

### WIP timing (inbound PO = WIP)

For the **Xoro/ATS** supply source, an open PO *is* the work-in-progress — its quantity is already counted as incoming supply, so there's no separate "WIP" number to add (adding one would double-count). What the Tanda milestones contribute is **timing**: each open PO's expected-arrival month is now taken from the ops-maintained **"In House / DDP"** milestone (the `days_before_ddp = 0` step — its actual date once entered, else its expected date), falling back to the Xoro PO date when there's no milestone. So when the Production team updates a PO's DDP in Tanda, that WIP lands in the right month in the planning projection on the next **Sync open POs** + reconcile. (Today this re-times 9 of 166 open POs, some across a month boundary.)

---

*M31 now connects planning to Tangerine in both directions — buy-plan → PO (A) and Tangerine supply → planning (B) — and both are opt-in choices alongside the existing Xoro paths.*
