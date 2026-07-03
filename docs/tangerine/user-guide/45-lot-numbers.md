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

A sales-order line carries the same per-style+color lot field, and the SO matrix now shows a **Lot column at the far right — after the Total $ column** — exactly like the PO matrix:

- A **🏷 Show lots / Hide lots** toggle sits at the top-right of the matrix; on an SO the column is **hidden by default — click "Show lots"** to reveal it (on a PO it is shown by default). Each color row gets a per-row `Lot` field plus a "set all rows" header entry.
- The placeholder reads **"customer PO / lot"** — a reminder that on a sales order the lot is normally the customer's PO number (or the stock lot the order ships from), not a production PO#.
- The column is fully editable in a draft/editable SO and read-only when the order is locked, and any lot you type is saved onto the sales-order line.

You still usually don't have to type lots in by hand — they flow in automatically:

- When a **production PO is created from the order**, the lot the PO inherits (the customer PO, §45.1) is the thread that links the customer order to the production batch.
- **Lot-aware ATS allocation** (Scenario 5) writes the allocated stock lots onto the SO lines at save, splitting a line per lot as needed.

The hand-entry column simply lets the operator view those flowed-in lots and override any line before saving.

---

## 45.3 Lots flow into inventory at receiving

When you **post a goods receipt** against a PO (see [chapter 32 §32.2](32-procurement-receiving.md)), each accepted line creates a **FIFO inventory layer** — and that layer **carries the PO line's lot number**. From then on the on-hand stock is **lot-identified**: you can tell which batch a given layer of inventory came from.

Because lots ride the FIFO layer, they're the foundation for lot-aware availability and allocation in later phases (the inventory layer is indexed by `(item, lot)` for exactly this).

---

## 45.4 Viewing on-hand by lot on the Inventory Matrix

A single style + color can be **received at different times**, so its on-hand stock may sit across **several lots** at once. The **Inventory Matrix** (`/tangerine?m=inventory_matrix`) lets you break on-hand down by lot — in **every** view, not just a single style:

- A **Lot #** filter sits next to the Warehouse filter whenever the current styles have any lotted on-hand. It's a multi-select populated with **every lot number present on those styles' on-hand** — including a **`(no lot)`** bucket for legacy / opening-balance stock received before lot tracking.
- **Leave it empty to see everything** (on-hand summed across all lots — the default).
- **Pick one or more lots** to re-scope on-hand to just those lots; selecting several sums them.
- The dropdown always lists the **full** set of lots even while a filter is applied, so you can freely add or swap lots.

It works across the three views:

- **Single style** — each color × size cell shows only the picked lots' on-hand. (While a lot filter is active the matrix shows **on-hand only** — the item-level **Available** figure is hidden, because availability isn't tracked per lot.) The filter also applies to PPK-exploded on-hand when **Explode** is on.
- **All-styles Matrix** — the same lot filter scopes on-hand on every style's grid at once, so a search that pulls up **multiple styles (base + their PPK siblings)** filters them all together. The lot list is the **union** of every listed style's lots.
- **All-styles Snapshot** — the **On Hand** column is scoped to the picked lots. Note that only On Hand is lot-tracked: the other columns (**Allocated / On SO / On PO / ATS / Sold / Purchased**) aren't recorded per lot, so they stay whole-style.

The lot list and per-lot on-hand come straight from the **FIFO inventory layers** (§45.3), so they reflect exactly which batch each unit came from.

---

## 45.5 What's NOT yet usable

These build on the same lot column and ship in later phases:

- **Placeholder lots** for goods bought before a customer PO exists (Scenario 2).
- **Lot-aware ATS allocation** — choosing which lot of on-hand to reserve against an SO line (Scenario 5).
- **Bulk ↔ distribution lot handling** when a single lot is split across orders (Scenario 4).

Until those land, lots are an end-to-end **label** — auto-stamped, inherited, and carried onto stock — but allocation and ATS still treat on-hand as a single pool per SKU.

---

## 45.6 Code map

- **Matrix body (lot column + toggle):** `src/tanda/LineMatrixBody.tsx` (the `🏷 Show lots / Hide lots` toggle, per-row `Lot` field, and "set all rows"; far-right column after `Total $` — offered in **both PO and SO** modes, hidden on AR; default shown on PO, **hidden on SO** via `showLots` initial `mode === "po"`). SO seeding of existing line lots is in `src/tanda/InternalSalesOrders.tsx` (`lot: l.lot_number` on each seed cell).
- **PO create-from-SO lot inheritance:** `src/tanda/InternalPurchaseOrders.tsx` (`createFromSO` seeds each cell's lot from the SO's `customer_po`; SO picker shows the 🏷 customer PO).
- **Server:** `api/_handlers/internal/purchase-orders/*` (auto-stamp PO# at issue on un-lotted lines; default un-lotted lines to the linked SO's `customer_po`), `sales-orders/*` (accept per-line lot), receiving's `createLayer` (carries the PO line's lot onto `inventory_layers`).
- **Inventory Matrix lot filter:** `src/tanda/InternalInventoryMatrix.tsx` (the **Lot #** `MultiSelectDropdown`; `lotFilter` state; `availableLots` memo picks the lot list per view — single `payload.lots`, snapshot `snapLots`, or the union of `brandPayloads[].payload.lots`; `&lots=`/`lots` threaded into all three fetches). Servers: `api/_lib/styleMatrix.js` `enumerateStyleMatrix` reads `inventory_layers.lot_number`, returns the full `lots` list, and (when `opts.lotFilter` is set) scopes on-hand to those lots — threaded through `computePpkExplode`; `api/_handlers/internal/inventory-snapshot.js` does the same for the Snapshot **On Hand** column (accepts `body.lots`, returns `lots`); `NO_LOT` / `lotKeyOf` (exported from `styleMatrix.js`) normalize the unlotted bucket. Endpoint `api/_handlers/internal/style-matrix/index.js` parses `?lots=A,B`.
- **Schema:** migration `20260899000000` — `lot_number text` on `purchase_order_lines`, `sales_order_lines`, `inventory_layers`, plus a partial index `inventory_layers(entity_id, item_id, lot_number)` for the later lot-aware allocation.

## Related docs

- [28-purchase-orders-and-size-matrix.md](28-purchase-orders-and-size-matrix.md) — the PO module + size matrix where the lot column lives.
- [27-sales-orders-allocations-shipping.md](27-sales-orders-allocations-shipping.md) — sales orders + the customer PO that lots inherit.
- [32-procurement-receiving.md](32-procurement-receiving.md) — receiving, where the lot lands on the FIFO inventory layer.
