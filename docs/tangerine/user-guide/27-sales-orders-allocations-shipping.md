# 27. Sales Orders, Allocations & Shipping (P16 — M10 + M18 + M44)

> **P16 Sales core status:** COMPLETE. M10 (SO entry → confirm → draft AR invoice) shipped in PRs #698–#700; the SO UI batch (Start Ship, customer defaults, factor approval) #704; multi-store split #706; the factored-customer ship-gate #714; M18 per-SO allocation #725 and the standalone **Allocations Workbench** #788, with fill modes (fair-share + capped-%) #789; M44 carrier/shipping #726; matrix SO entry #730/#743. All migrations applied to prod.

This module is the wholesale order lifecycle: an order is taken (`draft`), accepted (`confirmed` — SO number assigned), stock is reserved against it (`allocated`), it ships against a carrier (`fulfilling`/`shipped`), and an AR invoice is cut (`invoiced`) which is what actually books the GL. It sits on top of the existing customer master, inventory layers, and the [Accounts Receivable](16-accounts-receivable.md) engine — AR is where revenue + FIFO COGS are recognised; this module never posts a journal entry of its own.

Three sub-modules, all under the **Sales** nav group:

| Panel | Route | Icon | Who uses it |
|---|---|---|---|
| **Sales Orders** | `/tangerine?m=sales_orders` | 🛒 | Sales, ops |
| **Allocations** | `/tangerine?m=sales_allocations` | 📊 | Ops / inventory planner |
| **AR Invoices** (downstream) | `/tangerine?m=ar_invoices` | 🧮 | Accountant — see [chapter 16](16-accounts-receivable.md) |

---

## 27.1 Sales Order entry & lifecycle (M10)

### Lifecycle

```mermaid
flowchart LR
    Draft["🧾 draft<br/>(edit lines · no SO #)"]
    Confirmed["✅ confirmed<br/>(SO-YYYY-NNNNN assigned)"]
    Allocated["📦 allocated<br/>(all lines reserved)"]
    Fulfilling["🚚 fulfilling<br/>(partial shipment)"]
    Shipped["📦 shipped<br/>(all allocated qty out)"]
    Invoiced["🧮 invoiced<br/>(draft AR invoice cut)"]
    Closed["🔒 closed"]
    Cancelled["🚫 cancelled"]

    Draft -->|Save & Confirm| Confirmed
    Draft -->|Del| Cancelled
    Confirmed -->|📦 Allocate stock (full)| Allocated
    Confirmed -->|partial allocate| Confirmed
    Confirmed -->|🚚 Ship| Fulfilling
    Allocated -->|🚚 Ship (partial)| Fulfilling
    Allocated -->|🚚 Ship (full)| Shipped
    Fulfilling -->|🚚 Ship remainder| Shipped
    Confirmed -->|🧾 Create AR invoice| Invoiced
    Allocated -->|🧾 Create AR invoice| Invoiced
    Fulfilling -->|🧾 Create AR invoice| Invoiced
    Shipped -->|🧾 Create AR invoice| Invoiced

    style Draft fill:#cbd5e1,color:#0f172a
    style Confirmed fill:#bfdbfe,color:#0f172a
    style Allocated fill:#ddd6fe,color:#0f172a
    style Fulfilling fill:#fed7aa,color:#0f172a
    style Shipped fill:#a5f3fc,color:#0f172a
    style Invoiced fill:#86efac,color:#0f172a
    style Closed fill:#e2e8f0,color:#0f172a
    style Cancelled fill:#fecaca,color:#0f172a
```

The header status enum is `draft → confirmed → allocated → fulfilling → shipped → invoiced → closed`, plus `cancelled` (CHECK-constrained on `sales_orders.status`). `closed` is a terminal state the current UI does not write directly.

> **Note on transitions:** the state machine is permissive, not strictly linear. You can `🧾 Create AR invoice` from any of `confirmed / allocated / fulfilling / shipped` (it invoices the full open balance and jumps the SO straight to `invoiced`), and you can `🚚 Ship` directly from `confirmed` (the ship handler accepts `confirmed/allocated/fulfilling`). Allocation is therefore an optional reservation step, not a hard gate before shipping.

