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
| Base fabric | no | Free text |
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
| **Country code** | Optional ISO country code, e.g. `CN`, `TW`, `IN`. |
| **Contact name** | Optional name of the primary contact at the mill. |
| **Contact email** | Optional contact email address. |
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
| **Code** | Operator-supplied on create, then **locked** — e.g. `UPS`, `FEDEX`, `USPS`. Unlike auto-coded masters (Warehouses, RMA Reasons), you set the code. |
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
| **Code** | Optional short code, e.g. `MENS_TOPS`. Editable; uppercased on save; unique when supplied. |
| **Sort order** | Optional integer ordering (low to high), then name as tie-breaker. |
| **Active** | Inactive scopes drop out of the buyer scope picker but stay assigned where already chosen. Toggle **Show inactive** to see them. |

### Delete protection

Deleting a scope is **blocked** if any buyer is currently assigned it (you'll get a clear message with the count). Deactivate it instead to retire it from the picker while keeping existing assignments. Standard panel features apply: server-side search (name or code), `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

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
- **US phone mask.** Phone inputs auto-format to **(XXX) XXX-XXXX** as you type — everywhere **except the Vendor master** (vendors are often overseas, so their phone stays free-form). A value beginning with `+` is treated as international and left as typed.

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
