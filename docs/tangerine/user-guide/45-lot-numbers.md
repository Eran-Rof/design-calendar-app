# 45. Lot Numbers (per-line lot tracking)

> **Status (2026-06):** Foundation + Scenarios 1 & 3 shipped (PRs #1379, #1381). A **lot number** lives on each **purchase-order line, sales-order line, and inventory layer** — *not* on Style Master. Lots are auto-stamped at PO issue and inherited when a PO is created from a sales order; the operator can override any lot by hand. Later scenarios (placeholder lots, lot-aware ATS allocation, bulk↔distro) build on this same column.

A **lot number** is a label that ties a specific batch of goods — a particular purchase, production run, or customer order — to the stock it produces. In Tangerine the lot lives **per style + color line**, so a single PO or SO can carry a different lot on each style/color. The lot then **travels with the goods**: when a PO is received, its line's lot is stamped onto the FIFO inventory layer, so on-hand stock is always traceable back to the order that bought it.

> **Where lots live — and don't.** Lots are a property of an **order line** (and the inventory it creates), **not** of a style. There is no lot field on Style Master. The grain is **style + color** (an inseam splits the row like everywhere else in the matrix), the same row grain you see in the size matrix.

---

## 45.1 The lot column on a Purchase Order

**Where:** `/tangerine?m=purchase_orders` → open or create a PO → the size-matrix body (see [chapter 28 §28.5](28-purchase-orders-and-size-matrix.md)).

- A **🏷 Show lots / Hide lots** toggle sits at the top-right of the matrix. On a PO it is **shown by default**; click it to hide the column when you don't need it.
- When shown, each color (× inseam) row gets an editable **Lot** field, plus a **"set all rows"** field to apply one lot to every row of the style at once.
- **Type a lot to set it by hand** — a lot you enter always wins and is **never overwritten** by the auto-stamp below.

### How the lot is auto-stamped (Scenario 1)

A native PO doesn't get its `PO-YYYY-NNNNN` number until you **Issue** it. At that moment:

- **Every line you left blank** is auto-stamped with the **PO number** as its lot.
- Any line you set by hand keeps your value.

So if you do nothing, each line's lot becomes the PO number — a clean default that ties the batch to the purchase order. Re-opening the issued PO shows the stamped lots in the column.

### When the PO was created from a Sales Order (Scenario 3)

If you build the PO with **📋 Create from Sales Order** (chapter 28 §28.5, step 1a), each line's lot instead defaults to the **sales order's customer PO number** — the buyer's own reference — rather than the at-issue PO# stamp. This makes the production order carry the customer's PO right through to the stock it produces.

- The lot column is still fully editable — change any line before saving.
- A **blank customer PO** on the source SO falls back to the normal **PO# auto-stamp at issue**.
- The **SO picker** shows each candidate order's **customer PO (🏷)** and fulfillment source, so you can spot production orders that are waiting for a PO, and the success message tells you which lot was applied.

This inheritance also applies to any programmatic "PO from SO" path (a PO that carries a `sales_order_id` inherits the linked SO's customer PO on its un-lotted lines), so the at-issue stamp won't clobber it.

---

## 45.2 The lot column on a Sales Order

A sales-order line carries the same per-style+color lot field, but the **SO matrix does not show a lot column for hand entry**. SO lots are populated by the downstream flows rather than typed in:

- When a **production PO is created from the order**, the lot the PO inherits (the customer PO, §45.1) is the thread that links the customer order to the production batch.
- Later scenarios (lot-aware availability and allocation) read and write this same SO-line lot.

So on a sales order you generally don't enter lots directly — they flow in from the order's customer PO and the production PO created against it.

---

## 45.3 Lots flow into inventory at receiving

When you **post a goods receipt** against a PO (see [chapter 32 §32.2](32-procurement-receiving.md)), each accepted line creates a **FIFO inventory layer** — and that layer **carries the PO line's lot number**. From then on the on-hand stock is **lot-identified**: you can tell which batch a given layer of inventory came from.

Because lots ride the FIFO layer, they're the foundation for lot-aware availability and allocation in later phases (the inventory layer is indexed by `(item, lot)` for exactly this).

---

## 45.4 What's NOT yet usable

These build on the same lot column and ship in later phases:

- **Placeholder lots** for goods bought before a customer PO exists (Scenario 2).
- **Lot-aware ATS allocation** — choosing which lot of on-hand to reserve against an SO line (Scenario 5).
- **Bulk ↔ distribution lot handling** when a single lot is split across orders (Scenario 4).

Until those land, lots are an end-to-end **label** — auto-stamped, inherited, and carried onto stock — but allocation and ATS still treat on-hand as a single pool per SKU.

---

## 45.5 Code map

- **Matrix body (lot column + toggle):** `src/tanda/LineMatrixBody.tsx` (the `🏷 Show lots / Hide lots` toggle, per-row `Lot` field, and "set all rows"; PO-only, default shown).
- **PO create-from-SO lot inheritance:** `src/tanda/InternalPurchaseOrders.tsx` (`createFromSO` seeds each cell's lot from the SO's `customer_po`; SO picker shows the 🏷 customer PO).
- **Server:** `api/_handlers/internal/purchase-orders/*` (auto-stamp PO# at issue on un-lotted lines; default un-lotted lines to the linked SO's `customer_po`), `sales-orders/*` (accept per-line lot), receiving's `createLayer` (carries the PO line's lot onto `inventory_layers`).
- **Schema:** migration `20260899000000` — `lot_number text` on `purchase_order_lines`, `sales_order_lines`, `inventory_layers`, plus a partial index `inventory_layers(entity_id, item_id, lot_number)` for the later lot-aware allocation.

## Related docs

- [28-purchase-orders-and-size-matrix.md](28-purchase-orders-and-size-matrix.md) — the PO module + size matrix where the lot column lives.
- [27-sales-orders-allocations-shipping.md](27-sales-orders-allocations-shipping.md) — sales orders + the customer PO that lots inherit.
- [32-procurement-receiving.md](32-procurement-receiving.md) — receiving, where the lot lands on the FIFO inventory layer.
