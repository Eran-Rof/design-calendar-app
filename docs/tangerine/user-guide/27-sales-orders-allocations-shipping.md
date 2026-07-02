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

> **Invoiced → green clickable header.** Once a sales order has been billed into an AR invoice, re-opening it shows the modal header in **green** and reads `Sales order SO-2026-00002 — invoiced · 🧾 AR-2026-00007 ↗`. Clicking the header jumps to **🧾 AR Invoices** filtered to that invoice (`?m=ar_invoices&q=<INV#>`) — the reverse of the **🧾 Create AR invoice** drill. The link resolves the invoice by `ar_invoices.sales_order_id` (the M10-C link column, served via `GET /api/internal/ar-invoices?sales_order_id=<uuid>`); the most-recent non-void invoice wins. Un-invoiced orders keep the plain title.
>
> **Status colour matches the grid.** The status word in the modal header is shown with the **same colour + ● dot** the list grid uses for that status (draft/confirmed/allocated/fulfilling/shipped/invoiced/closed/cancelled), so the opened order is visually consistent with the row you clicked.

### Creating a sales order (draft)

From **🛒 Sales Orders → + New sales order**. The header pickers mirror the AR-invoice modal:

| Field | Required? | Notes |
|---|---|---|
| Customer | **yes (to add styles)** | `SearchableSelect` over Customer Master. Selecting a customer **auto-sets Channel** from the customer — a **Shopify**-named customer ⇒ **DTC**, everyone else ⇒ **Wholesale** (matched by `channel_master` code; you can still change it) — and **pre-fills the Ship-to address** from the customer's default location (see Ship-to). Brand seeds from the customer default but is then **overridden by the selected style's brand** (see Brand below). **Add on the fly (item 8):** if you type a name that isn't on file, a **"+ Add customer '<name>'"** row appears in the dropdown — click it to open the Add-customer popup **pre-filled with that name**; on Save the new customer is selected here, and a **"complete the customer info"** reminder is sent to your notifications (the short form omits terms / GL routing / addresses). **Item 14:** on-the-fly customers get an auto `CUST-NNNNN` code as their `customer_code` (it's required), so the add no longer fails with a not-null error. **Item 21:** the Add-customer popup now also requires a **ship-to address** (street + city; line 2 / state / postal optional) — because a sales order can't proceed without one. On Save it creates the customer **and** their **default ship-to location** (`customer_locations`), which the Ship-to picker then auto-selects so you can keep working without leaving the order. |
| Buyer | optional | `SearchableSelect` of the **buyers on the selected customer** (from Customer Master → Buyers). Records which buyer placed the order (`sales_orders.buyer_id`). Re-fetched when the customer changes; cleared if you switch customers. Disabled until a customer is picked. Validated server-side to belong to the order's customer. |
| **Ship-to address** | **yes (to add styles)** | The customer's `customer_locations` (stores / DCs). Re-fetched when customer is selected and **pre-filled from the customer master**: the customer's **default** location is auto-selected (or the only one if there's no explicit default). The selected location's **address is shown** under the picker. **Required before you can add styles** and before save; if the customer has multiple locations and none is default, pick one. Locations are managed in **Customer Master → Locations tab**; the list is seeded nightly from Xoro SO history via `rest_customer_locations_sync.py`. |
| SO number | — | Read-only; shows "(assigned on confirm)". |
| **Customer PO #** | **yes (to add styles)** | `sales_orders.customer_po` — the buyer's own purchase-order reference. One of the **add-styles prerequisites** (Customer · Ship-to address · Customer PO # · **Warehouse** · Fulfillment source). **Item 16:** the **Add style / + Add non-matrix line** buttons stay **visible**; clicking one before the prerequisites are filled shows a specific warning (e.g. *"Customer PO must be populated"*, *"Warehouse must be populated"*) instead of being hidden. A ⚠️ banner still lists what's missing. Free text. This is also the field the **🤖 Upload customer PO** AI flow fills in. |
| Order date | yes | Defaults to today. |
| Start Ship | optional | `requested_ship_date`. |
| Cancel date | optional | **Item 19:** auto-defaults to **Start ship date + 6 days** when you set a ship date — and re-derives if you change the ship date, but **never overwrites a value you typed yourself** (a manual edit sticks). **Item 15:** can't be **earlier than the Start ship date** — an inline warning shows and the save is blocked until it's fixed. |
| Payment terms | optional | **Auto-fills from the customer master** (`customers.payment_terms_id`) when you pick a customer — overridable, and never clobbers a value you already chose. |
| Brand | auto | **Auto-populated from the selected style** — picking a style in the matrix sets Brand to that style's brand (the first matrix style with a brand wins). You can override it; blank falls back to the entity default (`rof_default_brand_id()`). The dropdown shows **brand names only** (no codes; codes are still searchable). |
| Channel | auto | **Auto-filled from the customer** (Shopify ⇒ DTC, else Wholesale — see Customer). Overridable. Shows **channel names only** (no codes; codes still searchable). |
| **Warehouse** | **yes (to add styles)** | `sales_orders.sale_store` — the order's **warehouse**. The picker is sourced from the **Warehouses master** (`/api/internal/warehouses`: Main Warehouse / Psycho Tuna / Psycho Tuna Ecom / ROF Ecom). Tangerine has **warehouses + brands, no sales stores**. **Item 20:** a **new** sales order defaults this to **Main Warehouse** (you can change it; editing an existing order keeps its saved value). **Required** to add styles. Drives the **Warehouse filter** on the SO list. Imported orders' legacy Xoro names were reconciled to the master names (mig 20260925: *ROF Main → Main Warehouse*, *ROF - ECOM → ROF Ecom*, *Prebook - Psycho Tuna → Psycho Tuna*), and the importer maps them going forward. *(The column is still named `sale_store` internally; the value is the warehouse name.)* |
| Factor / Ins Approval | optional | See [§27.3](#273-factor--credit-insurance-ship-gate). |
| Notes | optional | |
| Lines (≥ 1 with qty > 0) | yes | See below. |

### 🤖 Auto-fill from the customer's PO (AI upload)

On a **new** sales order, next to the Customer PO # field is a **🤖 Upload customer PO** button. It reads the customer's purchase order and prefills the whole order so you only have to review it.

1. Click **🤖 Upload customer PO**. Either **choose a file** (PDF, Excel `.xlsx`/`.xls`, or `.csv`/`.txt`) **or paste the order email** into the text box, then **Read & prefill**. The document is sent to `POST /api/internal/sales-orders/parse-customer-po`, which uses Claude (Sonnet) to extract a structured PO. **A chosen file is also auto-attached to the order's Supporting Documents** (staged, uploaded when you save) so the original PO is filed with the SO.
2. **Duplicate guard** — before anything is filled, the PO number is checked against existing sales orders. If a **non-cancelled SO already carries that exact customer PO #**, the dialog stops and shows a **⚠️ This customer PO already exists** warning listing the existing order(s); your only choices are **Open existing SO ↗** (opens it in a new tab) or **Cancel — don't create a duplicate**. No duplicate SO is created.
3. **Confirm choices** — when something the AI matched is uncertain, the dialog **asks you to choose before filling** (instead of silently guessing and asking you to spot it afterward):
   - **Base vs PPK** — if a style exists in **both** a base and a prepack (PPK) form, you pick which to order.
   - **Customer** — if the PO's customer name didn't match exactly, an **AI matcher** (`POST /api/internal/sales-orders/match-customer`, Claude Haiku) picks the best account from the master *semantically* — so a buying entity like **"Ross Stores, Inc."** maps to **"Ross Procurement"** rather than to an unrelated name that merely shares a word. Its pick is pre-selected (with a one-line reason) and you confirm or override it from the full searchable customer list.
   - **Colour row** — if a PO colour didn't map cleanly onto one of the style's actual colours (e.g. PO `"Media Park"` → `"Media Park- Dark Wash"`), you pick the correct colour row (the suggested one is marked ★).
   These steps only appear when needed; with nothing ambiguous, the order fills straight away.
4. **Header prefill** — the AI's customer (your confirmed pick, or an exact match), payment terms, start-ship / cancel dates, and PO number are filled in. The customer also auto-sets **Channel**, and **Fulfillment source is auto-set to ATS** and **highlighted** for you to confirm. Anything still unmatched (e.g. a term, or a customer you left to pick manually) is listed in the review banner.
5. **Matrix prefill** — each ordered style is matched to Style Master and dropped into the size matrix:
   - **Exact sizes** when the PO lists a size run (S 12 · M 24 · …) go straight into the cells. Any size that isn't a full **carton of 24** is flagged; a **Round those sizes up to full cartons** button rounds each up.
   - **Total only** (no size split) is distributed across sizes via the style's **Style Master size scale** (📐 Scale), rounding each size up to a full carton.
   - **PPK (prepack) styles** — the PO's total units ÷ the pack's units-per-carton, **rounded up** to whole cartons, prefilled into the PPK column. The rounding is noted in the review banner.
6. **Double-check** — a green review banner summarizes what was filled, lists anything unmatched, and flags carton / PPK-rounding mismatches. **Always review every prefilled value before saving** — the AI is advisory.

The button is **new-SO only**. You can still type everything by hand; the upload is a shortcut, not a requirement.

### Lines & the size-matrix entry

Each line carries `inventory_item_id` (a **size-level SKU**, FK into `ip_item_master.id`), `qty_ordered`, and `unit_price_cents` (entered in dollars). **The line body IS the size matrix** (≈95% of styles are matrix-driven), not a flat line list:

1. **➕ Add style (matrix)** — pick a style; it loads an editable **color × size (× inseam) grid** (the same `EditableSizeMatrix` the Inventory Matrix uses) where you type ordered quantities straight into the cells, with a per-row **Unit $** and a "set all rows" bulk field. The columns end with **Total** (row units) → **Unit $** → **Total $** (the extended line amount, units × Unit $), with a grand **Total $** in the footer. Unit prices **snap to two decimals** when you tab out of the field. Add more styles to stack more grids. The grids ARE the order — there is no separate "add to order" step.
   - **Qty quick-fill** — each row (color, or color × inseam) has a **Qty** box between the lead columns and the first size. Type one total (e.g. `1200`) and press **Enter/Tab** to split it across sizes using the style's stored **size scale** pack ratio (Style Master → **📐 Scale**) — the **matching inseam's** curve when the style has inseams — rounding **each size up to a full carton of 24** (so the grand total can land slightly above the typed number). Disabled for styles with no Scale set.
   - **Carton check** — a partial-carton cell (positive qty not divisible by 24, usually from hand-editing) raises one **⚠️ not full cartons of 24** banner under the grid listing the cells, to accept or adjust.
   - **Collapse empty size columns** — once any cell carries a quantity the **first size column header turns green** and becomes clickable. Click it to **hide the all-zero size columns before the first sized column and after the last** — so a wide scale (e.g. a 14-size denim waist run) collapses to just the sizes you're actually ordering. Mid-range zero sizes stay visible. A `⋯` marker shows where columns are hidden; click the green header again to show them all. (Available on both SO and PO size matrices.)
   - **ATS availability check** — when **Fulfillment source = ATS** (ship from stock), entering a qty that exceeds what's available to ship for that size pops a warning — **there is not enough quantity available to fill the order** — with three choices: **Continue anyway** (keep the qty as a back-order beyond stock), **Change to ATS qty** (clamp the cell to the available number), or **Cancel** (revert the cell). The available number is the same ATS figure shown faintly above each cell.
2. **+ Add non-matrix line** — for the rare one-off SKU, a plain SKU/qty/$ row (its Unit $ also snaps to two decimals on blur).

> **Lot numbers on SO lines.** A sales-order line carries a per-style+color **lot number** too, but the SO matrix does **not** show a lot column for hand entry — SO lots are filled by the downstream flows (e.g. when a production PO is created from the order, the lot it inherits ties the two together). See **[chapter 45 — Lot Numbers](45-lot-numbers.md)**.

On save, every filled cell is resolved to an `ip_item_master` SKU (find-or-create via `/api/internal/style-matrix/resolve-sku`) and the flat lines are appended — all submitting through the same create/PATCH path. **Editing** an existing draft rebuilds the grids: the detail endpoint decorates each line with its `style_code`/`color`/`size`, so lines regroup into per-style matrices (anything without a style/size falls to the non-matrix list). The matrix mechanics belong to the matrix primitive — see **chapter 28 (Inventory Matrix)**.

**Header totals + projected margin.** A **centered totals line** sits at the **top** of the lines section showing **Total qty**, **Total $**, and **Proj. margin %** (the figures are the same size as their labels). This is the **single** totals readout — the small duplicate that used to repeat at the bottom of the grids was removed, as was the duplicate that used to sit above it.  ( The Save / Close buttons live only in the **frozen bottom footer** — the earlier duplicate top bar was removed since the footer stays visible. It replaced the old "▲ available-to-ship by size" caption; the per-cell availability numbers still render above each cell in ATS mode.) In **ATS** mode each cell's faint number now carries a **hover tooltip** — **ATS (MM/DD/YYYY)** for the as-of ship date, or just **ATS** when no ship date is set; in non-ATS mode it reads **on-hand**. (The old blue "Cell numbers show available-to-ship by size" caption under the Fulfillment dropdown was removed in favour of this hover, and the redundant "Lines — size matrix" label above the grids was dropped.) Projected margin **%** = `(revenue − cost) / revenue`. Per cell the cost is the SKU's `avg_cost_cents` (Xoro/Excel history). When a style has **no cost history**, the cell falls back to a **21% assumed gross margin**, and when *no* line has real cost data the margin shows an **"estimated — no cost data (assumes 21%)"** note.

> **Per-style "Below cost" flag.** When a style's **average cost exceeds the unit price** you entered (so that style is projected at a loss), a red **`Below cost · −X.X%`** badge appears in that style's section header (next to the style name) — so when the blended Proj. margin goes negative you can see *which* style is dragging it down instead of back-calculating. It only fires on styles with **real cost data** (the 21% fallback can never be below cost) and works for **prepacks** too (the per-pack price is compared against the per-pack average cost). Hover the badge for the exact margin and the fix (raise the unit price above the average cost). Example: ordering RYB0412 at **$5.00**/ea against a **$5.71**/ea average cost flags −14.2%.

**Adding styles / lines.** The **Add style (matrix)** and **+ Add non-matrix line** buttons sit **on the Fulfillment-source line** (right-aligned, next to the ATS/Production dropdown — operator item 2), not inside the lines section, so they're next to the last prerequisite you fill. There is no separate "Add styles" step. Each new picker — matrix **or** non-matrix line — is inserted at the **top** of the existing lines (not appended at the bottom). The empty lines area no longer shows the old "Click Add style…" instruction (operator item 4) — just use the buttons above. Once a SO is confirmed, the grids show **only the color rows that carry a quantity** (the order); clicking either Add button re-opens the full editable grids, then **Save changes** appends them. The line PATCH is allowed while `draft` *or* `confirmed` (still blocked once allocated / shipped / invoiced); re-confirming isn't required. You can likewise adjust **Unit $** on a confirmed order and **Save** without re-confirming.

> **Style images (item 25).** A **Show images / Hide images** toggle sits above the lines (on Sales Orders, Purchase Orders and AR Invoices — it's the shared line editor). It's **OFF by default** and remembered across orders. When ON, each style line shows a **thumbnail preceding the style** — the same image + click-to-open-gallery behaviour as the **Inventory Matrix** — and the image **flows into the order's documents**: the **PDF / print** view and the **emailed confirmation** embed the picture, and the **Excel** download carries it as a one-click image **link** in the style row. Turn it off to go back to the compact, text-only lines and documents.

**Prepacks (PPK) are entered in packs.** Adding a PPK style renders a **pack-entry grid** (one column = the pack token, e.g. `PPK24`) instead of the garment-size grid: type the **number of packs** per color, with a per-pack price and a **▾ size breakdown (explode)** showing `packs × the per-size composition`. The line stores packs; the size breakdown comes from the **Prepack Matrix master**. Same behavior on Purchase Orders — see [chapter 28 §28.7](28-purchase-orders-and-size-matrix.md).

> **Per-each price → pack price auto-calc (item 12).** The pack grid has a **Unit $** (per-each) column **before** the **Unit $ / pack** column: type the each price and the pack price auto-fills `each × pack size` — e.g. **$5.00** each on a **PPK24** ⇒ **$120.00**/pack. The pack-size comes from the matrix composition total, or the digits in the pack token (`PPK24` → 24) when no breakdown is defined yet. The pack-price column stays editable for an override, and a header **set-all** stamps one each-price across every colour. (Same on POs.)

> **Add the size breakdown inline (item 10 / 24).** When a PPK style has no Prepack Matrix yet, the grid shows *"No size breakdown is defined for this prepack…"* with a **+ Add prepack matrix** button. It opens the **exact same "Add prepack matrix" form used in the Prepack Matrices Master** (item 24 — one shared `MatrixFormModal`, so the two never drift): name, PPK style + pack token (**prefilled** from the line), active flag, notes, a **Size Scale picker** that lays out the composition columns, and the inner-pack / units-per-inner-pack **or** carton-box entry grids with pack-token total validation. On save it writes to the master (`POST /api/internal/prepack-matrices`) and **reloads the style in place** so the pack immediately explodes — no leaving the order.

> **Save / Close are duplicated at the top.** Because the matrix can grow tall, the same Save / Close buttons from the sticky footer also appear in a small bar directly under the modal title, so you can save without scrolling.

> **Unsaved-changes guard.** On a **new** order that already has data (customer, PO #, dates, or any matrix lines), clicking **Close** or clicking outside the modal first asks *"This sales order hasn't been saved. Close and discard your changes?"* — so an in-progress or AI-prefilled order isn't lost by an accidental click. (Saving normally closes without the prompt.)

> **Confirmation (item 7).** Next to **Close**, the **Confirmation ▾** button is the single entry point for the order document and opens a small menu with three choices:
> - **Download to Excel** — saves the SO as an `.xlsx`: header block (customer, PO #, dates, terms, buyer…), then one stacked **color × size matrix table per style** (color/inseam rows × size columns, per-row Qty / Unit $ / line total, per-style totals) and grand totals. Same data as the printable doc.
> - **Save as PDF / Print** — opens the SO as a **branded document** in a new window (Ring of Fire logo, header fields, the per-style matrices, grand totals) and jumps straight into the browser's **Print / Save as PDF** dialog. Both Excel and PDF work on a **draft** too (number shows `(draft)`), reflecting whatever is currently entered.
> - **Email confirmation to buyer…** (saved orders only) — opens the email dialog **pre-targeted to the buyer on this order**. If the order has no buyer set, pick one from the customer's **buyers / contacts** in the dropdown (or type an address); add an optional note, and tick **Also attach the order's documents** — when there's more than one, choose **which** to attach. Send builds a **branded HTML confirmation server-side** (authoritative, not the browser's copy) and emails it via Resend (`POST /api/internal/sales-orders/:id/email-confirmation`). Selected documents are validated to belong to this order, then attached via short-lived signed URLs. Needs `RESEND_API_KEY`; recipient emails come from **Customer Master → Buyers / Contacts**.
>
> **Prepack (PPK) detail on the confirmation.** When the order has **prepack (PPK) styles**, all three confirmation outputs (Excel, PDF/print, and the emailed copy) add a **"Prepack (PPK) detail"** section per PPK style, beneath the line matrix:
> - **Pack composition** — the **inner pack** and **carton pack** units per size for one pack (from the Prepack Matrix master: `inner_pack_qty` / `qty_per_pack`), with pack totals.
> - **Full size breakdown** — each color's packs **exploded to garment units** (`packs × carton-pack qty` per size), with per-size and grand totals (units + packs).
>
> So the customer sees both *how a pack is built* and *the total garment quantities by size* alongside the pack counts. A PPK style with no matrix defined shows a "no size breakdown defined" note instead.

> **Revenue routing is server-side.** The UI never sends a per-line `revenue_account_id`. On save the handler stamps each line with the customer's `default_revenue_account_id`, falling back to the entity default — see `resolveLineRevenueAccount()` in the handlers.

### Per-line Customer PO — auto-split into separate SOs

Sometimes a single order you're entering actually spans **more than one customer PO** — the buyer sent one document but some styles belong to a different PO number. Rather than re-key each into its own order, use the **per-line Customer PO** field.

- Above the line matrix, click **Show line PO** (a toggle next to *Show lots* / *Show images*). Every **style line** gains a **Customer PO** field, **pre-filled with the header Customer PO**.
- Leave a line on the header PO and it stays on this order. **Change a line to a different PO** and a `↳ splits to a new SO on save` hint appears (amber border).
- **On save**, for each distinct new PO, Tangerine **auto-creates a new sales order**: it copies **all of this order's header information** (customer, ship-to, brand, channel, dates, payment terms, buyer, warehouse, fulfillment source, factor fields), carries **only the style line(s) that share that PO** (lines with the same new PO are grouped onto one SO), is **saved and confirmed automatically** (its SO number is assigned immediately), and its **Notes** get the line **“Auto created due to new Customer PO.”**
- The order you were editing keeps the header PO and the lines that matched it. **At least one line must keep the header PO** — if you reassign *every* line away, save is blocked with a prompt (change one back, or update the header PO instead).
- A **summary dialog** then lists every new SO (number · PO · style count · qty) with an **Open** button each (opens in a new tab) plus **Open all**. Click **Done** to return to the list.

*This is a Sales-Order-only convenience; it needs no extra setup and creates no line-level PO column — each resulting SO simply carries its own PO in the header. Non-matrix (flat) lines always stay on the parent order.*

### Fulfillment source — Production vs ATS

Above the matrix grids, a **Fulfillment source** dropdown (`sales_orders.fulfillment_source`). **It is required** — you must pick **ATS** or **Production** before the **Add style (matrix) / + Add non-matrix line** buttons (which sit on this same line, right-aligned) appear, and saving is blocked until it's set (the field shows a warning border + prompt while empty). The fulfillment **helper messages** (the "On-hand hidden; Production Manager is notified on confirm." note, the ATS auto-set confirmation, and the "Pick ATS or Production…" prompt) now render on **their own line directly below** the dropdown (operator item 3) rather than crowding to its right. When you use **🤖 Upload customer PO**, it is **auto-set to ATS and highlighted** (blue border + "confirm it's correct or change it") so you double-check before saving.
- **Production** — the order is being *made*. The grids **hide the on-hand hint** (irrelevant), and **on confirm** the **Production Manager** is notified by **email + in-app** (Tanda bell) via the new **"Production"** notification category. Configure the recipient by ticking **Production** on the Production Manager's employee record (Employees → notification subscriptions) or by setting `INTERNAL_PRODUCTION_EMAILS`. If none is configured, confirming still works and the UI flags that no one was alerted.
- **ATS** — the order ships from available stock. *(Showing live available-to-ship **by size** above each cell — from `tangerine_size_onhand` — is the next increment; today ATS mode still shows the matrix on-hand.)*

The alert fires once per SO (deduped on the SO id), through the same `resolveInternalRecipients` + `/api/send-notification` path as the vendor-alert / invoice alerts.

### Confirming — SO number assignment

**Save & Confirm** issues the PATCH `status: "confirmed"`. The first time an SO is confirmed, the `[id].js` handler assigns the immutable `so_number` in the format **`SO-YYYY-NNNNN`** (year from the order date; the `NNNNN` is a per-entity sequence padded to 5). The `(entity_id, so_number)` unique index enforces no collisions within a company. Line edits PATCH through while the SO is `draft` *or* `confirmed` (e.g. to fill in Unit $ after confirming); the handler returns **409** once the SO is `allocated` / `shipped` / `invoiced`.

### ✎ Edit header on a saved order (item 13)

Re-opening a saved order, a **✎ Edit header** button (footer) unlocks the **header** — customer, ship-to, buyer, dates, payment terms, brand, channel, store, fulfillment source, factor fields, Customer PO #, notes — for correction **at any status**, independent of the line matrix (which stays draft/Add-styles gated). **Save header** PATCHes only the header (it sends no `lines`, so the line lock never trips and quantities are untouched). Use this to fix a wrong ship-to, terms, or PO # on a confirmed/allocated order without re-opening or re-confirming it.

### Finding a sales order (list search)

The **Search SO #, customer, style…** box at the top of 🛒 Sales Orders is **all-field**: the server matches the typed text against the **SO number**, the **customer name / code**, the order **notes**, and any **line's style / SKU / line description** (case-insensitive, substring). So you can pull up an order by who it's for or by a style on it, not just its number. It works alongside the **Customer**, **Status** and **Store** filters (all are ANDed) and updates as you type (200 ms debounce).

> **Status — multi-select (operator item 6).** The **Status** filter is a **multi-select dropdown** (checkbox list with search): tick any combination of statuses (e.g. *confirmed* + *allocated* + *fulfilling*) to see them all at once. It **defaults to the live/open set — draft, confirmed, allocated, fulfilling** — so the grid opens on actionable orders rather than the full closed/cancelled history; clear or change the ticks to widen it. Empty = all statuses. The selected set is passed to the server as a comma list (`?status=confirmed,allocated`) and applied with an `IN (…)`; when a text search is also active, the multi-status set is applied to the search results.

> **Warehouse filter (operator item 5).** A **Warehouse** dropdown lets you scope the list to one warehouse (`sales_orders.sale_store`). The options come from the **Warehouses master** (`GET /api/internal/warehouses`: Main Warehouse / Psycho Tuna / Psycho Tuna Ecom / ROF Ecom). Tangerine has **warehouses + brands, no sales stores**. "All warehouses" = no scope. Legacy imported orders had their Xoro names reconciled to the master (mig 20260925), so the filter matches both old and new orders. The all-field search runs in the `search_sales_orders` SQL function, so it spans the entire order book.

### Date-range filter

Next to the search box the toolbar has a **date-range filter**: a **field picker** (`Order date` or `Start ship date`) followed by **From** / **To** date inputs and a **Presets…** dropdown (MTD, YTD, This Year, Last Year, Last month, Last 30d / 60d / 90d, Last Quarter, etc. — the shared `DateRangePresets`). The field picker chooses **which** date the window applies to: the order date (`order_date`) or the start ship / requested-ship date (`requested_ship_date`) — it **defaults to Start ship date**. Filtering is **client-side** over the loaded rows — orders whose chosen date falls within `[From, To]` (inclusive) are kept; an order with no value for the selected field is hidden whenever a bound is set. A **Clear dates** button appears once a range is active. The filter also narrows the **Export** download.

> **Export covers the whole filtered set, not just the page (item 17).** The grid shows up to 500 rows at a time, but **Export** now downloads **every order matching the current filters/search** — it fetches all server pages behind the scenes (the button reads **Preparing…** while it works), applies the same date range, then builds the file. With no filters that's the entire order book; filter first (status / warehouse / date) to scope it. (Server: `GET /api/internal/sales-orders` accepts `?offset` for 500-row pages; the text-search path paginates via `search_sales_orders`'s `p_offset`.)

### List columns — Cancel date + Qty + cost/margin metrics

Beyond the original SO #, Customer, Order date, Start Ship, Status, Factor and Total columns, the grid carries (all toggleable via **⚙ Columns**, and all included in **Export**):

- **Warehouse** — the order's warehouse (`sale_store`); the same value the Warehouse filter scopes by.
- **Cancel date** — the order's `cancel_date`.
- **Qty (item 18)** — the **total units** across the SO's lines (qty-weighted from `sales_order_lines.qty_ordered`; style-scoped to match the metric columns when a style search is active). Computed server-side as `total_qty`.
- **Avg cost** — the qty-weighted average unit **cost** across the SO's lines. Cost is sourced per SKU from **`ip_item_avg_cost`** (the same Xoro/Excel average-cost source the Inventory Snapshot uses), matched by `sku_code` (exact, then a loose alphanumeric match). Lines whose SKU has no cost history are excluded from the cost average.
- **Avg sell** — the qty-weighted average unit **selling price** across the SO's lines (from `sales_order_lines.unit_price_cents`).
- **Margin $** — Avg sell − Avg cost (per unit). Coloured green when ≥ 0, red when negative.
- **Margin %** — Margin $ ÷ Avg sell × 100 (one decimal).

All money is shown to **two decimals**; a metric reads **—** when it can't be computed (e.g. no priced lines, or no cost history on any line).

> **Style-aware metrics.** Normally the four metric columns reflect the **whole SO**. But when you type a **style** into the search box (or arrive via a `?style_id=` drill), the metrics recompute to reflect **only that style's lines** on each order — so you can read the cost/sell/margin of one style across the orders that carry it. The aggregation runs **server-side** in `GET /api/internal/sales-orders` (per-SO `avg_cost_cents` / `avg_sell_cents` / `margin_cents` / `margin_pct`), accepting an optional `style` / `style_id` scope; it only narrows when a line actually matches the style, so a non-style search (e.g. a customer name) safely falls back to the whole-SO figures.

The grid **header is frozen** — it stays pinned to the top while the rows scroll (the table sits in a scrolling container capped at the viewport height).

> **Row expander + Explode toggle (item 30).** A leading **▸ / ▾** column expands any order in place to show its **per-line detail** (Style · Color · Size · Qty · Unit $ · Line total). The toolbar **Explode** button (labelled **Explode**, highlighted **Explode ✓** when active) switches how prepack (PPK) quantities read across the whole grid: **off** they show as **packs**; **on** they explode to **garment units** (packs × pack size). Turning Explode on keeps the per-unit metric columns consistent with the Qty column — **Avg cost**, **Avg sell** and **Margin $** switch from **per-pack** to **per-each** (each per-pack figure ÷ the blended pack size = `Qty exploded ÷ Qty packs`), e.g. a `$176.40`/pack sell on a **PPK24** order reads **$7.35** per each once exploded. **Margin %**, **Total** and **Total Margin $** are unchanged by Explode (they're order-level invariants). Non-prepack orders are identical in both modes. The **Export** download mirrors whichever mode is active, so the sheet always matches the screen.

### Deleting / cancelling a sales order

A trailing **Actions** column (always shown) carries a red **✕** on each removable order, and the same action lives in the **footer of the order detail view** (a **Delete draft** / **Cancel order** button). The action adapts to the order's status, mirroring the API rule that a non-draft SO is never hard-deleted:

- **`draft`** → **Delete** (after a confirm dialog) — `DELETE /api/internal/sales-orders/:id` permanently removes the unsaved order. There's no SO number yet and nothing downstream depends on it.
- **`confirmed` / `allocated` / `fulfilling`** → **Cancel** — PATCHes `status='cancelled'`. The order is **kept for history** (its SO number, lines and any lot stamping remain), it just moves to the terminal `cancelled` state and drops out of the default live grid.
- **`shipped` / `invoiced` / `closed` / `cancelled`** → no action (a dash) — these are terminal / GL-affecting and must be unwound through their own flows (e.g. a credit memo / RMA), not deleted here.

Both entry points use the app's confirm dialog (no raw browser prompt) and toast the result; the grid reloads (or the detail view closes) on success.

---

## 27.2 Confirm → draft AR invoice (M10-C)

The **🧾 Create AR invoice** button (visible on `confirmed / allocated / fulfilling / shipped` SOs) calls `POST /api/internal/sales-orders/:id/create-invoice`. It:

1. Invoices each line's **open** quantity (`qty_ordered − qty_invoiced`). M10-C invoices the full open balance in one shot.
2. Inserts an `ar_invoices` header at **`gl_status='draft'`** with `sales_order_id` set, plus `ar_invoice_lines` carrying `sales_order_line_id`, the SO's selling unit price, and (for inventory lines) `inventory_item_id`. The AR GL-account chain falls back SO → entity defaults (`default_ar_account_id` 1200, `default_revenue_account_id` 4000, `default_cogs_account_id` 5000, `default_inventory_account_id` 1300).
3. Stamps the SO lines `qty_invoiced = qty_ordered`, line status `invoiced`, and flips the header to **`invoiced`**.
4. Returns the new invoice number so the panel can deep-link.

> **Quick-ship allocation gate (operator item).** Before it creates the invoice, **Create AR invoice first auto-allocates** available on-hand to the order (the `allocate_sales_order` soft-reservation RPC). If the order **can't be filled 100%**, it does **not** invoice — it opens the **Allocations Workbench** for the order with *"Not enough inventory to quick-ship this order 100% — please review and approve the allocation."* So a quick-ship invoice is only cut for a fully-coverable order; partials route through allocation review. (The gate runs only for `confirmed`/`allocated` SOs — a `fulfilling`/`shipped` order is already past allocation and invoices directly. A credit-held customer is blocked here by the allocation credit-gate.)

> **Draft created → View / Post / Close.** On success a dialog confirms **"Draft invoice AR-NNNN created"** and offers **View invoice** (jumps to AR Invoices on that invoice), **Post now** (`POST /ar-invoices/:id/post` — books the GL immediately), or **Close** (post later from AR Invoices).

> **The draft is NOT posted (unless you click Post now).** Creating the invoice books nothing in the GL by itself. Posting is where the approval/credit-limit gates run and where **FIFO COGS is consumed** (DR AR / CR revenue + per-inventory-line DR COGS / CR inventory). See [chapter 16 §Posting](16-accounts-receivable.md#posting--approval-gate--fifo-consume). Allocation reserves stock but never draws down a FIFO layer; consumption happens once, at invoice post.

> **Deleting / voiding the invoice re-opens the SO.** If you later **delete** the draft (or **void** a posted invoice) in AR Invoices, the originating sales order is **re-opened** — its lines' `qty_invoiced` is rolled back and the header returns to **allocated** (if the soft allocations still cover it) or **confirmed**, with allocations intact. Previously the SO was stranded in `invoiced` and effectively lost. The AR Invoices delete/void prompts warn *"this will re-open SO-NNNN and restore its allocations"* first.

---

## 27.3 Factor / credit-insurance ship-gate

ROF factors many wholesale receivables (Rosenthal & Rosenthal). Each SO carries a **Factor / Ins Approval** block: `factor_approval_status` (`not_submitted` / `pending` / `approved` / `partial` / `declined` / `not_required`), `factor_reference`, and `factor_approved_cents`. The **Approved $** field is a comma-grouped money field — type a figure and it reformats to `1,234.56` (commas + two decimals) when you tab out; the commas are stripped before the value is stored as cents. These are **manual entry** today (the Rosenthal API auto-fill is reserved; the explanatory caption under the block was removed).

When the SO's customer is flagged `customers.is_factored = true`, the order **cannot ship** until factor approval is `approved`. The gate is enforced server-side in two places, so the client cue is advisory only:

- **`PATCH /sales-orders/:id`** — moving `status` to `fulfilling` or `shipped` returns **409** if the customer is factored and the effective `factor_approval_status` is not `approved`.
- **`POST /sales-orders/:id/ship`** — re-checks `is_factored` + `factor_approval_status === 'approved'` and returns **409** otherwise, before any shipment row is written.

The SO modal also shows an amber warning ("⚠ Factored customer — factor approval must be approved before this order can ship") whenever the selected customer is factored and the status isn't yet `approved`. The Allocations Workbench applies a stricter dollar-bounded version of this gate ([§27.5](#275-the-allocations-workbench-cross-so)).

---

## 27.3b Non-factor credit ship-gates (house-account & credit-card)

Factored customers are gated by **factor approval** ([§27.3](#273-factor--credit-insurance-ship-gate)). **Non-factored** customers are gated instead by a separate **credit ship-gate** carried on the SO in `credit_approval_status` (`not_required` / `pending` / `on_hold` / `approved` / `declined`) plus `credit_hold_reason`, `credit_checked_at`, `credit_approval_source`, `credit_approved_by_user_id`, `amount_paid_cents`, and `paid_in_full_at` (migration `20260901000000`). The two gates never overlap — a customer is factored **or** subject to the credit gate, never both.

The gate is evaluated server-side in `api/_lib/customers/soShipGate.js` and classified from the customer + the SO's payment term:

- **House-account gate** — customer is **not factored** and on **net/credit terms** (a `payment_terms` row with `due_days > 0`, e.g. Net 30). The gate **activates** when the customer has **any open AR invoice past its due date** — an `ar_invoices` row with `gl_status IN ('sent','partial_paid','posted','posted_historical')`, an outstanding balance (`total_amount_cents − paid_amount_cents > 0`), and `due_date < today`. This is an **overdue-AR** gate: it does **not** depend on a credit limit being set. On breach → **capture but hold**: the SO still saves, but `credit_approval_status` flips to **`on_hold`**, and it **cannot allocate or ship** until the overdue AR is cleared or an operator overrides.
- **Credit-card gate** — the SO's payment term is **`CREDIT_CARD`** (seeded for ROF, `due_days = 0`). **Payment in full must be recorded before the order can ship**: the order is held at **`pending`** until `amount_paid_cents ≥ total_cents`.

**Capture but hold, never hard-block confirmation.** On **confirm** the gate is evaluated and `credit_approval_status` is stamped (`on_hold` / `pending` / `not_required`) with a human-readable `credit_hold_reason`; the SO always saves. The hard **409** block fires only on the **allocate** and **ship/fulfilling** transitions:

- **`POST /sales-orders/:id/allocate`** — re-evaluates the gate and returns **409** (and persists the latest hold reason) before reserving any stock, unless `credit_approval_status = 'approved'`.
- **`PATCH /sales-orders/:id`** (status → `fulfilling`/`shipped`) and **`POST /sales-orders/:id/ship`** — mirror the factor 409: blocked when the gate is breached and not `approved`. A failed overdue-AR lookup returns **500** (it never silently allows a ship).

**Releasing a hold.** An operator can **override** at any time — `PATCH /sales-orders/:id` with `credit_approval_status = 'approved'` (source `manual`, recording `credit_approved_by_user_id`) clears the hold. In the SO modal this is the **✅ Override → Approve** footer button (visible while `on_hold`/`pending`); a confirm dialog shows the hold reason first.

**Recording a credit-card payment (processor deferred).** Stripe / hosted checkout is **not** wired yet. For now an operator records a manual payment via **💳 Record payment** (footer button on a `CREDIT_CARD` order) → `POST /sales-orders/:id/record-payment` with `{ amount_cents, method, reference }`. This increments `amount_paid_cents`, stamps `paid_in_full_at` when it first reaches `total_cents`, and — on a `CREDIT_CARD` order now paid in full — auto-sets `credit_approval_status = 'approved'`, `credit_approval_source = 'payment'` (auto-releasing the gate). A future hosted-payment/webhook flow can drive the **same** columns for an identical release. (This SO-level payment tracking is for the ship-gate only; it is **not** an AR receipt — the downstream AR invoice is still cleared through the AR receipts flow.)

The Sales Orders list carries a **Credit** column (column-toggle + export aware) with a colored badge — **`on hold`** amber, **`card unpaid`** blue, **`approved`** green, **`declined`** red (hover shows the hold reason). The SO modal shows a matching **Credit status** panel with the paid-of-total figure and the reason.

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

## 27.6 Wave & EDI 940 to 3PL

**Waving** is the act of sending a **Warehouse Shipping Order (WSO)** to your third-party logistics (3PL) provider so they can physically pick, pack, and ship the order from their facility. It is the first step of the 3PL fulfilment sub-flow and is separate from the standard Ship action (which records an in-house shipment).

### What happens when you click Wave

1. **TPL shipment record created.** Tangerine inserts a `tpl_shipments` header (`status = 'released'`) + one `tpl_shipment_lines` row per SO line for the selected 3PL provider.
2. **EDI 940 generated.** An X12 EDI 940 Warehouse Shipping Order is assembled with the full envelope:
   - `ISA`/`GS`/`ST` interchange + group + transaction-set headers
   - `W05` — order identification (SO number, order date)
   - `N1*ST` — ship-to party (customer + ship-to location)
   - `N1*SF` — ship-from party (your entity)
   - `W66` — carrier routing (carrier, service level)
   - `LX`/`W01` — one line per SKU with item ID + qty
   - `W76` — total units / weight summary
   - `SE`/`GE`/`IEA` — transaction / group / interchange trailers

   The raw text file is stored in `edi_messages` with `transaction_set = '940'` and linked to the `tpl_shipment_id` and the SO.

3. **Transmission.** If the 3PL provider's `edi_protocol` is set to `sftp` and the connection credentials are configured in environment variables (referenced by `edi_credential_ref`), the file is uploaded immediately and `edi_messages.status` is set to `transmitted`. Otherwise the record is left as `queued` for batch send — the system never fails silently; `transmitted = false` is returned and the message is preserved.

4. **SO stamped.** `sales_orders.waved_at` (timestamp) and `waved_tpl_provider_id` are set. The Workbench sub-header shows a **Waved** badge with the timestamp and provider name.

### Going live with EDI transmission

The Wave framework is built and generates valid 940s. To enable live SFTP delivery, your 3PL needs to provide:

| Setting | Where to configure |
|---|---|
| Protocol (`sftp` / `as2` / `van`) | `tpl_providers.edi_protocol` (edit in Inventory → 🚚 3PL) |
| Endpoint / host | `tpl_providers.edi_endpoint` |
| Username | `tpl_providers.edi_username` |
| Password or key | Environment variable named by `edi_credential_ref` (set in Vercel) |

No code change is needed — the transport layer reads these at runtime. Until credentials are set, waving queues cleanly.

### EDI 945 (inbound — not yet active)

The matching **EDI 945 Warehouse Shipping Advice** (the 3PL's confirmation that they shipped) is parsed by `parse945()` in `api/_lib/edi/builder.js`. Inbound processing (updating SO / TPL shipment status from the 945 payload) is on the roadmap but not yet wired.

---

## 27.8 Shipping (M44)

> **Table-name note:** inbound vendor/PO freight already owns `shipments` / `shipment_lines`. Outbound SO fulfilment deliberately uses **`sales_order_shipments`** / **`sales_order_shipment_lines`** to avoid the collision.

On an `allocated` or `fulfilling` SO the **🚚 Ship** button opens a modal (Carrier, Ship date, Tracking #) → `POST /sales-orders/:id/ship`. The handler:

1. Verifies status is `allocated`/`fulfilling`/`confirmed`, then enforces the **factored ship-gate** ([§27.3](#273-factor--credit-insurance-ship-gate)) — 409 if blocked.
2. Ships, per line, the **remaining allocated** qty (`qty_allocated − qty_shipped`) by default (or an explicit per-line qty if supplied), clamped so you can never ship more than is allocated.
3. Inserts the `sales_order_shipments` header (carrier / service level / tracking / ship date, status `shipped`) + `sales_order_shipment_lines`, and bumps each `sales_order_lines.qty_shipped`.
4. Flips the header to **`shipped`** when every non-cancelled line is fully shipped, else **`fulfilling`** (partial).

Shipping is a physical/logistics record only — **no GL impact, no FIFO**. COGS is still recognised later at AR-invoice post.

---

## 27.9 Day-to-day workflow

1. **Take the order.** 🛒 Sales Orders → **+ New** → pick customer (brand/channel/terms prefill) → add lines (the size-matrix body — **➕ Add style** per style, **+ Add non-matrix line** for one-offs) → optionally set Factor/Ins Approval → **Save & Confirm**. The SO gets its `SO-YYYY-NNNNN` number.
2. *(Optional)* **Split across stores** while still a draft (🏬 Ship to multiple stores) → adjust + confirm each child.
3. **Reserve stock.** Either per-SO **📦 Allocate stock**, or open **📊 Allocations** to arbitrate across competing orders — pick a fill mode, preview, apply. Factored orders only fill when approved and within the approved $.
4. **Fulfil — three paths:**
   - **In-house ship:** 🚚 Ship → enter carrier + tracking → confirm. SO → `shipped` (or `fulfilling` if partial). Blocked at 409 if the customer is factored and not approved.
   - **Wave to 3PL:** 📦 Wave → pick 3PL provider → confirm. Tangerine generates + transmits an EDI 940; the 3PL picks and ships. See [§27.6 Wave & EDI 940](#276-wave--edi-940-to-3pl).
   - **Both:** Wave first (3PL fulfils), then record the physical Ship once the 3PL confirms (or wait for the inbound EDI 945 — not yet auto-processed).
5. **Invoice.** 🧾 Create AR invoice → a **draft** AR invoice is created and the SO → `invoiced`. Then go to **AR Invoices** and **Post** it to book revenue + FIFO COGS ([chapter 16](16-accounts-receivable.md)).

> **Tip:** steps 3–5 can all be done from the **📊 Allocations Workbench** via the per-SO action buttons — no need to leave the allocation screen.

---

## 27.10 What's NOT yet usable

- **No GL posting from this module.** SOs, allocations, and shipments never touch the ledger; only the downstream AR invoice (posted in AR Invoices) does.
- **Factor approval is manual.** The Rosenthal & Rosenthal Factor API auto-fill is reserved — the fields are typed in by hand for now.
- **Allocation is unbranded.** No `inventory_partition` / brand netting yet (waits on `BRAND_SCOPE_MODE=enforce`).
- **`closed` status** is in the enum but not written by the UI.
- **Partial-quantity invoicing.** M10-C invoices the full open balance in one shot; there is no progressive ship-then-invoice-what-shipped split yet (Create AR invoice closes out all open lines).
- **No approval gate on the SO itself.** Approval/credit-limit gates live on the AR invoice at post time, not on SO confirm.
- **EDI 945 inbound not yet processed.** `parse945()` exists; the SO/TPL status update on receipt of a 3PL shipping confirmation is on the roadmap.
- **EDI live transmission needs 3PL credentials.** Wave queues a valid 940 but doesn't transmit until `edi_protocol` + credentials are configured in `tpl_providers` + Vercel env. See `OPERATOR-TODO.md`.

---

## 27.11 Code map

- **UI:** `src/tanda/InternalSalesOrders.tsx` (list + create/edit/confirm/allocate/ship/invoice/split modal), `src/tanda/SalesOrderMatrixBody.tsx` (the size-matrix line body — per-style grids + non-matrix flat lines + save-time SKU resolve), `src/tanda/InternalAllocations.tsx` (Allocations Workbench + auto-allocate preview dialog + per-SO Allocate/Ship/Invoice/Wave actions + focused-SO show-all).
- **SO handlers:** `api/_handlers/internal/sales-orders/index.js` (GET list / POST create), `.../[id].js` (GET / PATCH incl. confirm + ship-gate / DELETE), `.../create-invoice.js`, `.../allocate.js`, `.../ship.js`, `.../split.js`, `.../wave.js` (3PL wave + EDI 940).
- **Allocations handlers:** `api/_handlers/internal/allocations/index.js` (GET demand+availability — also `?so=&include_all=1` show-all-rows for a focused SO / POST `apply_allocations`), `.../allocations/preview.js` (fill-mode preview compute).
- **EDI library:** `api/_lib/edi/builder.js` (`build940()`, `parse945()`, plus existing 850/820/997), `api/_lib/edi/transport.js` (`transmitEdi()`, `providerEdiConfig()`).
- **Schema:** `supabase/migrations/20260712110000_p16_m10a_sales_orders_schema.sql` (`sales_orders` + `sales_order_lines`), `20260712120000_p16_m10c_so_invoice_link.sql`, `20260712150000_p16_so_multistore_split.sql`, `20260712200000_p16_m18_allocations.sql` (`v_inventory_available` + `allocate_sales_order()`), `20260714010000_p16_m18_allocations_workbench.sql` (`v_allocation_demand` + `apply_allocations()`), `20260712210000_p16_m44_shipments.sql` (`sales_order_shipments` + `_lines`), `20260833000000_wave_edi_940.sql` (`sales_orders.waved_at`/`waved_tpl_provider_id`, `tpl_providers.edi_*` columns, `edi_messages` extensions).

## Related docs

- [16-accounts-receivable.md](16-accounts-receivable.md) — where the draft AR invoice is posted (revenue + FIFO COGS).
- **Chapter 28 (Inventory Matrix)** — the size-scale / color×size grid primitive behind matrix SO entry.
- [11-inventory-operations.md](11-inventory-operations.md) — inventory layers feeding `v_inventory_available`.
- [19-revenue-operations.md](19-revenue-operations.md) — sales-rep commissions that accrue off the posted AR invoice.
