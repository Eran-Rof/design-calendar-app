# 11. Inventory Operations (P3)

The Inventory group in the Tangerine top nav hosts M37 inventory operations: transfers, adjustments, and cycle counts. This chapter grows as each P3 chunk ships its panel.

## What's shipped in P3

| Panel | Status | Chunk |
|---|---|---|
| 🔁 Inventory Transfers | **Read-only skeleton** | P3-7 (2026-05-27) |
| 🛠️ Inventory Adjustments | Not shipped yet | P3-5 (planned) |
| 🧮 Cycle Counts | Not shipped yet | P3-6 (planned) |

---

## 11.1 Inventory Transfers (skeleton)

**Where:** Tangerine top nav → **🔁 Inventory Transfers** (Inventory group).

**Purpose:** records location-to-location movements of inventory. At the P3-7 skeleton stage the panel is **read-only**: the schema (`inventory_transfers` table) is in place for forward compatibility, but the create / edit UX is intentionally deferred until the multi-warehouse module lands.

### What you'll see

A list view with these columns:

| Column | Source |
|---|---|
| **Item** | `item_id` (uuid into `ip_item_master`) — the SKU being moved |
| **Qty** | `qty` — positive numeric, units of inventory transferred |
| **From** | `from_location` — free-form text source location |
| **To** | `to_location` — free-form text destination (must differ from From) |
| **Date** | `transfer_date` — when the move happened |
| **Notes** | `notes` — free-form operator notes |

Three filter inputs above the table:

- **Item ID (uuid)** — exact match on the item being moved
- **From location** — exact match on the source location
- **To location** — exact match on the destination location

Any combination of filters narrows the list. Clear an input to drop that filter.

### Why the "Add" button is disabled

The **+ Add** button is intentionally disabled with the tooltip:

> *"Multi-warehouse + transfer creation lands when M37 full UX ships. Schema exists for forward compatibility."*

Until the multi-warehouse module lands, the operator runs a single location and there's nothing to transfer between. The table will remain empty by design. When M37's full chunk ships, this same panel grows a create-transfer modal + GL impact wiring for cross-entity moves.

### Empty state

> *"No transfers logged yet. Schema is in place for forward compatibility."*

This is the expected state during P3 until M37 ships its full UX or a cross-entity transfer is created elsewhere.

---

## 11.1.x FIFO layers on AP receipt (P3-4)

**When an AP invoice with inventory lines posts, FIFO layers are created automatically.**

Each AP invoice line that carries an `inventory_item_id` together with **both** a `qty` and a `unit_cost_cents` triggers the creation of one `inventory_layers` row at posting time:

- `entity_id` — from the invoice
- `item_id` — from the line
- `original_qty` and `remaining_qty` — both set to the line's `qty`
- `unit_cost_cents` — per-unit landed cost from the line
- `source_kind` — `'ap_invoice'`
- `source_invoice_id` — the invoice id (FK back to `invoices`)
- `received_at` — defaults to the invoice's `invoice_date`
- `created_by_user_id` — propagated from the posting event

**Sequencing:** the layer rows are inserted **after** the journal entry persists successfully. If the JE fails (period locked, unbalanced, period closed, etc.), the layer step is skipped entirely — there will never be an orphan layer without a matching GL impact.

**Soft-fail on layer side:** if the JE posts but a layer insert fails (e.g. transient DB error), the JE is **not** rolled back. The failure is logged and the offending item id is returned in the posting result under `inventory_layer_errors`. The GL truth (DR inventory / CR AP) is already correct; the operator can backfill the missing layer via a manual adjustment or contact the dev team.

**Lines without qty + unit_cost_cents:** legacy / partial AP invoices that mark a line `inventory_item_id` but omit one of `qty` / `unit_cost_cents` post the JE as before but create **no** layer. This is intentional — those rows pre-date the FIFO wiring and the operator may not yet know the per-unit cost. Subsequent receipts can be properly costed.

**Void behaviour:** voiding an AP invoice via the `ap_invoice_voided` event **does not** delete or zero its FIFO layers. The layers represent inventory that physically arrived; if the operator wants to remove the received quantity from the on-hand picture they must file a separate inventory adjustment (P3-5).

---

## 11.2 GL impact policy

Internal transfers between owned locations within a single entity **do not hit the General Ledger**. The `posted_je_id` column on the underlying table stays NULL for those rows. The inventory simply moves between layers (consume one layer at the source, create a new layer at the destination with the same `unit_cost_cents`).

Cross-entity transfers — once that scenario is supported — will post via `gl_post_journal_entry` and link the resulting JE in `posted_je_id`. At the P3-7 skeleton stage no such posting path exists.

---

## 11.3 API surface

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/internal/inventory-transfers` | List (filterable, capped at 500). Default 100 rows ordered by `transfer_date DESC`. |
| `POST` / `PATCH` / `DELETE` | (any) | **Returns 405 Method Not Allowed.** Creation UX deferred. |

Filter query params: `item_id` (uuid), `from_location` (text), `to_location` (text), `limit` (1–500, default 100).

---

## 11.4 Roadmap

- **P3-5 — Inventory Adjustments:** add `🛠️ Adjustments` panel under this same Inventory group. Posts to GL via M37 / M5 logic per architecture §5.
- **P3-6 — Cycle Counts:** add `🧮 Cycle Counts` panel. Variances roll up to adjustments.
- **M37 full UX (post-P3):** enable create + edit + post on Inventory Transfers. The disabled `+ Add` button activates; the schema doesn't change.
