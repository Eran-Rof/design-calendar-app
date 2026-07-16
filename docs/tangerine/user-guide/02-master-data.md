# 2. Master data — Style, Vendor, Customer

The three master-data panels share the same skeleton: **list + search + add + edit + soft-delete**. Once you've learned one, the others read the same way. This document walks Style Master in detail, then calls out only what differs in Vendor and Customer.

## 🎨 Style Master

### What a "style" is

A **style** is the design-level identity of a garment, independent of its variants. `RY1234` is a style. `RY1234 / RED / M / 30 / REGULAR / SLIM` is a SKU (an instance of that style with the 5 matrix dimensions — see [04-concepts.md § matrix dimensions](04-concepts.md#matrix-dimensions)).

The Style Master holds **one row per style per entity**: style code, description, category, gender, season, design year, lifecycle status, planning class, base fabric, and an `is_apparel` flag that drives whether the linked SKUs must carry the full 5-dim matrix.

### List view

Columns shown: **Code, Description, Gender, Season, Year, Lifecycle, Apparel**.

- **Search** by style code or description (case-insensitive substring).
- **Show deleted** toggle — soft-deleted rows are hidden by default; toggle to see them grayed out.
- Click **Edit** on any row to change mutable fields.
- Click **Delete** to soft-delete (the row stays in the database with `deleted_at` set, so historical JEs and POs that reference it remain valid).

![Style Master list view](screenshots/02-style-master-list.png)
<!-- screenshot needed: Style Master list with several rows + search box + show-deleted toggle -->

### Add modal

Click **+ Add style** to open. Fields:

| Field | Required? | Notes |
|---|---|---|
| Style code | yes | Auto-uppercased on save. Unique per entity. |
| Description | yes | Free text |
| Gender | no | One of `M`, `WMS`, `B`, `C`, `G`, `U`. Matches the rof_xoro daily conformance set. |
| Season | no | Free text (e.g. `FW26`) |
| Design year | no | 1990–2100 |
| Lifecycle | required, defaults `active` | `active` / `phased_out` / `discontinued` / `core` |
| Planning class | no | `core` / `seasonal` / `fashion` |
| Base fabric | no | Searchable dropdown from the Fabric Codes master; shows the fabric **name only** (the code is dropped from the label but still searchable). |
| Apparel? | checkbox, defaults true | When true, linked item-master rows must carry all 5 matrix dims (CHECK enforces). |
| Generate UPCs (GS1) | checkbox, defaults off | Opt-in. When ticked, the backend mints **one unique UPC-A barcode per color/size** for the new style from the company GS1 prefix, in the background on save. See below. |

The form rejects empty style code, missing description, invalid enum values, and out-of-range design year (1990–2100) with a clear error message at the bottom of the modal.

### Generating UPCs for a new style (opt-in GS1 minting)

Existing styles keep the UPCs they already carry from Xoro / Excel — minting never touches them. For a **new** style you can have Tangerine mint barcodes automatically:

1. In the **Add style** modal, tick **Generate UPCs (GS1)**.
2. Save. The style is created immediately; minting then runs server-side and a toast reports how many UPCs were minted.

What gets minted:

- One **unique 12-digit UPC-A** per `(style, color, size)` cell, written to the UPC master with source `gs1`.
- Sizes come from the style's **size scale**; colors come from the style's existing color SKUs. A brand-new style with no colors yet mints nothing — re-tick the box later once colors exist, and only the still-missing cells are filled (it never duplicates).
- Each barcode is built from the company **GS1 prefix** plus an **atomic counter** (the same never-reused counter that mints pack GTINs) and the correct UPC check digit, so no two items ever share a number.

The checkbox is **disabled** (greyed out, with a tooltip) when no GS1 company prefix is configured — minting without one would produce invalid barcodes. Set the prefix in Company Settings first.

Minted UPCs appear in the **UPC Report** (Reports menu, 🔖 UPC Report).

![Style Master Add modal](screenshots/02-style-master-add-modal.png)
<!-- screenshot needed: the Add modal with all fields visible -->

### Edit modal

Same shape as Add, with **one difference**: `Style code` is locked. Codes are intentionally immutable — they're the human-readable identifier that historical references depend on. To change a style code, soft-delete and re-create.

The **Season** field is a searchable dropdown sourced from the Season Master (below). Pick an existing season, or — as an admin — type a new one and choose **"+ Add new season"** to add it to the master inline. The chosen season name is stored on the style as plain text, so older free-text seasons that predate the master still display correctly.

> **Frozen Save/Cancel footer.** The Style, Customer, Vendor and Fabric Code edit modals keep their **Save / Cancel** buttons pinned to the bottom of the modal as it scrolls — so on a tall record (many fields, document attachments, the audit timeline) you never have to scroll back up to save. Same behaviour as the Sales Order / Purchase Order / AR Invoice modals.

### Size scale + the 📐 Scale (pack ratio)

Next to **Size Scale** is a **📐 Scale** button. The size scale picker says *which* sizes a style runs (S–XL, 2T–4T, …); the **Scale** window says *how a buy is split across those sizes* — a reusable **pack ratio** used to auto-fill the SO and PO size matrices.

1. Pick the style's **Size Scale** first (the Scale button stays disabled until one is chosen — it needs to know the sizes).
2. Click **📐 Scale**. A window shows the sizes **laid out horizontally as columns** (the same orientation as the SO / PO size matrix), with a **Pack qty** input under each size and a running **Total** at the end of the row. Enter a representative quantity per size — only the *ratio* matters, so `S 2 · M 3 · L 3 · XL 2` and `S 20 · M 30 · L 30 · XL 20` behave identically.
3. Click **Done**, then **Save** the style. The pack is stored on the style.

**Styles with inseams** (see *Inseams* below) get a **pack matrix**: the same horizontal size columns, but **one row per inseam**, so each inseam can carry its own size curve — e.g. a 30″ inseam can skew to smaller waists and a 34″ to larger. Each inseam row has its own **Total** at the end, and a column-totals row appears at the bottom. If you'd already entered a single (flat) pack before adding inseams, each inseam row is **pre-seeded from that flat pack** when you open the window, so you adjust rather than start from zero.

**Auto-assign scales from sales history.** A **🎯 From sales history** button (on the Style Master toolbar) backfills the size scale for any **unscaled** style by reading the sizes the style has **actually sold** (from sales orders and AR invoices), most-sold first, and matching them to a scale. It only fills styles with no scale yet — it never overwrites a scale you've set — so it's safe to run any time.

### Prepack matrix (PPK styles only)

For a **prepack style** — one whose Style Number contains **PPK** (e.g. `RYB059430PPK`) — a **Prepack matrix** row appears just below **Size Scale** in the edit modal. It opens the **exact same entry window** used by the Prepack Matrices master (📦 Inventory → Prepack Matrices), so you can define the pack's per-size garment composition without leaving Style Master.

- The button reads **+ Add prepack matrix** when none exists yet, or **Edit prepack matrix** when one is already defined (the matrix code — `PPKM-…` — is shown in the note under the button).
- For a **new** matrix the popup opens **pre-filled** — the **Pack Token** (e.g. `PPK24`) and the sized-sibling **size columns** are derived from inventory automatically, so you usually just fill in the quantities. (You can still change the token or add/remove sizes.)
- Enter the number of **inner packs** per size × **Units / Inner Pack**; the **carton total** must match the pack token (e.g. `PPK24` = 24). You can also pick a **Size scale** to re-lay the columns, or add sizes by hand.
- **Save** closes only the popup — **the Style Master form stays open**, so you keep editing the style. The composition is what the Inventory Matrix **Explode PPK** toggle uses to convert packs on-hand into sized eaches on the sized sibling style.

The button appears only for PPK styles; non-prepack styles never see it.

How it's used downstream: in a Sales Order or Purchase Order size matrix, every row (color, or color × inseam) gains a **Qty** column (between the lead columns and the first size). Type one total there — e.g. `1200` — and press **Enter** or **Tab**: Tangerine splits it across the sizes in that **row's** stored proportion (the matching inseam's curve when the style has inseams), then **rounds each size up to a full carton of 24**. Because of the round-up the grand total can land a little above the number you typed — that's expected. Sizes with a zero pack ratio stay empty. If a style has no Scale set, the matrix Qty box is disabled (with a tooltip pointing back here).

### Pack / logistics (PO roll-ups)

The **Pack / logistics** row holds three per-style shipping attributes:

| Field | Meaning |
|---|---|
| **Unit weight (kg)** | Weight of one unit. |
| **Units / carton** | How many units pack into one master carton. |
| **Carton CBM (m³)** | Volume of one packed carton. |

These feed the **Purchase Order** header roll-ups (shown read-only there): total weight = units × unit weight; total cartons = units ÷ units-per-carton (rounded up); total CBM = cartons × carton CBM. All optional — a PO shows `—` for any style that hasn't set them.

#### 🤖 Estimate carton (AI CBM estimator)

You don't have to fill the carton dimensions by hand. The logistics block has an **🤖 Estimate carton** button that asks AI to size the master carton for you:

1. Set the **Product type** (defaults from the style's category, picked from your category list), the **Fold type** (one of the five standard apparel folds — flat-fold, roll, bagged, hanging, etc.), the **Unit weight (lb)** (this stays in sync with the kg field above), and **Units / carton** (reused from the row above).
2. Click **🤖 Estimate carton**. AI returns the **carton length × width × height (in)**, the **carton CBM (m³)**, the **gross weight (lb)**, a **confidence** level, and a short note. The confidence is colour-coded so a low/medium result (e.g. a hanging pack) is flagged for you to double-check.
3. The result is a **suggestion** — review it and **Save** the style to keep it. The estimate is cached on the inputs, so it only re-runs when you change product type, fold, units/carton, or unit weight.

**Manual override wins.** If you edit any carton dimension by hand, or tick **Measured carton**, Tangerine marks the carton as operator-set and recomputes the CBM from your measurements (L × W × H ÷ 61023.6). The 🤖 button **will not overwrite** a measured/overridden carton — clear the override first if you want a fresh AI estimate. Either way, the single **Carton CBM (m³)** is what feeds the PO roll-ups above.

> The 🤖 button needs the AI key configured on the deployment; without it the button is inert.

### Colors (which colors the style runs)

The **Colors** section declares the colors a style is offered in. Each color you add appears with its **swatch + name (+ code)** and a **✕** to remove it. Use the **"Search colors to add…"** dropdown to attach an existing color from the **Color Master** (see below) — type to filter the full color list.

A **Show / Hide toggle** (with the color count beside it) lets you collapse the list — handy on a style carrying many colors so the modal stays compact. When shown, colors are **sorted alphabetically by name** and flow top-to-bottom into auto-fit columns, so a long list is easy to scan.

These declared colors become the **color rows in the Sales Order and Purchase Order size matrix** — including a brand-new style that has no SKUs yet, and the AI **"Upload customer PO"** prefill on a new Sales Order. (Previously a style's colors were inferred only from SKUs that already existed, so a new style had no rows to fill.)

- **Anyone** can pick existing colors.
- **Admins** also get a **"+ Add new color … to master"** row at the bottom of the dropdown — type a colour that isn't in the master yet and choose it to create the color and attach it in one step. Non-admins only see existing colors. (Adding a colour that already exists, case-insensitively, just re-uses the existing one.)

### Inseams (bottoms only — optional)

Below Colors, the **Inseams** section declares the inseam lengths a bottoms style runs (e.g. `30`, `32`, `34`). Type one and press **Enter** or **+ Add inseam**, or tap a **quick-add** preset. Each inseam becomes an extra matrix dimension on SO / PO entry (color × inseam × size). Leave it empty for tops and non-bottoms.

For an **existing** bottoms style, Tangerine **auto-fills the inseams it already sells** (read from the style's SKUs — the same inseams the Inventory Matrix shows) when you open the style, so you don't have to re-type them; they're saved on the style the next time you **Save**. You can still add or remove inseams by hand. Declaring inseams also turns the **📐 Scale** window into a per-inseam **pack matrix** (above).

### Customer style numbers (one base style, many customers)

Private-label / customer-customized goods are **one base style sold to many customers**, each using *their own* style number. Recording those here keeps it as a **single** style record instead of forking a new style per customer (which is how a catalog ends up with thousands of near-duplicate style lines).

In the Style edit modal, the **Customer style numbers** section maps `customer → their style number` (plus optional notes). Click **+ Add customer #**, pick the customer (searchable), type their number, **Add**. A customer PO that cites their own number then resolves back to this base style — feeding the AI **Upload customer PO** flow and the manufacturing module. Stored in `style_customer_numbers` (one row per customer per style); managed in place, independent of the main Save.

### Renumbering a style + aliases (#1453)

You can now **edit the Style Number on an existing style** (e.g. drop a legacy Xoro inseam baked into the code — `RYB147730` → `RYB1477PPK` — and move the inseam to the **Inseams** field). The **Style Number** field is editable in the edit modal; change it and a note confirms the renumber.

**Your history stays wired** — this is safe because all transactional history is keyed by the row's internal id, not the text code: inventory layers (on-hand/FIFO), purchase-order lines, sales-order lines, and wholesale sales history all stay attached automatically. On save, Tangerine:

1. **Captures the old code as an alias** (shown in the **Aliases (old style codes)** field). Aliases keep *string-grain* lookups resolving the renamed style — the **Xoro order importer** and the **Prepack Matrix** both match through them, so an order or matrix that still carries the legacy code lands on the right (renamed) style.
2. **Cascades the new code to the catalog** — updates the style code on the style's SKUs (`ip_item_master`) but **keeps each SKU code unchanged**, so anything keyed by SKU (costing, ATS, Xoro item numbers) keeps matching with zero disruption.
3. **Re-keys the prepack matrix** to the new code.

You can also **add or remove aliases by hand** in that field (e.g. to fold in a second legacy code). Old codes are stored uppercase in `style_master.aliases`, mirroring the alias mechanism already used for Vendors and Customers.

## 🎨 Color Master

Find it under **Master Data → Color Master** (`/tangerine?m=color_master`). The Color Master is the curated list of colors styles can be offered in. It is **prepopulated from every distinct colour already present in the catalog** (the existing item/SKU colours), so the picker starts full of your real colours — then **normalized** to a clean canonical set (1,106 raw spellings → 857: case, spacing, size-leaked-into-colour, and common abbreviations like `Lt`/`Dk`/`Hthr`/`Chrcl` are folded into one proper-cased name). The matching cleanup of the live SKU colours themselves is a separate, larger data-repair (tracked in OPERATOR-TODO); meanwhile the size matrix lines a declared colour up with existing SKU colours case-insensitively. Standard panel features apply: search, **Show inactive**, `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit. Each row shows a colour **swatch** square — derived from the colour name (CSS named colours + an apparel/denim/camo palette) or the stored hex.

**Two-tone colourways.** Name a colour `A/B` — e.g. `Grey/Black` — and the swatch renders a **diagonal half-and-half split** (left half Grey, right half Black), each half resolved from its name. This works in the Color Master grid, the add/edit preview, and the Style Master colour chips. No special data entry — just the `/` in the name.

For full control over a two-tone swatch you can also **compose it explicitly**. The add/edit modal's hex picker is labelled **Color A**, and a second clearable **Color B** picker sits beside it. Set both and the swatch renders that exact half-and-half split (Color A left, Color B right) — this **takes precedence** over the name-based split, so you can match a real fabric exactly even when the name doesn't read `A/B`. Leave Color B blank for a single colour. A live preview swatch next to the **Name** field shows what you'll get as you type. When the **NRF** match runs (below) on a two-tone colour, it uses **Color A only** (the first `/`-token of the name and the Color A hex).

**NRF color code (AI-matched).** Each colour also carries the **NRF code** — the National Retail Federation standard 3-digit colour-family code (e.g. `001` White, `110` Black, `220` Brown, `600` Blue, `700` Green, `900` Grey, `970` Multi) plus its standard family name. It shows in the **NRF** grid column and the xlsx export. You populate it three ways, all AI-assisted (Claude):

- **Auto-match all existing** — the header **🎨 Auto-match NRF (AI)** button assigns an NRF code to *every* colour that doesn't have one yet, in the background (it batches and loops; a colour that already has a code is left alone). Run it once after import; re-run any time after adding colours.
- **Per colour on add/edit** — the colour modal has an **NRF code** field (code + family name) with a **🤖 Suggest** button. Whenever you add a colour or change its name/swatch, click **🤖 Suggest** to have AI fill the matching NRF code from the name (and hex, if set). You can always type/override the code by hand.
- **By hand** — both the code and family-name fields are free-text, so you can correct any AI match.

### What a color row is

| Field | Meaning |
|---|---|
| **Name** | The colour label that appears as a matrix row, e.g. `Black`, `Charcoal Hthr`. Required; unique per entity (case-insensitive). |
| **Code** | An optional short colour code. |
| **Color A (Hex)** | An optional `#RRGGBB` swatch shown next to the colour chip. The primary/left colour. |
| **Color B (Hex)** | An optional second `#RRGGBB` for an explicit two-tone swatch (right half). Clearable; leave blank for a solid colour. |
| **NRF code** | The NRF standard 3-digit colour-family code (e.g. `110`), optional. AI-matched via 🎨 Auto-match / 🤖 Suggest, or hand-entered. |
| **NRF name** | The NRF standard family name for that code (e.g. `Black`), optional. |

### How it relates to Style Master

Style Master stores a style's chosen colours as a list of color-master ids in the style's attributes — there is no foreign-key column on the style, so this master is purely additive and backward-compatible. Renaming a colour in the master updates it everywhere it's used. **Only admins** can add a new colour to the master (inline from the Style Master Colors picker).

## 🍂 Season Master

Find it under **Master Data → Seasons** (`/tangerine?m=season_master`). A season is a named merchandising window — `FW26`, `SS27`, `HOLIDAY26` — that styles are tagged with.

### What a season row is

| Field | Notes |
|-------|-------|
| **Code** | Server-generated, read-only (`SEASON-00001`, `SEASON-00002`, …). Allocated on save; you never type it. |
| **Name** | The label that appears on styles and in the Season dropdown, e.g. `FW26`. Required. |
| **From / To** | An optional date range for the season window. Purely **informational** — used for reporting and AI context only. It does **not** drive any filtering, sorting, or other logic; leaving either blank is fine. |
| **Sort order** | Controls list ordering (ascending); ties break by code. |
| **Active** | Inactive seasons drop out of the Style Master picker but stay in the table (toggle **Show inactive** to see them). |

### How it relates to Style Master

The master simply **curates the picklist**. `style_master.season` remains a free-text column storing the chosen season **name** — there is no foreign key. This keeps the change backward-compatible: existing styles keep their season text whether or not it's in the master, and the dropdown surfaces the style's current season even if it was later deactivated or never added.

### Delete protection

Deleting a season is a hard delete, but it is **rejected (409)** if any style is still tagged with that season name — reassign those styles first, or just toggle **Active** off to retire it without losing history. Standard panel features apply: server-side search, `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## ↩️ RMA Reasons

Find it under **Master Data → RMA Reasons** (`/tangerine?m=rma_reason_master`). An RMA reason is a standard customer-return cause — `Defective`, `Wrong Item`, `Damaged in Transit`, `Customer Remorse` — that a return (and each of its lines) can be tagged with.

### What an RMA reason row is

| Field | Meaning |
|---|---|
| **Code** | Server-generated, read-only `RMAR-NNNNN`. Allocated on save; you never type it. |
| **Name** | The label that appears in the Returns / RMA reason dropdowns, e.g. `Defective`. Required. |
| **Sort order** | Optional integer that orders the picker (low to high), then code as a tie-breaker. |
| **Active** | Inactive reasons drop out of the Returns picker but stay in the table (toggle **Show inactive** to see them). |

### How it relates to Returns / RMA

The master simply **curates the picklist** used by the **Returns / RMA** panel (Sales → ↩️ Returns). Both `sales_returns.reason` (the header reason) and `sales_return_lines.reason` (the per-line reason) remain free-text columns storing the chosen reason **name** — there is no foreign key. This keeps the change backward-compatible: existing returns keep their reason text whether or not it's in the master, and the dropdown surfaces the return's current reason even if it was later deactivated or never added. As an admin you can type a brand-new reason and choose **"+ Add new reason"** to add it to the master inline without leaving the form.

### Delete protection

Deleting an RMA reason is a hard delete, but it is **rejected (409)** if any return **or** return line is still tagged with that reason name — reassign those returns first, or just toggle **Active** off to retire it without losing history. Standard panel features apply: server-side search, `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## ⚙️ Adjustment Types

Find it under **Master Data → Adjustment Types** (`/tangerine?m=adjustment_type_master`). An adjustment type is a **category / reason** an inventory adjustment can be tagged with — `Shrinkage`, `Damage`, `Found`, `Correction`, `Write-off`, `Return to Vendor`, `Cycle Count`. It replaces the old fixed list that used to be hard-coded into the Inventory Adjustments panel, so you can now add, rename, retire, and reorder the types yourself.

### What an adjustment type row is

| Field | Meaning |
|---|---|
| **Code** | Server-generated, read-only `ADJT-NNNNN`. Allocated on save; you never type it. |
| **Name** | The label that appears in the Inventory Adjustments type picker, e.g. `Shrinkage`. Required. |
| **Description** | Optional free-text note describing when to use this type. Shows in the add/edit modal only; leave blank if not needed. |
| **Sort order** | Optional integer that orders the picker (low to high), then code as a tie-breaker. |
| **Active** | Inactive types drop out of the adjustments picker but stay in the table (toggle **Show inactive** to see them). |

### How it relates to Inventory Adjustments — and what it does NOT do

The master simply **curates the picklist** used by the **Inventory Adjustments** panel (Inventory → Adjustments). `inventory_adjustments.adjustment_type` remains a free-text column storing the chosen type **name** — there is no foreign key. This keeps the change backward-compatible: existing adjustments keep their type text whether or not it's in the master.

> **Important:** the adjustment type is **informational only — a category for grouping and reporting.** It does **not** drive the increase/decrease FIFO accounting. Whether an adjustment *adds* a FIFO layer or *consumes* one is decided purely by the **sign of the quantity** (positive = increase, negative = decrease) and, for increases, the **unit cost** — never by the type you pick.

### Delete protection

Deleting an adjustment type is a hard delete, but it is **rejected (409)** if any inventory adjustment is still tagged with that type name — reassign those adjustments first, or just toggle **Active** off to retire it without losing history. Standard panel features apply: server-side search, `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## 🔁 Transfer Reasons

Find it under **Master Data → Transfer Reasons** (`/tangerine?m=transfer_reason_master`). A transfer reason is a **category / reason** an inventory transfer (location-to-location move) can be tagged with — e.g. `Replenishment`, `Rebalance`, `Damage Move`, `Return to Warehouse`, `Cycle-Count Correction`. The Inventory Transfers panel sources its reason picker from here, and a reason is **required** on every transfer.

### What a transfer reason row is

| Field | Meaning |
|---|---|
| **Code** | Server-generated, read-only `XFRR-NNNNN`. Allocated on save; you never type it. |
| **Name** | The label that appears in the Inventory Transfers reason picker, e.g. `Replenishment`. Required. |
| **Sort order** | Optional integer that orders the picker (low to high), then code as a tie-breaker. |
| **Active** | Inactive reasons drop out of the transfer picker but stay in the table (toggle **Show inactive** to see them). |

### How it relates to Inventory Transfers — and what it does NOT do

The master simply **curates the picklist** used by the **Inventory Transfers** panel (Inventory → Transfers). The chosen reason **name** is captured in the transfer's free-text `notes` — there is no foreign key, so the change is backward-compatible. The reason is **informational only — a category for grouping and reporting.** It does **not** drive any accounting.

You can also **add a new reason inline** from either transfer entry modal: type a name into the reason picker and choose **"Add new"** — it is created in this master immediately and selected.

### Delete protection

Deleting a transfer reason is a hard delete, but it is **rejected (409)** if any inventory transfer still references that reason name — reassign those transfers first, or just toggle **Active** off to retire it without losing history. Standard panel features apply: server-side search, `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## 🏬 Warehouse Master

Find it under **Master Data → Warehouses** (`/tangerine?m=warehouse_master`). A warehouse is an operator-owned stock location — e.g. `Main Warehouse`. This panel curates those locations so inventory transfers, adjustments, and FIFO layers all point at a consistent list.

Under the hood this builds **over the existing `inventory_locations` table** (the same table that backs multi-location inventory and the marketplace/3PL locations). The panel only shows and edits rows of `kind = 'warehouse'`; marketplace-held stock (`fba`, `wfs`) and `3pl` / `dropship` / `virtual` locations are managed by their own channel integrations and never appear here.

### What a warehouse row is

| Field | Meaning |
|---|---|
| **Code** | Server-generated, read-only `WH-NNNNN`. Allocated on save; you never type it. (Older seed locations such as `MAIN_WH` keep their original code.) |
| **Name** | The label that appears in location pickers, e.g. `Main Warehouse`. Required. |
| **Address** | Optional free-text street address for the warehouse. |
| **Country code** | Optional country, e.g. `US`. |
| **Sort order** | Optional integer that orders the picker (low to high), then code as a tie-breaker. |
| **Active** | Inactive warehouses drop out of pickers but stay in the table (toggle **Show inactive** to see them). |

### Delete protection

Deleting a warehouse is a hard delete, but it is **rejected (409)** if any inventory layer still points at it (FK) **or** any inventory transfer references its code as a from/to location — move that stock first, or just toggle **Active** off to retire it without losing history. Standard panel features apply: server-side search (code, name, or address), `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## 🏭 Fabric Mill Master

Find it under **Master Data → Fabric Mills** (`/tangerine?m=fabric_mill_master`). A fabric mill is a manufacturer or supplier of raw fabric. Operators use this panel to track which mills they source fabric from — name, country, contact, website, and notes.

### What a fabric mill row is

| Field | Meaning |
|---|---|
| **Code** | Server-generated, read-only `MILL-NNNNN`. Allocated on save; you never type it. |
| **Name** | The mill's display name, e.g. `Hengfeng Textile`. Required. |
| **Country** | Optional — a **searchable dropdown** sourced from the Countries master (stored as the ISO-2 code, e.g. `CN`, `TW`, `IN`; shows the country name). A legacy free-text value that isn't an ISO-2 code is preserved as a one-off option until you re-pick. |
| **Contact name** | Optional name of the **primary** contact at the mill. |
| **Contact email** | Optional primary-contact email address. |
| **Contacts** | Optional list of **up to 5 additional contacts** (name · email · phone · title each), edited inline below the primary contact fields. Use **+ Add** to add a row, ✕ to remove. |
| **Website** | Optional URL (renders as a clickable link in the list). |
| **Notes** | Any additional free-text notes about the mill. |
| **Sort order** | Optional integer ordering (low to high), then code as a tie-breaker. |
| **Active** | Inactive mills drop out of pickers but stay in the table (toggle **Show inactive** to see them). |

### Delete behaviour

Deleting a fabric mill is a hard delete with no reference check (no FK from styles or fabric codes points here yet). Toggle **Active** off to retire a mill without losing history. Standard panel features apply: server-side search (code, name, or country), `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## 🚚 Carrier Master

Find it under **Master Data → Carriers** (`/tangerine?m=carrier_master`). The Carrier Master stores the shipping carriers your business uses (parcel, LTL, ocean freight, air, etc.). It is **pre-populated with 16 common carriers** (UPS, FedEx, USPS, DHL, OnTrac, ABF, Maersk, etc.) on first migration — deactivate carriers you don't use and add any that are missing.

The carrier list drives the **🚚 Ship** modal on Sales Orders — instead of typing a carrier name free-hand, operators pick from a searchable dropdown. The code (e.g. `UPS`) is stored on the shipment record.

### What a carrier row is

| Field | Meaning |
|---|---|
| **Code** | **Auto-generated, read-only** `CARR-NNNNN` — allocated on save; you never type it. The 16 pre-seeded carriers keep their original meaningful codes (`ABF`, `AMAZON`, `DHL`, `FEDEX`, …); only newly added carriers receive a `CARR-NNNNN` code. The code is immutable once set. |
| **Name** | The carrier's display name, e.g. `United Parcel Service`. Required. |
| **Type** | `parcel`, `ltl`, `ocean`, `air`, or `other`. Used for filtering. |
| **Tracking URL template** | Optional URL with `{tracking}` placeholder, e.g. `https://www.ups.com/track?tracknum={tracking}`. Not yet used for auto-link rendering — reserved for future use. |
| **Sort order** | Optional integer ordering (low to high), then code as tie-breaker. Controls picker order in the Ship modal. |
| **Active** | Inactive carriers drop out of the Ship modal picker but stay in the table. Toggle **Show inactive** to see them. |

### Delete behaviour

Hard-delete only. Historical shipments are unaffected because carrier is stored as plain text in shipment records (no FK). Toggle **Active** off to retire a carrier without losing history. Standard panel features apply: server-side search (code or name), `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## 🛒 Buyer Scope Master

Find it under **Master Data → Buyer Scope Master** (`/tangerine?m=buyer_scope_master`). A **scope** describes *what a customer buyer purchases* — e.g. Men's Tops, Men's Bottoms, Women's, Denim, Accessories, Footwear. Scopes are **multi-selected on a buyer** in **Customer Master → Buyers**, so you can see at a glance which buyer owns which categories.

The table is **seeded with 6 sensible apparel scopes** on first migration; add, rename, or deactivate them freely.

### What a scope row is

| Field | Meaning |
|---|---|
| **Name** | The scope label, e.g. `Men's Tops`. Required and editable. |
| **Code** | **Auto-generated** as `SCOPE-NNNNN` on save — read-only, never operator-entered or editable (an internal key only; the buyer↔scope link uses the row id, not the code). |
| **Sort order** | Optional integer ordering (low to high), then name as tie-breaker. |
| **Active** | Inactive scopes drop out of the buyer scope picker but stay assigned where already chosen. Toggle **Show inactive** to see them. |

### Delete protection

Deleting a scope is **blocked** if any buyer is currently assigned it (you'll get a clear message with the count). Deactivate it instead to retire it from the picker while keeping existing assignments. Standard panel features apply: server-side search (name or code), `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit. The **Code** column is auto-generated and shown read-only.

## 🧩 Part Master

Find it under **Master Data → Part Master** (`/tangerine?m=part_master`). A **part** is a purchased *component* that gets assembled into a finished style — a blank garment, a label, a trim, packaging, or fabric. Parts power the **Manufacturing module** (see [44-manufacturing.md](44-manufacturing.md)): you buy them, hold them in their own inventory, and consume them when you build a finished style.

> **Parts are kept fully separate from style inventory.** A part never appears in the Inventory Matrix, ATS, or sales/PO style pickers. It lives in its own master here and (once Manufacturing inventory ships) its own FIFO stock pool. There is intentionally no link from a part to a style SKU.

### What a part row is

| Field | Meaning |
|---|---|
| **Code** | **Auto-generated** as `PART-NNNNN` on save — read-only. |
| **Name** | The part label, e.g. `Blank Tee 5000 White`. Required. |
| **Part type** | Picked from the **Part Type Master** (below) via a searchable dropdown. Seeded with Blank garment / Label / Trim / Packaging / Fabric / Generic; add your own (zipper, thread, …). Drives reporting. |
| **Unit of measure** | How the part is counted/purchased (defaults to `each`). |
| **Default vendor** | The vendor you usually buy this part from (type-ahead picker). Optional. |
| **Default unit cost** | Informational seed (in dollars) for purchasing. Optional. |
| **Size-scaled** | Tick for parts tracked per size, e.g. blank tees. |
| **Fabric code** | Only shown when part type is `Fabric` — links to the existing Fabric Codes master. |
| **Active** | Inactive parts drop out of pickers but stay on historical builds. |

Standard panel features apply: server-side search (code or name), `<ExportButton>` (xlsx), and row-click-to-edit. Delete is a hard delete (deactivate to retire instead).

## 🏷️ Part Type Master

Find it under **Master Data → Part Type Master** (`/tangerine?m=part_type_master`). This is the operator-managed list of **part categories** that the Part Master "type" dropdown picks from — so you can add a new type (e.g. `Zipper`, `Thread`, `Hangtag`) without a code change. Seeded with the six originals (Blank garment, Label, Trim, Packaging, Fabric, Generic).

Each row has a **Code** (a short lowercase key stored on the part; operator-entered and locked after creation), a **Name** (the display label), a sort order, and an active flag. **Delete is blocked** if any part still uses the type — deactivate it instead. Standard search / xlsx export / row-click-to-edit apply.

## 🛠️ Service Item Master

Find it under **Master Data → Service Item Master** (`/tangerine?m=service_item_master`). A **service item** is an outsourced *conversion / labor* charge performed by a factory — printing, sewing, packing, washing. In the CMT (cut-make-trim) model a service is a **vendor AP charge**, not a stocked quantity and not an internal labor rate.

### What a service row is

| Field | Meaning |
|---|---|
| **Code** | **Auto-generated** as `SVC-NNNNN` on save — read-only. |
| **Name** | The service label, e.g. `Screen print front + back`. Required. |
| **Service kind** | `Print`, `Sew`, `Pack`, `Wash`, `Conversion`, or `Other`. |
| **Labor** | Reporting flag — marks the charge as labor (it is still billed by a vendor). |
| **Default vendor** | The factory/sub-contractor that performs the service. Optional. |
| **Default charge** | Informational per-unit cost (in dollars) to seed the conversion PO. Optional. |
| **Capitalize to WIP** | When on (default), the service's cost is **rolled into the finished good's value** through Work-In-Process. When off, it expenses to the chosen account. |
| **Expense account** | Shown only when *Capitalize to WIP* is off — the GL account the charge hits instead. |
| **Active** | Inactive services drop out of pickers but stay on historical builds. |

Standard panel features apply: server-side search, xlsx export, and row-click-to-edit.

## 🏭 Vendor Master

### What differs from Style Master

| Aspect | Vendor Master |
|---|---|
| **List columns** | Code, Name (with `legal_name` underneath if different), Country, Status, 1099?, Payment Terms |
| **Search matches** | name OR code OR legal_name (ilike) |
| **Soft-delete toggle** | "Show inactive" — vendor deactivation sets `status='inactive'` AND `deleted_at` (so the row both falls out of `status=active` filters AND becomes excluded by `deleted_at IS NOT NULL` queries). |
| **Status** | active / on_hold / inactive |
| **PII fields** | `tax_id` and `bank_account_encrypted` are **never** shown in the UI. The Add modal has no field for them. A small "Tax ID and banking handled via dedicated PII workflow" note appears in the modal. |
| **Default GL accounts** | `default_gl_ap_account_id` and `default_gl_expense_account_id` are visible in the Edit modal but only after your Chart of Accounts is seeded. Without accounts, the dropdowns are empty. |

![Vendor Master list view](screenshots/02-vendor-master-list.png)
<!-- screenshot needed: Vendor Master list with several rows -->

### Country, picker labels & phone dial code

- **Country** is a **searchable dropdown** sourced from the Countries master — it stores the ISO-2 code and **shows the country name only**. Legacy free-text country values are preserved (shown as a one-off option) until you re-pick.
- **Payment-terms and GL-account pickers show the name only.** The code is dropped from the label to keep the dropdown clean, but it's still part of the search text — so you can type the code to find the row.
- **Phone has a dial-code dropdown + a national-number box.** Pick the country calling code (`+1`, `+86`, `+880`, …) from the dropdown, then type the national number. For dial code **1** (US/Canada) the number masks to **(NNN) NNN-NNNN**; for every other country it's stored as **E.164** (`+<code><digits>`) with a live hint showing the composed number. The editor re-splits the dial code and national number when you re-open a vendor, so it round-trips cleanly.

### PII handling

The schema stores `tax_id` (EIN/VAT) and `bank_account_encrypted` (AES-256 ciphertext) on the `vendors` row, but the admin handler explicitly excludes them from every SELECT. The Add and PATCH endpoints reject any attempt to set them.

When you need to capture a vendor's tax ID or bank account, that flows through a separate (planned) PII-aware endpoint — never the admin UI. This matches the CLAUDE.md security mandate "never log PII, never return in API responses."

### Supporting documents (M29 / P2-6)

The Vendor Edit modal renders the reusable `<DocumentAttachmentList>` widget below the form fields. Seeded document kinds: `contract`, `w9`, `coa`, `insurance`, `other`. Upload a file, the system stores it in the `tangerine-documents` Supabase Storage bucket and renders a row with kind + filename + uploader + timestamp; click Download for a short-lived signed URL, or Archive to soft-delete (the row stays for audit but disappears from the default list).

For the widget to work, an operator with admin access to Supabase must have created the `tangerine-documents` bucket once. See [09-documents.md](09-documents.md) for the full workflow + setup.

## 🤝 Customer Master

### What differs from Style Master

| Aspect | Customer Master |
|---|---|
| **List columns** | Code, Name, Customer type, Country, Status, Credit limit, Payment terms |
| **Search matches** | name OR code OR customer_code (ilike) |
| **Customer type filter** | Dropdown above the table: all / wholesale / ecom / showroom / employee / other |
| **Status** | active / on_hold / inactive (parallels Vendor) |
| **`customer_type`** | New ERP field (Chunk 6). Drives default revenue-account selection and reporting buckets. Backfilled from your existing `channel_id` heuristic: wholesale channel → `wholesale`; ecom channel → `ecom`; retail → `showroom`; everything else → `wholesale`. |
| **Legacy `customer_tier`** | Still present in the DB (text). The new `customer_type` is the authoritative field for ERP behavior. |
| **PII** | `tax_exempt_certificate` text is never shown in the list; only in the Edit modal it appears as a placeholder note "handled via dedicated PII workflow." |
| **Credit limit** | Numeric (14,2). When set, the AR module (planned) will block new orders past this limit. For now it's metadata. |

![Customer Master list view](screenshots/02-customer-master-list.png)
<!-- screenshot needed: Customer Master list with type filter visible -->

### How sales imports find (or create) customers — de-duplication (#1824)

Customers are also created **automatically** by the sales-history importers — the nightly Excel invoice feed (`/api/sales/sync-invoices`), the Xoro invoice sync (`/api/xoro-sales-sync`), and the planning SO ingest (`planning-sync`). Historically these matched an incoming customer to an existing one only by exact code (`EXCEL:` / `XORO:` / `ATS:`) or a case- and punctuation-sensitive name, so any drift forked a **duplicate**: `AMAZON FBM` beside `Amazon FBM`, `US Apparel` beside `U.S. Apparel`, `Vet Inc` beside `Vet Inc.`.

The importers now run a **normalized-name guard** (`api/_lib/customers/matchCustomer.js`) before creating anyone: they load the **live** customers (soft-deleted rows excluded, so a merged-away duplicate is never resurrected) and match an incoming customer in order of **bare code key → exact name → normalized name** (uppercase with **all** whitespace *and* punctuation stripped). On a match the sale attaches to the existing customer; only a genuinely new name creates a row. The response counts these as `duplicates_prevented`.

> This is a code-level guard rather than a database unique index because a few pre-existing two-code duplicate pairs still need a manual FK-repoint merge (the #1816 tooling). Once those are merged, a partial unique index on the normalized name (per entity, `deleted_at IS NULL`) can be added as a hard safety net.

### Supporting documents (M29 / P2-6)

The Customer Edit modal renders the same `<DocumentAttachmentList>` widget as Vendor Master. Seeded document kinds: `contract`, `tax_exempt`, `credit_app`, `other`. The widget appears below the form fields once the customer is in `mode='edit'`. Use it to attach signed contracts, tax-exempt certificates, credit applications — see [09-documents.md](09-documents.md).

### Country default + tax-exempt default + Buyers tab

- **Country** is a **searchable dropdown** sourced from `country_master` (stored as the ISO-2 code, e.g. `US`). **New customers default to United States**; existing customers with a blank country were backfilled to `US`.
- **Tax-exempt** defaults to **checked (yes)** for new customers, and every existing customer was set tax-exempt on this release (operator request). Uncheck per customer as needed.
- A **Buyers** tab (which replaces the old Contacts tab) lists the people at this customer who place orders. See **Buyers tab** below.

### Buyers tab

The **Buyers** tab on the Customer Edit modal **replaces the legacy Contacts tab** and is richer than a plain contact list. Each buyer is a first-class record (table `customer_buyers`) and **saves immediately, per row** — there is no separate "Save" at the bottom for buyers, so a manager buyer always exists before another buyer can report to them.

> Buyers can only be added/edited on a **saved** customer (the system needs the customer's id). On the *Add customer* flow, save the customer first, then re-open it to add buyers. Any contacts you had previously entered in the old Contacts tab were migrated into Buyers automatically (the original `customers.contacts` jsonb is retained as a backup).

| Field | Required? | Meaning |
|---|---|---|
| **Name** | ✅ | The buyer's name. |
| **Phone** | ✅ | Auto-formatted to **(xxx) xxx-xxxx** as you type. |
| **Email** | ✅ | Validated as an email address. |
| **Title** | ✅ | The buyer's job title, e.g. `Senior Buyer`. |
| **Manager** | — | A checkbox beside Title. Tick it to mark a **management buyer** — only managers can be chosen as a "Report" target for other buyers. |
| **Scope** | — | Multi-select of what the buyer purchases (chips/checkboxes sourced from **Buyer Scope Master**). Pick zero or more. |
| **Report** | — | Who this buyer reports to. The dropdown lists **only management buyers on the same customer**, and never the buyer themselves. |

To remove a buyer, click **Delete** on its card. Any other buyer that reported to it, and any sales order that recorded it, simply loses the link (no cascade delete of those rows). You cannot clear a buyer's **Manager** flag while other buyers still report to them — reassign their Report first.

## Address, contacts, country/state & phone — shared behaviours

These apply to the **Customer**, **Vendor**, and **Factor** masters (and customer ship-to locations), via the shared `AddressFields` / `ContactList` / phone-mask primitives:

- **Country + State dropdowns.** Every structured address (billing / shipping / vendor / factor / location) now edits **Country** and **State / province** as **searchable dropdowns** — Country from `country_master`, State from the new `state_master` (all US states + DC + territories, and Canadian provinces), filtered to the chosen country. A country with no seeded states (e.g. China) falls back to a free-text State box. Legacy free-text values are preserved (shown as a one-off option) until you re-pick.
- **Click-to-email.** Email fields show a **✉ mailto** affordance (and email cells in lists are clickable) so you can start an email in one click. Inert until the address is valid.
- **AI postal-code fill (🤖).** The postal / ZIP field carries a **🤖** button. Fill in the rest of the address (line 1, city, state, country) and click it — AI suggests the postal code from that address (US ZIP or ZIP+4 when the street makes it determinable, else a 5-digit ZIP; standard postal for other countries). It's a **suggestion you confirm** — review and edit before saving. Works on customer billing **and** shipping, customer ship-to locations, and vendor addresses (they all share the same editor).
- **US phone mask.** Phone inputs auto-format to **(XXX) XXX-XXXX** as you type — everywhere **except the Vendor master** (vendors are often overseas, so their phone stays free-form). A value beginning with `+` is treated as international and left as typed.

## 📅 Date Presets Master

**Master Data → Date Presets.** Date-range filters across the suite (reports, lists, dashboards) offer a **Presets** picker with built-in quick ranges — MTD, YTD, Last 30 / 60 / 90 days, This / Last month, This / Last quarter, This / Last year, "This year → last month", and more. This panel lets you manage those and add **your own** on top.

The built-in presets are **pre-loaded here as editable rows** (each one shown once), so you can **relabel, reorder, or disable** any of them — or add brand-new ones — and the change flows straight through to every picker.

Each preset is a **relative rule**, not a fixed date range — it recomputes every time you use it, so "Last 14 days" always means the 14 days ending today. (None of these presets ever stores a fixed start/end date.)

- **Add a preset:** click **+ Add preset**, give it a **Label** (what shows in the picker, e.g. "Last 14 days"), choose a **Kind**, and — for the "Last N days" / "Last N months" kinds — enter **N**. The modal shows the **range as of today** so you can confirm it.
- **Kinds:** Today, Yesterday, Last N days, Last N months, Month-to-date, Year-to-date, This/Last month, This/Last quarter, This/Last year, and "This year → last month".
- **Sort order** controls where your preset appears in the picker; **Active** hides it without deleting.
- Your presets appear automatically in **every** date-range filter across all apps — no per-screen setup.

## Common patterns

These hold for all three master panels:

- **Soft-deletes preserve history.** Deleting (or inactivating) a master record never removes the row. Foreign keys from `journal_entries`, `tanda_pos`, `invoices` etc. stay valid.
- **Codes are case-insensitive and uppercased on save.** `ry1234` and `RY1234` produce the same record. Internally everything is stored upper-case.
- **Search is server-side ilike.** The query string `pant` matches `pants`, `PANTHER`, `expant`. Whitespace-trim happens before the query.
- **API error toasts.** Errors return JSON `{ error: "human message" }` and appear in the modal's error banner. 409 (conflict) usually means a uniqueness violation; 400 means a validation failure; 500 means the server hit an unexpected problem.

## Going further

- Concept explanations behind these panels: [04-concepts.md](04-concepts.md)
- A vendor-onboarding workflow that uses Vendor Master end-to-end: [05-workflows.md § new vendor onboarding](05-workflows.md#new-vendor-onboarding)
- When delete/edit fails: [06-troubleshooting.md](06-troubleshooting.md)
