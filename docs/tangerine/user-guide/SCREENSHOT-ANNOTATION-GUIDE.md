# Tangerine User-Guide — Screenshot Annotation Guide

This is the companion to the **🖼️ User-guide screenshots** section of [`../OPERATOR-TODO.md`](../OPERATOR-TODO.md). For every screenshot the guide references (the **14 priority / referenced-but-missing** shots) **and** every **nice-to-have** suggestion, it tells you:

- **Capture** — the exact screen / panel / modal to open and the data state to have on screen.
- **Used in guide for** — the concept or sentence in that chapter the image illustrates (so the picture matches the words).
- **Annotate** — the specific UI elements to mark up, using **→ arrows** (point at a control) and **▭ boxes** (frame a region). Do **borders/callouts only — do not fill over the content**. 2–4 callouts per image.

Drop the finished PNG at `docs/tangerine/user-guide/screenshots/<filename>` (the path each entry gives). Where a screen changed in the 2026-06-05 session, the entry describes the **current** screen.

> **Tip:** capture at a readable window width (≥ 1280px), light theme unless the panel is dark-by-design (the Ask AI panel and some charts are dark). Use a contrasting arrow colour (red/orange) so callouts read over the orange Tangerine chrome.

---

# PART 1 — PRIORITY (referenced in the guide, file currently missing) — 14 shots

These 14 are already linked from the guide, so the broken-image placeholder shows until you supply them. Do these first.

## Chapter 01 — Getting Started

### `01-tangerine-login.png` — Branded login
- **Capture:** Open `/tangerine` (or `/login`) in a browser with **no** Microsoft session (use a private window). You should see the Tangerine-branded sign-in card — orange "T" logo, "Sign in to continue," and the **Sign in with Microsoft** button. Do not sign in yet.
- **Used in guide for:** §"Logging in" / "The login screen" — "you'll see the **Tangerine-branded login screen** — orange 'T' logo … and a 'Sign in with Microsoft' button."
- **Annotate:**
  - ▭ box the orange **T logo** card.
  - → arrow to the **Sign in with Microsoft** button.
  - (optional) ▭ box the "Sign in to continue" tagline.

### `01-tangerine-home.png` — Home landing
- **Capture:** Sign in, then click the Tangerine logo (top-left) so **no module is selected** — the home landing with module cards grouped by section. Make sure the top nav is fully visible.
- **Used in guide for:** §"The Tangerine nav layout" + "Home landing … shows module cards organized by the same group structure." Also illustrates the 2026-06-05 note that Procurement/Treasury/ESG groups are now visible.
- **Annotate:**
  - ▭ box the **top-nav group dropdowns row** (Master Data · Accounting · Treasury · Vendors · Procurement · Inventory · Sales · Customers · ESG · Admin).
  - → arrow to the **🔍 Find a panel** type-ahead box.
  - → arrow to the top-right **circular avatar + name** (new 2026-06-05 avatar).
  - ▭ box one **group of module cards** on the landing body.

### `01-tangerine-apps-launcher.png` — Apps launcher dropdown
- **Capture:** From any Tangerine screen, click **🧩 Apps ▾** (top-right) so the dropdown is open, showing the suite app links (Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning, Costing, Vendor Portal).
- **Used in guide for:** §"Right: 🧩 Apps ▾ dropdown — opens a grid of the other apps … Clicking any link opens that app in a new browser tab."
- **Annotate:**
  - ▭ box the open **Apps dropdown grid**.
  - → arrow to the **🧩 Apps ▾** trigger button.
  - → arrow to one app link (e.g. **📈 Planning**) to show the deep-link targets.

## Chapter 02 — Master Data