### Creating a sales order (draft)

From **🛒 Sales Orders → + New sales order**. The header pickers mirror the AR-invoice modal:

| Field | Required? | Notes |
|---|---|---|
| Customer | yes | `SearchableSelect` over Customer Master. Selecting a customer prefills **Brand** and **Channel** from the customer's `default_brand_id` / `default_channel_id` (new SO only, and only if the picker is still empty). |
| Ship-to location | optional | The customer's `customer_locations` (stores / DCs). Re-fetched when the customer changes. |
| SO number | — | Read-only; shows "(assigned on confirm)". |
| Order date | yes | Defaults to today. |
| Start Ship | optional | `requested_ship_date`. |
| Cancel date | optional | |
| Payment terms | optional | |
| Brand / Channel | optional | Brand defaults to the entity default (`rof_default_brand_id()`) when left blank. |
| Factor / Ins Approval | optional | See [§27.3](#273-factor--credit-insurance-ship-gate). |
| Notes | optional | |
| Lines (≥ 1 with qty > 0) | yes | See below. |

### Lines & the size-matrix entry

Each line carries `inventory_item_id` (a **size-level SKU**, FK into `ip_item_master.id`), `qty_ordered`, and `unit_price_cents` (entered in dollars). **The line body IS the size matrix** (≈95% of styles are matrix-driven), not a flat line list:

1. **➕ Add style (matrix)** — pick a style; it loads an editable **color × size (× inseam) grid** (the same `EditableSizeMatrix` the Inventory Matrix uses) where you type ordered quantities straight into the cells, with a per-row **Unit $** and a "set all rows" bulk field. Add more styles to stack more grids. The grids ARE the order — there is no separate "add to order" step.
2. **+ Add non-matrix line** — for the rare one-off SKU, a plain SKU/qty/$ row.

On save, every filled cell is resolved to an `ip_item_master` SKU (find-or-create via `/api/internal/style-matrix/resolve-sku`) and the flat lines are appended — all submitting through the same create/PATCH path. **Editing** an existing draft rebuilds the grids: the detail endpoint decorates each line with its `style_code`/`color`/`size`, so lines regroup into per-style matrices (anything without a style/size falls to the non-matrix list). The matrix mechanics belong to the matrix primitive — see **chapter 28 (Inventory Matrix)**.

**Header totals + projected margin.** Above the grids a live readout shows **Total qty**, **Total $**, and **Projected margin %** = `(revenue − cost) / revenue`. Per cell the cost is the SKU's `avg_cost_cents` (Xoro/Excel history). When a style has **no cost history**, the cell falls back to a **21% assumed gross margin**, and when *no* line has real cost data the margin shows an **"estimated — no cost data (assumes 21%)"** note.

**Adding styles to a confirmed order.** Once confirmed, the grids collapse to **only the color rows that carry a quantity** (the order, read-only). An **✏️ Add styles** button re-opens the full editable grids so you can append more styles (or edit) and **Save changes** — the line PATCH is now allowed while `draft` *or* `confirmed` (still blocked once allocated / shipped / invoiced). Re-confirming isn't required.

> **Revenue routing is server-side.** The UI never sends a per-line `revenue_account_id`. On save the handler stamps each line with the customer's `default_revenue_account_id`, falling back to the entity default — see `resolveLineRevenueAccount()` in the handlers.

### Fulfillment source — Production vs ATS

Above the matrix grids, a **Fulfillment source** dropdown (`sales_orders.fulfillment_source`):
- **Production** — the order is being *made*. The grids **hide the on-hand hint** (irrelevant), and **on confirm** the **Production Manager** is notified by **email + in-app** (Tanda bell) via the new **"Production"** notification category. Configure the recipient by ticking **Production** on the Production Manager's employee record (Employees → notification subscriptions) or by setting `INTERNAL_PRODUCTION_EMAILS`. If none is configured, confirming still works and the UI flags that no one was alerted.
- **ATS** — the order ships from available stock. *(Showing live available-to-ship **by size** above each cell — from `tangerine_size_onhand` — is the next increment; today ATS mode still shows the matrix on-hand.)*

The alert fires once per SO (deduped on the SO id), through the same `resolveInternalRecipients` + `/api/send-notification` path as the vendor-alert / invoice alerts.

### Confirming — SO number assignment

**Save & Confirm** issues the PATCH `status: "confirmed"`. The first time an SO is confirmed, the `[id].js` handler assigns the immutable `so_number` in the format **`SO-YYYY-NNNNN`** (year from the order date; the `NNNNN` is a per-entity sequence padded to 5). The `(entity_id, so_number)` unique index enforces no collisions within a company. Lines are editable only while `draft`; the PATCH handler returns **409** on a line edit to a non-draft SO.

---

## 27.2 Confirm → draft AR invoice (M10-C)

The **🧾 Create AR invoice** button (visible on `confirmed / allocated / fulfilling / shipped` SOs) calls `POST /api/internal/sales-orders/:id/create-invoice`. It:

1. Invoices each line's **open** quantity (`qty_ordered − qty_invoiced`). M10-C invoices the full open balance in one shot.
2. Inserts an `ar_invoices` header at **`gl_status='draft'`** with `sales_order_id` set, plus `ar_invoice_lines` carrying `sales_order_line_id`, the SO's selling unit price, and (for inventory lines) `inventory_item_id`. The AR GL-account chain falls back SO → entity defaults (`default_ar_account_id` 1200, `default_revenue_account_id` 4000, `default_cogs_account_id` 5000, `default_inventory_account_id` 1300).
3. Stamps the SO lines `qty_invoiced = qty_ordered`, line status `invoiced`, and flips the header to **`invoiced`**.
4. Returns the new invoice number so the panel can deep-link.

> **The draft is NOT posted.** Creating the invoice books nothing in the GL. The operator must open it in **AR Invoices** and click **Post** — that is where the approval/credit-limit gates run and where **FIFO COGS is consumed** (DR AR / CR revenue + per-inventory-line DR COGS / CR inventory). See [chapter 16 §Posting](16-accounts-receivable.md#posting--approval-gate--fifo-consume). Allocation reserves stock but never draws down a FIFO layer; consumption happens once, at invoice post.

---

## 27.3 Factor / credit-insurance ship-gate

ROF factors many wholesale receivables (Rosenthal & Rosenthal). Each SO carries a **Factor / Ins Approval** block: `factor_approval_status` (`not_submitted` / `pending` / `approved` / `partial` / `declined` / `not_required`), `factor_reference`, and `factor_approved_cents`. These are **manual entry** today (the Rosenthal API auto-fill is reserved).

When the SO's customer is flagged `customers.is_factored = true`, the order **cannot ship** until factor approval is `approved`. The gate is enforced server-side in two places, so the client cue is advisory only:

- **`PATCH /sales-orders/:id`** — moving `status` to `fulfilling` or `shipped` returns **409** if the customer is factored and the effective `factor_approval_status` is not `approved`.
- **`POST /sales-orders/:id/ship`** — re-checks `is_factored` + `factor_approval_status === 'approved'` and returns **409** otherwise, before any shipment row is written.

The SO modal also shows an amber warning ("⚠ Factored customer — factor approval must be approved before this order can ship") whenever the selected customer is factored and the status isn't yet `approved`. The Allocations Workbench applies a stricter dollar-bounded version of this gate ([§27.5](#275-the-allocations-workbench-cross-so)).

---

## 27.4 Multi-store split (item 15)

Wholesale POs (often EDI-driven) frequently ship one order across several of a customer's stores / DCs. On a **draft** SO with ≥ 2 ship-to locations, the **🏬 Ship to multiple stores** panel splits it via `POST /sales-orders/:id/split` with `{ location_ids: [...] }`:

- Creates one **child** SO per chosen location, copying the header (customer / brand / channel / dates / terms / factor fields) and lines, with `parent_sales_order_id` set and `ship_to_location_id` = that location.
- Each line's `qty_ordered` is divided **evenly** (floor; the remainder goes to the earliest children), and zero-qty child lines are dropped.
- The source SO becomes the umbrella **`is_split_parent = true`** — its quantities now live on the children. Split parents are excluded from the allocation demand view.

Chosen locations are validated against `customer_locations` for that customer; at least two must belong to the customer. Adjust each child's quantities afterward, then confirm each child individually.

---

## 27.5 Allocations (M18) — two surfaces

Allocating **reserves** on-hand inventory against SO lines as a **soft reservation** tracked in `sales_order_lines.qty_allocated`. It does **not** consume FIFO layers. Availability is computed by the `v_inventory_available` view:

```
available_qty = on_hand (Σ inventory_layers.remaining_qty)
              − reserved (Σ GREATEST(qty_allocated − qty_shipped, 0) on live SO lines)
```

per `(entity_id, item_id)`. There is no brand-partition netting in this MVP (`BRAND_SCOPE_MODE` is off in prod).

### Surface A — per-SO "📦 Allocate stock"

On a `confirmed`/`allocated` SO, the **📦 Allocate stock** button calls `POST /sales-orders/:id/allocate` → the `allocate_sales_order()` RPC. It walks the SO's lines in order, granting `LEAST(need, live-available)` to each, bumping `qty_allocated`. The header flips to **`allocated`** only when **every** line is fully covered; otherwise it stays **`confirmed`** (partial) and the response reports per-line shortfalls. This is a one-SO greedy fill — first-come on whatever stock is free at that moment.

### Surface B — the Allocations Workbench (cross-SO)

The standalone **📊 Allocations** panel is for deciding *who gets the stock* when multiple orders compete for the same SKU. It reads `v_allocation_demand` (one row per manageable open SO line — `confirmed/allocated/fulfilling`, not split-parent, not fully shipped) joined to `v_inventory_available`, and groups the tree:

```
Style · Color   (on-hand · reserved · avail · demand)
  └─ SKU (size)   (on-hand · reserved · available)
       └─ competing SO lines  (customer · priority · ordered · allocated · open)
```

The demand rows are grouped under a **per-SO sub-header** showing **SO # · Customer · Start Ship · Cancel**. The **SO #** is a link (dotted underline + ↗): clicking it jumps to **🛒 Sales Orders** focused on that order — `?m=sales_orders&so=<SO#>` seeds the SO search box, so you land pre-filtered to it. This is the reverse of the SO modal's **📊 Allocations** drill, which brings you here focused on that same order.

**Search box — all-field, not SO-only.** The search filter is an all-field match: it matches on **style/description, SKU code, color, size, customer name, and SO #** (case-insensitive, server-side via `q`). The **× / Esc** clears it in place. When you arrive via a deep link from a Sales Order, the SO # is seeded into the box as a one-shot focus — it is **not sticky**: leaving the panel strips the `?so=` param from the URL, so re-opening **📊 Allocations** from the menu lands with an empty search and the full cross-SO view.

**Priority tiers** (the auto-allocate order, mirrored in the row badges):

| Tier | Badge | Rule |
|---|---|---|
| 1 | 🅕 factor | Factored customer **and** factor approved **and** a factor reference present |
| 2 | 💳 card | Customer has a stored card (`payment_processor` / `processor_payment_method_id` / `processor_card_last4`) |
| 3 | ⏱ oldest | Everyone else — ordered by `order_date`, then `requested_ship_date` |
| 9 | ⚠ blocked | Factored but **not** approved / missing reference — never receives stock |

**Manual edit:** type a new absolute `qty_allocated` into a line's Allocated cell (0 releases). On blur it POSTs to `apply_allocations` for that one line. You cannot go below `qty_shipped` (the cell clamps).

**Auto-allocate:** **⚡ Auto-allocate all** (header) or **⚡ Auto** per style/color opens a **preview dialog** that computes the exact size-level result via `POST /api/internal/allocations/preview` (no write) before you apply. Three **fill modes** (#789), all sharing the same priority tiering and the same hard gates:

| Mode | Behaviour |
|---|---|
| **Priority full-fill** (default) | Fill each order 100% in priority order until the per-SKU pool runs out. |
| **Fair-share (pro-rata)** | Water-fill: spread each SKU's available pool pro-rata by remaining open qty across competing orders; the rounding tail and leftover go by priority. |
| **Capped %** | Priority full-fill but cap each order at *N%* of its open qty — basis is either **each SKU line** or **each style/color total**. Bounded by real per-size availability, so a % target can never fill a zero-stock size. |

Reviewing the preview shows per-line **Now / +Grant / → New** (blocked lines show their reason). **Apply** confirms, then POSTs the granted set to `apply_allocations`, which **re-validates** — a stale preview is safe. The preview dialog **is** where you change the per-run **fill mode** (priority / fair-share / capped %) before applying.

**⚙ Rules — the persistent priority order.** The header **⚙ Rules** button opens an editor to reorder the three priority criteria (**factor-approved · credit-card · oldest**, top = filled first) and pick the within-tier tie-break (earliest **order date** vs **requested ship date**). Saved per entity in `allocation_priority_rules` and read server-side by `allocations/preview` on every run (`GET/PUT /api/internal/allocations/rules`, h602). A missing config = the historical default (factor → card → oldest, by order date). The **hard factor-credit gate** (a factored SO with no approval is never allocated) is independent of this order and always applies.

After applying, a **summary popup** reports how many lines were allocated, the units granted, and the **% of open demand filled**; **Show results** lists the per-line grants. It waits for you to close.

**Undo + batch (not one-way):**
- **↩ Undo last** (header, appears after any allocation) reverts the last run — auto-allocate, batch, or a single cell — to the prior allocated quantities. Every allocation snapshots what it changed.
- **☑ Select all** / per-line checkboxes (in the SO column) → a **batch bar** to **set** the allocation to a value or **Clear allocated** (release) across all checked lines at once, instead of editing line by line.

**Next step after allocating:** allocation only *reserves* stock — but you no longer have to leave the workbench to fulfil. Each SO sub-header now carries the **whole flow** as buttons (see below). The classic path still works: open the order in **🛒 Sales Orders**, **🚚 Ship**, then **🧾 Create AR invoice**.

### Run the whole flow from the sub-header (Allocate · Ship · Invoice · Wave)

Each SO sub-header has, next to **⚡ Auto**, four action buttons so an ops user can drive an order end-to-end without hopping to the Sales Orders panel. Each is **status-gated** — when an action isn't yet valid the button is disabled with a tooltip explaining why (it never hard-blocks the wrong status silently).

| Button | What it does | Enabled when |
|---|---|---|
| **⚡ Auto** | Opens the per-SO auto-allocate preview (priority full-fill). | Available stock > 0 and not factor-blocked. |
| **Allocate** | `POST /sales-orders/:id/allocate` — the greedy per-SO reserve RPC (Surface A). | SO is `confirmed` / `allocated` / `fulfilling` and not factor-blocked. |
| **🚚 Ship** | Opens a small ship modal (**carrier · service level · tracking · ship date**) → `POST /sales-orders/:id/ship`. Ships the remaining allocated qty on every line; the SO moves to `fulfilling` / `shipped`. | SO is `allocated` / `fulfilling`. |
| **🧾 Invoice** | `POST /sales-orders/:id/create-invoice` — creates a **draft** AR invoice for the open qty and notifies with the invoice number (`AR-YYYY-NNNNN`). Post it in **AR Invoices** to book the GL. | SO is `confirmed` / `allocated` / `fulfilling` / `shipped`. |
| **📦 Wave** | Opens a modal to pick a **3PL provider** (from Inventory → 🚚 3PL) → `POST /sales-orders/:id/wave`. Creates a 3PL shipment and transmits an **EDI 940** to that provider; the response message (transmitted / queued) is shown. If the endpoint isn't deployed yet you get a friendly "not yet available" note. | SO is `allocated` / `fulfilling`. |

The factored-customer ship-gate still applies inside **🚚 Ship** (the ship handler refuses an un-approved factored order). All four actions refresh the workbench in place when they complete.

### Show-all-rows when focused on one SO

`v_allocation_demand` intentionally hides **terminal** lines (shipped / invoiced lines, and `shipped` / `invoiced` / `closed` / `cancelled` SOs) so the cross-SO arbitration view stays about *open* contention. That had a side-effect: when you drilled in from a Sales Order via **📊 Allocations** (`?m=sales_allocations&so=<SO#>`), a partly- or fully-shipped order looked **open-only** — its already-shipped lines were simply gone, even with **“Only with open qty” unchecked**.

Fixed: when the workbench is **focused on a single SO** (the search box still equals the deep-linked SO #), the GET sends `?so=<SO#>&include_all=1`, and the server returns **every** line of that one order straight from `sales_order_lines` (bypassing the view's terminal exclusions) — shaped identically to the normal demand rows. You now see the complete order. A violet banner confirms the focus and offers **Show all demand** to drop back to the cross-SO view.

Outside the focused case, the **“Only with open qty”** checkbox is the *only* open-qty filter — when it's **unchecked** the client applies **no** `open_qty > 0` filter of its own; an info note appears whenever it's on, reminding you rows may be hidden.

### The hard factor-credit gate (workbench)

`apply_allocations()` is the single authoritative write path (used by both manual cells and auto-allocate). For a factored customer it only lets an **increase** land when all three hold:

1. `factor_approval_status = 'approved'`,
2. a non-empty `factor_reference`, and
3. the resulting SO allocated dollars (`Σ qty_allocated × unit_price_cents` across live lines) **≤ `factor_approved_cents`**.

Anything that fails is returned in `skipped[]` with a reason (e.g. `factor approved $X < allocated $Y`). The RPC also caps every increase by the running per-item available pool (so a batch can't over-commit one SKU), clamps each target to `[qty_shipped, qty_ordered]`, and recomputes each touched line + SO header status.

> **SO header flips to `allocated` on ANY allocation (PR #1005).** Through the Workbench (`apply_allocations`), as soon as a `confirmed` SO carries **any** allocated quantity (even a partial fill of a single line) its header moves to **`allocated`** — partial allocation is still "allocated / in progress". Releasing **all** allocation back to zero across the SO's live lines reverts it to `confirmed`. Orders already at `fulfilling` / `shipped` / `invoiced` / `closed` are never downgraded. (The per-SO **📦 Allocate stock** button — Surface A, a different RPC — still only flips to `allocated` on a *full* fill of every line; partial fills there leave it `confirmed`.) The `allocated` status shows as a violet badge in the Sales Orders list and is selectable in its status filter.

---

## 27.6 Shipping (M44)

> **Table-name note:** inbound vendor/PO freight already owns `shipments` / `shipment_lines`. Outbound SO fulfilment deliberately uses **`sales_order_shipments`** / **`sales_order_shipment_lines`** to avoid the collision.

On an `allocated` or `fulfilling` SO the **🚚 Ship** button opens a modal (Carrier, Ship date, Tracking #) → `POST /sales-orders/:id/ship`. The handler:

1. Verifies status is `allocated`/`fulfilling`/`confirmed`, then enforces the **factored ship-gate** ([§27.3](#273-factor--credit-insurance-ship-gate)) — 409 if blocked.
2. Ships, per line, the **remaining allocated** qty (`qty_allocated − qty_shipped`) by default (or an explicit per-line qty if supplied), clamped so you can never ship more than is allocated.
3. Inserts the `sales_order_shipments` header (carrier / service level / tracking / ship date, status `shipped`) + `sales_order_shipment_lines`, and bumps each `sales_order_lines.qty_shipped`.
4. Flips the header to **`shipped`** when every non-cancelled line is fully shipped, else **`fulfilling`** (partial).

Shipping is a physical/logistics record only — **no GL impact, no FIFO**. COGS is still recognised later at AR-invoice post.

---

## 27.7 Day-to-day workflow

1. **Take the order.** 🛒 Sales Orders → **+ New** → pick customer (brand/channel/terms prefill) → add lines (the size-matrix body — **➕ Add style** per style, **+ Add non-matrix line** for one-offs) → optionally set Factor/Ins Approval → **Save & Confirm**. The SO gets its `SO-YYYY-NNNNN` number.
2. *(Optional)* **Split across stores** while still a draft (🏬 Ship to multiple stores) → adjust + confirm each child.
3. **Reserve stock.** Either per-SO **📦 Allocate stock**, or open **📊 Allocations** to arbitrate across competing orders — pick a fill mode, preview, apply. Factored orders only fill when approved and within the approved $.
4. **Ship.** 🚚 Ship → enter carrier + tracking → confirm. SO → `shipped` (or `fulfilling` if partial). Blocked at 409 if the customer is factored and not approved.
5. **Invoice.** 🧾 Create AR invoice → a **draft** AR invoice is created and the SO → `invoiced`. Then go to **AR Invoices** and **Post** it to book revenue + FIFO COGS ([chapter 16](16-accounts-receivable.md)).

---

## 27.8 What's NOT yet usable

- **No GL posting from this module.** SOs, allocations, and shipments never touch the ledger; only the downstream AR invoice (posted in AR Invoices) does.
- **Factor approval is manual.** The Rosenthal & Rosenthal Factor API auto-fill is reserved — the fields are typed in by hand for now.
- **Allocation is unbranded.** No `inventory_partition` / brand netting yet (waits on `BRAND_SCOPE_MODE=enforce`).
- **`closed` status** is in the enum but not written by the UI.
- **Partial-quantity invoicing.** M10-C invoices the full open balance in one shot; there is no progressive ship-then-invoice-what-shipped split yet (Create AR invoice closes out all open lines).
- **No approval gate on the SO itself.** Approval/credit-limit gates live on the AR invoice at post time, not on SO confirm.

---

## 27.9 Code map

- **UI:** `src/tanda/InternalSalesOrders.tsx` (list + create/edit/confirm/allocate/ship/invoice/split modal), `src/tanda/SalesOrderMatrixBody.tsx` (the size-matrix line body — per-style grids + non-matrix flat lines + save-time SKU resolve), `src/tanda/InternalAllocations.tsx` (Allocations Workbench + auto-allocate preview dialog + per-SO Allocate/Ship/Invoice/Wave actions + focused-SO show-all).
- **SO handlers:** `api/_handlers/internal/sales-orders/index.js` (GET list / POST create), `.../[id].js` (GET / PATCH incl. confirm + ship-gate / DELETE), `.../create-invoice.js`, `.../allocate.js`, `.../ship.js`, `.../split.js`, `.../wave.js` (3PL wave + EDI 940).
- **Allocations handlers:** `api/_handlers/internal/allocations/index.js` (GET demand+availability — also `?so=&include_all=1` show-all-rows for a focused SO / POST `apply_allocations`), `.../allocations/preview.js` (fill-mode preview compute).
- **Schema:** `supabase/migrations/20260712110000_p16_m10a_sales_orders_schema.sql` (`sales_orders` + `sales_order_lines`), `20260712120000_p16_m10c_so_invoice_link.sql`, `20260712150000_p16_so_multistore_split.sql`, `20260712200000_p16_m18_allocations.sql` (`v_inventory_available` + `allocate_sales_order()`), `20260714010000_p16_m18_allocations_workbench.sql` (`v_allocation_demand` + `apply_allocations()`), `20260712210000_p16_m44_shipments.sql` (`sales_order_shipments` + `_lines`).

## Related docs

- [16-accounts-receivable.md](16-accounts-receivable.md) — where the draft AR invoice is posted (revenue + FIFO COGS).
- **Chapter 28 (Inventory Matrix)** — the size-scale / color×size grid primitive behind matrix SO entry.
- [11-inventory-operations.md](11-inventory-operations.md) — inventory layers feeding `v_inventory_available`.
- [19-revenue-operations.md](19-revenue-operations.md) — sales-rep commissions that accrue off the posted AR invoice.