### `02-style-master-list.png` — Style Master list
- **Capture:** Master Data → **Style Master**. Have several style rows loaded. Type a few letters in the search so the live-filter is visible. Make the **Size Scale** column visible (it's part of the list now).
- **Used in guide for:** §"List view" — columns **Code, Description, Gender, Season, Year, Lifecycle, Apparel**, search by code/description, Show-deleted toggle, Edit/Delete per row.
- **Annotate:**
  - → arrow to the **search box** (note "filters live as you type").
  - ▭ box the **column header row** (Code · Description · Gender · Season · Year · Lifecycle · Apparel).
  - → arrow to the **Show deleted** toggle.
  - → arrow to a row's **Edit** / **Delete** buttons.

### `02-style-master-add-modal.png` — Add Style modal (with opt-in UPC checkbox)
- **Capture:** Style Master → **+ Add style**. Open the modal with all fields visible, **including the new `Generate UPCs (GS1)` checkbox** at the bottom. If a GS1 prefix is configured the checkbox is enabled; capture it that way.
- **Used in guide for:** §"Add modal" + §"Generating UPCs for a new style (opt-in GS1 minting)" — the checkbox "mints one unique UPC-A barcode per color/size from the company GS1 prefix."
- **Annotate:**
  - ▭ box the **field stack** (Style code · Description · Gender · Season · Design year · Lifecycle · Apparel?).
  - → arrow to the **Generate UPCs (GS1)** checkbox (label it "opt-in, off by default").
  - → arrow to the **Style code** field (note "auto-uppercased, unique per entity").

### `02-vendor-master-list.png` — Vendor Master list
- **Capture:** Master Data → **Vendor Master**, several rows loaded. Make sure the **1099?** and **Payment Terms** columns are visible; show the "Show inactive" toggle.
- **Used in guide for:** §"Vendor Master" list columns — **Code, Name (legal_name underneath if different), Country, Status, 1099?, Payment Terms**.
- **Annotate:**
  - ▭ box the **column header row** highlighting **1099?** and **Payment Terms**.
  - → arrow to a row where **legal_name** shows under the name.
  - → arrow to the **Status** badge (active / on_hold / inactive).

### `02-customer-master-list.png` — Customer Master list (with type filter)
- **Capture:** Master Data → **Customer Master**. Open the **Customer type** dropdown above the table (all / wholesale / ecom / showroom / employee / other) so the filter is visible. Several rows loaded.
- **Used in guide for:** §"Customer Master" — "Customer type filter — Dropdown above the table," columns **Code, Name, Customer type, Country, Status, Credit limit, Payment terms**.
- **Annotate:**
  - → arrow to the **Customer type** filter dropdown (open).
  - ▭ box the **Customer type** and **Credit limit** columns in the header.
  - → arrow to a **Status** badge.

## Chapter 03 — Accounting

### `03-coa-list.png` — Chart of Accounts list
- **Capture:** Accounting → **Chart of Accounts**, populated (the 474+ accounts are loaded in prod). Columns **Code, Name, Type, Subtype, Balance, Status, Postable, Control** visible. Show the Type dropdown and search above the table.
- **Used in guide for:** §"List view" — columns + "Type dropdown — narrow to one account type," and the real-$ Balance column.
- **Annotate:**
  - ▭ box the **column header row** (emphasise **Balance**, **Postable**, **Control**).
  - → arrow to a **control account** row (e.g. AR 1200) showing its Control flag.
  - → arrow to the **Type** filter dropdown.

### `03-coa-add-modal.png` — COA Add modal (normal_balance auto-fill)
- **Capture:** COA → **+ Add account**. Pick an **Account type** of `asset` (or `expense`) and capture the moment the **Normal balance** field shows the auto-derived **DEBIT** value.
- **Used in guide for:** §"Add modal" — "**Normal balance** (auto-fills) … Changes when you change account_type." This is the headline behaviour the image must show.
- **Annotate:**
  - → arrow from the **Account type** dropdown to the **Normal balance** field (draw the cause→effect).
  - ▭ box the **Normal balance = DEBIT** field (label "auto-derived from type").
  - → arrow to the **Control** / **Postable** checkboxes.

### `03-coa-delete-blocked.png` — Delete-blocked 409
- **Capture:** COA → click **Delete** on an account that **has posted JE lines**. Capture the alert/toast: *"Account has posted journal entry lines; mark it inactive via PATCH status='inactive' instead of deleting."*
- **Used in guide for:** §"Deleting accounts" — "rejects with 409 if any `journal_entry_lines` row references the account."
- **Annotate:**
  - ▭ box the **error alert text** (the 409 message).
  - → arrow to the **Delete** button that triggered it.
  - (optional) → arrow to the account row to make clear which account was blocked.

### `03-periods-list.png` — Periods list, FY card expanded
- **Capture:** Accounting → **Periods**. Expand the **FY 2026** card so its 12 monthly rows show, each with a color-coded status badge (🟢 open / 🟡 soft_close / 🔴 closed) and the per-row **Run checks / Soft close / Close / Reopen** buttons.
- **Used in guide for:** §"Periods → List view" + §"Close Pre-flight Checks" — the status badges and the Run-checks button.
- **Annotate:**
  - ▭ box one **status badge** (green = open).
  - → arrow to the **Run checks** button on a period row.
  - → arrow to the **posted_je_count** for a period (what you're closing).
  - ▭ box the **FY 2026 card header** (the collapsible grouping).

### `03-je-list.png` — Journal Entries list
- **Capture:** Accounting → **Journal Entries** with a mix of **posted** and **reversed** rows (reversed/draft render grayed). Columns **Posting date, Type, Basis, Description, Source, Status**. Show the Basis filter + Include-drafts toggle.
- **Used in guide for:** §"Journal Entries → List view" — "Reversed JEs and drafts show grayed out," with a **Reverse** button per posted row.
- **Annotate:**
  - ▭ box the **column header row**.
  - → arrow to a **grayed reversed** row.
  - → arrow to a posted row's **Reverse** button.
  - → arrow to the **Basis** filter (all / ACCRUAL / CASH).

### `03-je-post-modal-balanced.png` — Post JE modal, balanced
- **Capture:** Journal Entries → **+ Post manual JE**. Add 2+ lines that **balance** (Σ debit = Σ credit) so the footer shows the green **● Balanced** indicator and the **Post** button is **enabled**.
- **Used in guide for:** §"Posting a manual JE" — "Footer should show **● Balanced** in green … the **Post** button is disabled until: lines balance AND description is non-empty."
- **Annotate:**
  - ▭ box the green **● Balanced** footer indicator.
  - → arrow to the **enabled Post** button.
  - ▭ box the **lines table** (Account · Debit · Credit · Memo · Sub type · Sub id).
  - → arrow to the live **Σ debit / Σ credit totals** row.

### `03-je-post-modal-unbalanced.png` — Post JE modal, out of balance
- **Capture:** Same modal, but make the lines **not** balance (e.g. debit 100, credit 90) so the footer turns red ("Out of balance by X.XX") and the **Post** button is **disabled/greyed**.
- **Used in guide for:** §"Posting a manual JE" — "Out of balance → Red footer … Post button DISABLED."
- **Annotate:**
  - ▭ box the red **"Out of balance by X.XX"** footer.
  - → arrow to the **disabled Post** button (note it's greyed).
  - → arrow to the line whose amount creates the imbalance.

---

# PART 2 — NICE-TO-HAVE (chapters that describe a screen with no image)

Suggested filenames per the OPERATOR-TODO list. Lower priority than Part 1, but they fill out chapters that currently describe a screen in words only.

## Chapter 13 — Accounts Payable

### `13-ap-invoices-list.png` — AP invoice list
- **Capture:** AP Invoices panel with rows across statuses (draft / posted / paid / void). Show the status filter + search.
- **Used in guide for:** the AP lifecycle (draft → pending_approval → posted → paid → void) and the panel's CRUD/Post/Pay/Void actions.
- **Annotate:**
  - ▭ box the **status column** showing several lifecycle states.
  - → arrow to a draft row's **Post** action and a posted row's **Pay** action.
  - → arrow to the **status filter** dropdown.

### `13-ap-invoice-add-modal.png` — New AP invoice (draft)
- **Capture:** AP Invoices → **+ New invoice**. Pick a vendor so **Payment terms / expense account / AP account auto-fill from the vendor master**. Show at least one line and the **☰ List / ▦ Matrix** toggle.
- **Used in guide for:** §"Creating an AP invoice" — vendor-driven auto-fill of Payment Terms + default accounts; §"☰ List / ▦ Matrix view."
- **Annotate:**
  - → arrow from the **Vendor** picker to the **Payment terms** field (the auto-fill).
  - → arrow to the **☰ List / ▦ Matrix** toggle.
  - ▭ box the **running total** under the lines table.

### `13-ap-payment-modal.png` — Payment capture
- **Capture:** On a posted AP invoice, click **Pay**. Show the Pay sub-modal (Payment date, Amount $ defaulting to outstanding balance, Method, Bank account, Reference).
- **Used in guide for:** §"Recording a payment" — the Pay sub-modal fields and the overpay guard.
- **Annotate:**
  - → arrow to the **Amount $** field (note "defaults to outstanding balance; partial pays OK").
  - → arrow to the **Method** dropdown (ach / wire / check / credit_card / cash).
  - ▭ box the **Bank account** field.

## Chapter 16 — Accounts Receivable

### `16-ar-invoices-list.png` — AR invoice list
- **Capture:** AR Invoices panel with mixed statuses; show the **Balance** column (amber when > 0) and void rows at reduced opacity.
- **Used in guide for:** §"Filter row" + the AR lifecycle; "Void invoices render at 50% opacity. The **Balance** column … colored amber when > 0."
- **Annotate:**
  - ▭ box the amber **Balance** column.
  - → arrow to a **50%-opacity void** row.
  - → arrow to the **Status** filter.

### `16-ar-invoice-add-modal.png` — New AR invoice (draft)
- **Capture:** AR Invoices → **+ New invoice**. Show the customer picker, the auto-`AR-YYYY-NNNNN` number hint, the account-chain defaults (AR/Revenue/COGS/Inventory), and the **☰ List / ▦ Matrix** toggle.
- **Used in guide for:** §"Creating an AR invoice" + §"☰ List / ▦ Matrix view" — the matrix is the color×size grid of inventory lines.
- **Annotate:**
  - → arrow to the **Invoice number** field (note "auto AR-YYYY-NNNNN if blank").
  - → arrow to the **☰ List / ▦ Matrix** toggle.
  - ▭ box the **GL account defaults** (Revenue / COGS / Inventory) section.

### `16-ar-invoices-filters.png` — AR filter row
- **Capture:** AR Invoices panel focused on the six-filter row (Status, Customer, From/To, Limit, Include void, Search).
- **Used in guide for:** §"Filter row" — the six filters listed.
- **Annotate:**
  - ▭ box the full **filter row**.
  - → arrow to the **Include void** checkbox.
  - → arrow to the **From / To** date range.

## Chapter 17 — Bank Reconciliation

### `17-bank-recon-plaid-link.png` — Plaid link / connected account
- **Capture:** Bank → **Accounts** tab. Either the Plaid Link flow mid-connection, or a connected `bank_accounts` row showing institution + mask + the **Edit rules** button.
- **Used in guide for:** §"Plaid linking" + §"Auto-post fee rules" — connecting an account and the per-row Edit-rules control.
- **Annotate:**
  - → arrow to the **connected account** row (institution + mask).
  - → arrow to the **Edit rules** button.
  - ▭ box the account's **GL account** binding.

### `17-bank-recon-match-engine.png` — ±5-day match results
- **Capture:** Bank → **Transactions** tab with the unmatched queue and candidate matches showing (confidence = 100 − days_apart×5). Show a row's **Match / Create JE / Ignore** actions.
- **Used in guide for:** §"Match engine" — "every `journal_entry_lines` row … whose (posting_date, signed_amount) matches within ±5 days," with the four match RPCs.
- **Annotate:**
  - ▭ box a **candidate match** with its **confidence %**.
  - → arrow to the **Match** button.
  - → arrow to the **Create JE** button (for fees/interest).

## Chapter 20 — CRM

### `20-crm-sales-pipeline.png` — Pipeline stages
- **Capture:** CRM → **Pipeline Report** (the 5 stage cards: new / qualified / proposal / won / lost), each card with Count · Total · Weighted.
- **Used in guide for:** §20.5 "Pipeline Report" — "5 stage cards + a flow-bar … the **Weighted** column is the realistic forecast."
- **Annotate:**
  - ▭ box one **stage card** showing Count / Total / **Weighted**.
  - → arrow to the **Weighted** figure (note "= Σ expected × probability").
  - ▭ box the **flow-bar** visualization.

### `20-crm-activity-log.png` — Activity timeline
- **Capture:** CRM → **Opportunities** → open an opp's detail modal showing the **activity timeline** (notes / calls / emails / stage_change rows), with the Stage dropdown.
- **Used in guide for:** §20.2/20.3 — the append-only activity log and stage-change auto-logging.
- **Annotate:**
  - ▭ box the **activity timeline** list.
  - → arrow to a **stage_change** entry (auto-logged).
  - → arrow to the **Stage** dropdown.

## Chapter 21 — PIM

### `21-pim-product-catalog.png` — Product Catalog (now style × color)
- **Capture:** Master Data → **Product Catalog**. Capture the list at its **style × color grain** — columns **Image, Style Number, Style Name, Color, Category, Brand, Publish Status, Last Updated**. Click a row to show (or have open) the **3-tab detail editor** (Attributes / Description / Images).
- **Used in guide for:** §21.1 — "List view at **style × color** grain — each style expands into one row per distinct color," and the 3-tab editor. *(This is the changed screen — describe the current color-grain list, not the old style-only catalog.)*
- **Annotate:**
  - ▭ box the **Color column** (the new per-color grain).
  - → arrow to a thumbnail in the **Image** column.
  - → arrow to the **Publish Status** column.
  - ▭ box the **Attributes / Description / Images** tab strip in the detail editor.

## Chapter 24 — User Access (RBAC)

### `24-user-access-matrix.png` — Permission matrix
- **Capture:** Admin → **User Access**. Show the member list with a **role dropdown** per user and the **module × action** grid (read · write · post · void · export) of effective permissions.
- **Used in guide for:** §"The User Access panel" — "a module × action grid showing their *effective* permissions (role + overrides combined)."
- **Annotate:**
  - ▭ box the **module × action grid** (rows = modules, cols = the 5 verbs).
  - → arrow to a user's **role dropdown**.
  - → arrow to a single **override checkbox** (grant/revoke one cell).

## Chapter 26 — Brand Master & GL Allocation

### `26-brand-allocation-editor.png` — Per-account brand % splits
- **Capture:** COA → open a **P&L account** modal → the **`<BrandAllocationEditor>`**: brand multi-select, per-brand `%` inputs, "Split evenly" helper, one-default radio, and the live **"Total: X% (must = 100)"** indicator. Set the splits so they total exactly 100%.
- **Used in guide for:** §26.4 "Configuring a rule (COA panel)" — the editor and the SUM=100 constraint.
- **Annotate:**
  - ▭ box the **per-brand % inputs**.
  - → arrow to the **"Total: 100%"** indicator (must equal 100).
  - → arrow to the **one-default radio** and the **Split evenly** helper.

## Chapter 27 — Sales Orders & Allocations

### `27-sales-order-list.png` — SO list
- **Capture:** Sales → **Sales Orders** with rows across statuses (draft / confirmed / allocated / fulfilling / shipped / invoiced). Show the **Customer** filter and a row's `SO-YYYY-NNNNN` number.
- **Used in guide for:** §27.1 lifecycle + §30.4 customer-drill filter — the SO list and its status flow.
- **Annotate:**
  - ▭ box the **status column** across several lifecycle states.
  - → arrow to a confirmed row's **SO-YYYY-NNNNN** number.
  - → arrow to the **Customer** filter dropdown.

### `27-allocations-workbench.png` — Allocations Workbench (grouped by SO)
- **Capture:** Sales → **Allocations**. Capture the grouped tree — **Style · Color → SKU (size) → competing SO lines** — with the priority badges (🅕 factor / 💳 card / ⏱ oldest / ⚠ blocked) and the **⚡ Auto-allocate all** + **⚙ Rules** header buttons. *(The session note says allocations are regrouped by SO — make sure the per-SO grouping is the visible structure.)*
- **Used in guide for:** §27.5 "Surface B — the Allocations Workbench" — the demand tree, priority tiers, and auto-allocate.
- **Annotate:**
  - ▭ box one **SKU row with its competing SO lines** underneath (the per-SO grouping).
  - → arrow to a **priority badge** (e.g. 🅕 factor).
  - → arrow to the **⚡ Auto-allocate all** button.
  - → arrow to an editable **Allocated** cell.

## Chapter 28 — Purchase Orders & Size Matrix

### `28-purchase-order-list.png` — Native PO list
- **Capture:** Inventory → **Purchase Orders** with rows across statuses (draft / issued / in_transit / received / cancelled). Show a `PO-YYYY-NNNNN` number and the vendor/status filters.
- **Used in guide for:** §28.5 "Native Purchase Orders" — the status lifecycle and origination module.
- **Annotate:**
  - ▭ box the **status column** (draft … received).
  - → arrow to an issued PO's **PO-YYYY-NNNNN** number.
  - → arrow to the **vendor** filter.

### `28-size-matrix-grid.png` — Size matrix grid (with product image)
- **Capture:** Inventory → **Inventory Matrix**. Pick a style that has a **primary product image**. Capture the **color × size grid** in scale order with the **Total / Avg Cost / Total Cost / Last Received** columns, **and the product-image thumbnail shown immediately before the style number** in the meta line. *(Changed this session — the thumbnail + click-to-enlarge is new; include it.)*
- **Used in guide for:** §28.6 "Inventory Matrix panel" + "Product image (PR #969)" — "its primary product image appears as a thumbnail immediately before the style number … click the thumbnail to enlarge."
- **Annotate:**
  - → arrow to the **product-image thumbnail** before the style number (note "click to enlarge").
  - ▭ box the **color × size grid** (sizes in scale order, not alphabetical).
  - → arrow to the **Avg Cost** column.
  - → arrow to the **On-Hand / ATS** toggle (ATS is an out-link).

## Chapter 29 — B2B Portal

### `29-b2b-portal-landing.png` — `/b2b` buyer landing
- **Capture:** Sign into the `/b2b` portal as a buyer (needs an active `b2b_accounts` row). Capture the shell with the **Catalog / Orders / Account** tabs, the buyer's customer name in the header, and the **🛒 cart chip** (units · $ total) if the cart is non-empty.
- **Used in guide for:** §29.1 portal overview — the three buyer pages and the header cart chip.
- **Annotate:**
  - ▭ box the **Catalog / Orders / Account** tab strip.
  - → arrow to the **🛒 cart chip** (units · running $).
  - → arrow to the **customer name** in the header (server-scoped to one customer).

## Chapter 30 — Reference Masters

### `30-countries-genders-master.png` — Countries / Genders master (auto-codes)
- **Capture:** Master Data → **Genders** (or **Countries**). Open the **Add** modal — for Genders, type a label (e.g. "Women") and capture the **auto-suggested code** ("W") filling in. Show the list behind it with the sort_order column + Show-inactive toggle.
- **Used in guide for:** §30.1/30.2 — the new reference masters and "the Add-Gender modal auto-fills `code` from the uppercased first letter of `label`."
- **Annotate:**
  - → arrow to the **auto-filled code** field (note "editable default").
  - ▭ box the **list** behind (Code · Label · Sort order · Active).
  - → arrow to the **Show inactive** toggle.

## Chapter 31 — Pricing Engine

### `31-price-list-editor.png` — Price list + qty breaks + promotions
- **Capture:** Sales → **Pricing → Price Lists** → open a list → the **+ Add price** editor with a Style, a base **Min qty 0** row, and at least one break row (e.g. `144`). If practical, also show a Promotion in the Promotions panel.
- **Used in guide for:** §31.2 "Adding prices & quantity breaks" — "use `0` for the base price; add more rows at `12`, `144`, … for break pricing."
- **Annotate:**
  - ▭ box the **quantity-break rows** (min-qty 0 + a higher break).
  - → arrow to the **Min qty** field.
  - → arrow to the list **Scope** (Default / Tier / Customer).

## Chapter 32 — Procurement / Receiving

### `32-receiving-against-po.png` — Receiving against a PO + QC dispositions
- **Capture:** Procurement → **Receiving** → **+ New receipt** → pick an issued PO so its lines load (received = accepted = ordered). Show the **landed-cost rollups** section and the **Post receipt** button. *(Optionally a second shot of the QC Inspections disposition picker, but one combined receiving shot is fine.)*
- **Used in guide for:** §32.2 "Receiving" — the GRNI posting and the landed-cost rollup capitalize toggle.
- **Annotate:**
  - ▭ box the **received / accepted / rejected** qty columns.
  - → arrow to the **landed-cost rollup** row and its **capitalize to inventory** toggle.
  - → arrow to the **Post receipt** button.

## Chapter 33 — Planning ⇄ Tangerine

### `33-create-tangerine-pos.png` — Buy plan → Create Tangerine POs
- **Capture:** `/planning` → **Execution** on an approved batch. Show the **🔍 Preview POs** and **🍊 Create Tangerine POs** buttons, and (after a preview/run) the per-vendor grouping with the **Tangerine PO** chip / `open in Procurement →` link.
- **Used in guide for:** §33.2 "Running it" — "One approved buy plan → one DRAFT Tangerine purchase order per vendor."
- **Annotate:**
  - → arrow to the **🍊 Create Tangerine POs** button.
  - → arrow to the **🔍 Preview POs** button (note "always preview first").
  - ▭ box a created PO's **`open in Procurement →`** chip.

## Chapter 34 — Returns / RMA

### `34-rma-lifecycle.png` — RMA raise → approve → receive → credit
- **Capture:** Sales → **Returns/RMA**. Open an RMA's expanded view showing the line **disposition picker** (Restock / Scrap), the lifecycle status, and the **Issue credit memo** action. Capture one that has an `RMA-YYYY-NNNNN` number assigned.
- **Used in guide for:** the RMA lifecycle (requested → approved → received → credited) and the Restock-vs-Scrap GL effect.
- **Annotate:**
  - ▭ box the **disposition picker** (Restock / Scrap) on a line.
  - → arrow to the **RMA-YYYY-NNNNN** number.
  - → arrow to the **Issue credit memo** button (note "the irreversible step").

## Chapter 35 — Drop-Ship

### `35-dropship-order.png` — Drop-ship order + margin + tracking
- **Capture:** Sales → **Drop-Ship**. Open an order's expanded row showing the per-line **Cust $ / Cost $ → margin**, the **carrier + tracking** fields, and the `DS-YYYY-NNNNN` number. Capture one where a line's margin is healthy (and ideally one underwater line rendering red).
- **Used in guide for:** §"Creating a drop-ship order" + §"Tracking" — "customer price − vendor cost = margin … margin turns red if a line is underwater."
- **Annotate:**
  - ▭ box the per-line **Cust $ / Cost $ / margin** columns.
  - → arrow to a **red (underwater) margin**, if present.
  - → arrow to the **carrier + tracking** fields.

## Chapter 36 — 3PL

### `36-3pl-shipment.png` — 3PL shipment lifecycle
- **Capture:** Inventory → **3PL** → **Shipments** tab. Show a shipment row with **Direction** (Inbound / Outbound / Return), the `TPL-YYYY-NNNNN` number, lifecycle status (draft → in_transit → received → closed), and carrier/tracking.
- **Used in guide for:** §36.2 "Shipments" — direction, lifecycle, reference/ASN + carrier/tracking.
- **Annotate:**
  - → arrow to the **Direction** field (Inbound / Outbound / Return).
  - ▭ box the **status** column (draft … closed).
  - → arrow to the **TPL-YYYY-NNNNN** number + tracking.

## Chapter 37 — EDI

### `37-edi-message-log.png` — EDI (Vendors / Customers / Settings) + message log
- **Capture:** Master Data → **EDI**. Capture the **Vendors** dashboard with the **Messages** tab open showing the X12 log (doc types 850/855/856/810/997 + status). Make the **EDI sub-menu (Vendors / Customers / Settings)** visible in the nav. *(Changed this session — EDI moved to Master Data with three sub-items; show that structure, not the old single Procurement panel.)*
- **Used in guide for:** §37.1 "Vendors" + the sub-menu intro — "a sub-menu with three items: Vendors / Customers / Settings," and the live X12 message log.
- **Annotate:**
  - ▭ box the **EDI sub-menu** (Vendors / Customers / Settings) in the nav.
  - ▭ box the **Messages** log table (doc-type column + status column).
  - → arrow to a row's **doc type** (e.g. 850) and **status**.

## Chapter 38 — Reports Hub

### `38-reports-landing.png` — Reports hub KPI tiles + links
- **Capture:** Reports → **Reports & Analytics**. Show the live **KPI tiles** (Open AR · Open AP · Inventory @ cost · Open sales orders · Current period), the **executive ratios**, a **BI chart** (top vendors / spend trend / balance donut), and the grouped **report links**.
- **Used in guide for:** §"KPI tiles" + "Business intelligence charts" + "Report links" — the executive landing tying reports together.
- **Annotate:**
  - ▭ box the **KPI tiles** row.
  - → arrow to one **executive ratio** (e.g. AR / AP ratio with its green/amber colour).
  - ▭ box one **BI chart** (e.g. Top vendors by spend).
  - → arrow to a **report link** group (e.g. Financial Statements).

## Chapter 39 — Fixed Assets / Budgets / 1099

### `39-fixed-asset-register.png` — Fixed-asset register
- **Capture:** Accounting → **Fixed Assets**. Show the asset register with **cost / salvage / useful life**, the auto `FA-NNNN` code, **Net Book Value**, and the **Depreciate → today** + **Dispose** actions.
- **Used in guide for:** §39.1 "Fixed Assets" — straight-line depreciation and NBV.
- **Annotate:**
  - ▭ box the **Net Book Value** column.
  - → arrow to the **Depreciate → today** button.
  - → arrow to an **FA-NNNN** code.

### `39-budget-vs-actual.png` — Budget vs actual variance
- **Capture:** Accounting → **Budgets**. Pick a fiscal year, set a budget on a few accounts so the table shows **Budget · Actual · Variance** side by side.
- **Used in guide for:** §39.2 "Budgets" — "the table shows the **actual** GL balance beside it with the **variance** (budget − actual)."
- **Annotate:**
  - ▭ box the **Budget / Actual / Variance** columns.
  - → arrow to a row with a notable **variance** (colour-coded).
  - → arrow to the **fiscal-year** picker.

---

## How an image lands in the guide
Each chapter already has the `![alt](screenshots/<file>.png)` reference in place (that's why the priority 14 currently show a broken image). Drop your PNG at the exact path in the entry above and it renders automatically on the next docs build — no markdown edit needed. For the nice-to-have shots, the filename is the suggested one from OPERATOR-TODO; if a chapter doesn't yet have the `![...]` line, add it next to the relevant paragraph (same `screenshots/<file>.png` path).
