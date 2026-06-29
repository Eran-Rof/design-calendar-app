# 3 — Costing

The Costing app is where you build a price/cost workbook for a new program, send the styles out to vendors as RFQs (requests for quote), compare the quotes side by side, and award the winner. It lives at its own address — open the **Costing** card from the Apps menu, or go straight to `/costing`.

Costing has five tabs across the top nav: **Projects**, **RFQs**, **Compare RFQs**, **Messages**, and **Masters**. On the right of the nav are **Vendor Portal ↗** and **Vendor Onboarding ↗** links that open the standalone vendor app in a new tab. A 🔔 notification bell sits in the bottom-right corner — RFQ activity (a vendor revised their quote, a vendor submitted, etc.) lands here, in the Costing app, not on the PLM launcher home screen.

> **Where do the numbers come from?** A costing line starts from a style you pick out of Style Master; historical cost and sales figures are pulled live from your purchase-order and sales history. Nothing you type here changes those source records — the project is your own working sheet until you award an RFQ.

## How a project flows

```
Create project → fill the header → add costing lines (one per style/color)
   → tick lines → Vendor RFQ (creates + sends one RFQ per vendor)
   → vendor quotes in their portal → Compare RFQs → Award the winner
```

A line's status walks through that flow automatically: **Draft → Sent → Quoted → Awarded** (or **Lost** if a different vendor wins, **Revised** if you change a sent line, **Closed** when you retire it).

## The Projects tab

The **Projects** tab is the landing screen. It lists every costing project with columns for **Project**, **Brand**, **Gender**, **Customer**, **Sales Rep**, **Line Status**, **Due**, and **Created**. Click any column header to sort by it.

The **Line Status** column shows a small coloured chip for each status that the project's lines fall into — for example `1/5 Awarded · 4/5 Draft` means one of five lines is awarded and the other four are still drafts.

A tab strip above the table buckets projects by status: **All · Draft · Sent · Quoted · Awarded · Lost · Revised · Closed**. The count beside each tab is how many projects have at least one line in that status. Clicking a tab filters the list; the **Export** button (top-right) exports exactly what the active tab is showing as an Excel file.

### Creating a project

1. Click **+ Add New**.
2. Type a project name (e.g. `BOYS 7/1 DDP QTN`) and click **Create**.
3. You land in the project's detail view. The three date fields are pre-filled for you (request date = today, due date = a few business days out, projected delivery = roughly four months out).

To open an existing project, click anywhere on its row. To delete one, use the **Delete** button at the end of the row — note this cascades to all of that project's lines, quotes, and compliance rows and cannot be undone.

## The project detail view

A project detail page has three parts stacked top to bottom: the **header form** (always visible), a collapsible **Plan Flow** stage strip, and a tabbed work area with **Costing Grid** / **Compliance** / **All** tabs.

The top bar shows the project name, a save indicator (**Saving… / Unsaved / ✓ Saved** — the form auto-saves about a second after you stop typing, so there is no Save button), an **Export** button, and a **Discard** button that reverts unsaved header edits. The **← Projects** button returns to the list.

### The project header (required before any rows)

Fill the header **before** adding costing lines. Every field marked with a red `*` is required, and **+ Add row** stays locked (greyed out) with a list of what's missing until they're all set. Required fields get a red-tinted border while empty, and a warning strip appears under the form naming exactly what's still missing.

| Field | Notes |
|---|---|
| **Project name** | Free text. |
| **Brand** | Picked from your brand list (free text if the list hasn't loaded). |
| **Gender** | Men's, Women's, Boys, Girls, or Child. |
| **Customer** | Type-ahead picker. |
| **Sales rep** | Type-ahead picker. |
| **Payment terms** | Dropdown from the Payment Terms master. **This drives the cost mode** — see below. |
| **Request date** | Required. |
| **Due date** | Required. |
| **Projected delivery** | Optional. |
| **Notes** | Optional free text. |

> **Payment terms set the cost mode.** If the payment term you pick has **"DDP"** in its name (DDP, DDP 30, DDP 60, …), the grid switches into **DDP** mode. Any other term keeps the grid in **FOB / Landed** mode. This changes which cost columns appear — pick the right term up front.

## The costing grid

Each row in the grid is one style/color line. The toolbar above the grid has **+ Add row**, **⎘ Copy**, **✕ Delete**, **Vendor RFQ**, a **Comp period** date range, and a **Columns** button to show/hide columns (your choices are remembered). Drag the **⋮⋮** handle at the start of a row to reorder lines; right-click a row for **Duplicate row** (which copies it below and clears the vendor so you can quote a different one).

To start a line, click **+ Add row**, then pick a **Style#** — picking a style auto-fills the description, category, a suggested fabric, and seeds the **Avg Cost** reference from purchase history.

### The grid columns

| Column | What it is |
|---|---|
| **Status** | The per-line lifecycle pill (see below). |
| **Style#** | The style, picked from Style Master. |
| **Description / Scale / Fabric / Fit / Color / Closures / Waist / Comment** | The spec. Fabric is multi-select; Color is scoped to the colors that style actually comes in (plus any you've typed). |
| **Qty** | Target units. |
| **Vendor** | The vendor you intend to quote/award. Pick from the dropdown. |
| **Avg Cost** | Read-only reference, seeded from purchase history on style pick. |
| **PO History** | A **📋 PO Hist** button — opens a popover of past purchase orders for this style across **all** vendors (including archived POs). See below. |
| **Tgt Cost** / **Tgt DDP Cost** | The cost you're targeting. Labelled **Tgt DDP Cost** in DDP mode. |
| **FOB · Duty % · Freight · Insur · Other · Landed** | The FOB cost build-up — grouped under a **FOB / Landed Target** banner. **Hidden entirely in DDP mode.** |
| **Sell Tgt Frm Mrgn** | Type a target margin % to derive the sell price (see below). |
| **Sell Tgt** | Your target selling price. |
| **Margin %** | Live margin, also editable to back-solve cost (see below). |
| **LY Cost · LY Sls Prc · LY Mgn %** | Last-year comparison from sales history. |
| **T3 Cost · T3 Sls Prc · T3 Mgn %** | Trailing-3-months comparison. |
| **Compliance** | Inline compliance-requirement chips for this line. |
| **Docs** | A **📎** button to attach documents to the line. |

At the bottom, a **TOTAL** row sums quantity, total cost (Σ qty × cost), total sales (Σ qty × Sell Tgt), and shows the weighted overall margin (green ≥ 50%, amber ≥ 30%, red below).

### Cost modes: FOB/Landed vs DDP

The grid has two cost bases, chosen by the project's payment term:

| Mode | Cost columns shown | Cost basis used for margin |
|---|---|---|
| **FOB / Landed** (default) | FOB, Duty %, Freight, Insur, Other, and a computed **Landed** | Landed cost |
| **DDP** (term name contains "DDP") | **Tgt DDP Cost** only (the FOB→Landed columns are hidden) | Tgt DDP Cost |

In FOB/Landed mode, **Landed = FOB + (FOB × Duty %) + Freight + Insurance + Other**. The Landed cell computes automatically as you fill the components.

### Sell Tgt Frm Mrgn (margin → sell)

The **Sell Tgt Frm Mrgn** column derives a selling price from a margin you want to hit. Type a target gross-margin % and the grid fills **Sell Tgt** = `cost basis ÷ (1 − margin/100)`, holding the cost fixed. The cell keeps showing the margin you typed until you override Sell Tgt directly — at which point this cell **blanks**, because the sell price no longer comes from a margin. (Margin must be below 100%.)

### Sell Tgt and Margin %

There is **no separate "Sell" column** — margin, totals, and the per-vendor comparison all use **Sell Tgt**. **Margin %** auto-fills as:

> Margin % = (Sell Tgt − cost basis) ÷ Sell Tgt × 100

The cell is colour-tiered (green = healthy, amber = thin, red = poor) so a weak margin jumps out.

**Margin % is editable, and editing it back-solves the cost** (the inverse of Sell Tgt Frm Mrgn, which holds sell fixed):

- **DDP mode** → sets **Tgt DDP Cost** = `Sell Tgt × (1 − margin/100)`.
- **FOB/Landed mode** → solves **FOB** so that Landed hits the implied cost, holding Duty %, Freight, Insurance, and Other fixed.

A Sell Tgt must be entered first — you can't solve a cost without a selling price. If you try, you'll be told to enter a Sell Tgt.

### PO History and PPK pack explosion

The **📋 PO Hist** popover lists one row per past purchase order for the style — PO#, vendor, qty ordered/received, **Pack**, unit price, date, and status. Where a PO was a prepack (a pack of multiple units), its pack price is **exploded to a per-unit figure** so a pack purchase doesn't inflate the per-unit cost; the **Pack** column shows the pack size that was used. The footer reads "Unit $ is per-unit (pack prices exploded by pack size)."

### LY / T3 comparison

The **LY** (last year) and **T3** (trailing 3 months) columns pull cost, sales price, and margin from your sales history for the style. Both the base style and its prepack variants contribute, with pack rows exploded to per-unit so prepack pricing doesn't skew the average.

- **Single-unit (qty = 1) sales are excluded** from the comparison. One-off pieces (samples / direct-to-consumer, often priced well above wholesale) aren't representative and were skewing thin windows. Multi-unit packs are kept (a 1-pack prepack explodes to its unit count). If a style/color had no representative wholesale sales in a window, the comp shows **—** rather than a misleading number.
- The **Comp period** date range in the toolbar overrides the default windows; both ends must be set for the override to take effect. The preset chips (LY / This Month / Last Month / …) fill it for you, and **reset** returns to the defaults. The comp recomputes automatically a moment after you change a line's style, color, vendor, or the period.

### Per-line status

The **Status** pill shows where the line is. Most states are set automatically by the RFQ workflow and are read-only: **Sent**, **Quoted**, **Awarded**, **Lost**, **Revised**. You can manually set only **Draft** or **Closed** — picking Closed deliberately retires the line; picking Draft resets it. An **Awarded** line renders its whole row in green so winners stand out.

### The incomplete-row guard

A row is **incomplete** if it's missing any of: **style, color, vendor, qty, cost** (Tgt DDP Cost in DDP mode, or a target/FOB cost otherwise), or **Sell Tgt**. Incomplete rows can't be sent to a vendor. You'll be warned — with the choice to **delete the incomplete rows and continue** or **go back and fix** — when you:

- click **Vendor RFQ** with an incomplete row ticked, or
- leave the project (the **← Projects** button, or closing the tab).

The warning lists each incomplete row and exactly which fields it's missing.

### Documents on a line

The **📎** button in the **Docs** column opens a document panel for that line (spec sheets, tech packs, reference images, lab dips, or any kind you type). Uploads keep their original filename. A badge shows how many files are attached.

> **Attaching a document to a line whose RFQ was already sent counts as a revision** — the vendor is notified and the line is flagged Revised. Attaching to a draft line (not yet sent) is normal and triggers nothing.

## RFQ workflow

### Sending an RFQ

1. Tick the checkbox on each row you want to quote, then click **Vendor RFQ**. This creates **one RFQ per vendor across the selected lines and sends it to the vendor in the same step** — there is no separate "Send" click. Each vendor is invited and notified (in-app bell + email) immediately, and the RFQ shows up in their portal right away. The toast confirms, e.g., "2 RFQs sent to vendor".
2. The **target unit price** the vendor sees on each RFQ line matches the project's cost basis — **Tgt DDP Cost** for DDP projects, **FOB cost** for FOB/Landed projects (falling back to the target cost if FOB isn't filled). It is **never** the sell price. Editing the costing line's cost re-syncs the target onto any RFQ already generated.
3. If an RFQ already exists for the same **style / color / vendor**, you're asked to confirm before a duplicate is created.
4. Lines with no vendor picked are skipped (you'll see how many).

### The RFQs tab

The **RFQs** tab lists every RFQ. Columns include **Code** (an auto-generated `RFQ-00001`-style code), **Title**, **Vendor**, **Customer**, **Project**, **Lines**, **Est Qty**, **Est Budget**, **Target Cost / Unit** (shown per-unit to two decimals), **Status**, **Due**, and **Created**. Sort by any header.

- The search box matches on vendor, customer, style, and RFQ title.
- **Clicking a row** opens the RFQ's **source costing project in a new tab** (so you can edit lines and regenerate). Clicking the **Code** or **Title** link opens the RFQ editor itself.
- Per-row actions: **Send** / **Re-send** (publish + notify the vendor; idempotent), **Award** (offered once published), and **Delete** (permanently removes the RFQ, its lines, invitations, and quotes).
- Tick rows to get bulk **Send N selected** and **Delete N selected** buttons.

### The RFQ editor

Opening an RFQ shows its header context (vendor(s), customer, source project, line count, currency, created date), a read-only header form, and the read-only line items. Most header fields are backfilled from the source costing project and can only be changed back on the project — only **Status** and **Payment terms** are editable on the RFQ itself. The line items (description, fabric, fit, closure, scale, waist, qty, target cost, comments) are read-only here; to change them, edit the costing project and regenerate.

The editor also carries:

- A **Send to Vendor** / **✓ Sent · Re-send** button and an **Award** button (which unlocks once the vendor has submitted a quote).
- A **↶ Back** undo button that steps back through your last few header edits.
- The **vendor quote comparison** for this RFQ.
- A **private per-vendor message thread** — pick an invited vendor and exchange messages with them.

### Awarding

Click **Award** (on the RFQ list row or in the editor) and confirm. Awarding requires the vendor to have a submitted quote. It notifies the vendor and the Production Manager, flows the awarded price into the costing project, and marks the RFQ (and the winning line) **Awarded**.

## Comparing quotes

The **Compare RFQs** tab lays every vendor quote for a project side by side. Pick a project from the searchable picker (only projects that have at least one vendor quote appear; the newest is selected automatically). For each RFQ you get a matrix: rows are line items, columns are the vendors that quoted, and each cell shows the quoted unit price plus the extended total.

The comparison points out the differences:

- The **cheapest unit price per line** is highlighted green with a ★, and each pricier cell shows its **% above** the lowest.
- A **Spread** column shows the max−min gap per line.
- Per-vendor footer totals show **Σ extended**, **Weighted margin**, and **Lead time · Valid until**.
- A summary line names the **Lowest total**, **Best margin**, and **Fastest lead** vendors (the cheapest and the best-margin vendor can differ — both are flagged).
- Vendor quote-level and per-line notes are surfaced (hover the 📝).

### The "Sell $" what-if

Each line in the comparison has a small **Sell $** box. It's seeded from the project line's Sell Tgt, and **margin = (Sell − quoted price) ÷ Sell**, coloured by tier (green ≥ 20%, amber 18–20%, red below). Editing **Sell $** is a **live what-if** — the per-cell and per-vendor margins recompute as you type, but the change is local to this view only and never writes back to the project line. (The vendor's own *target cost* — what they quote against — is set on the RFQ, not here.)

## Revisions

### When a vendor revises a quote

A vendor can reopen an already-submitted quote and resubmit. When they do:

- Procurement is **notified automatically** — in-app bell (in the Costing app) and email — with a title that calls out it's a revision (e.g. "…revised their quote (v2)") so you can tell it apart from a brand-new quote.
- The next time you **open that RFQ**, a banner and toast appear, the vendor's row in the comparison shows a gold **Revised v2** badge, and you can expand it to see current vs. prior prices, lead time, and per-line figures. Click **Got it** to dismiss; it won't nag again unless the vendor revises again.
- **What the vendor sees:** their own in-app + email confirmation, plus a read-only revision history on their RFQ page listing their prior versions. A vendor only ever sees **their own** history — never another vendor's quotes and never Ring of Fire's internal comparison.

> **A vendor attaching a document to an already-submitted quote also counts as a revision** — the quote is snapshotted, bumped a version, and procurement is notified, so a late document never slips by unseen. Attaching to a draft (not-yet-submitted) quote does not.

### When you revise a sent RFQ

If you edit a costing line that has already been sent — its target/FOB cost, qty, fabric, size scale, style, color, fit, and so on — the change syncs onto that vendor's RFQ line:

- A short while after you save (a brief window so rapid edits coalesce), you're asked whether to send the vendor an updated RFQ. Confirm and the line is marked **Revised**.
- The **vendor is notified** (bell + email). When they open the RFQ, a popup tells them it was revised, the changed line shows a **✎ Revised · date** badge, and **each changed value is shown in green** so they see exactly what moved.
- Only fields the vendor can see trigger a revision. Changing a **field the vendor never sees — such as Sell Tgt or Margin %** — syncs nothing and sends no revision. (That's expected.)

## Messages

The **Messages** tab is a global inbox of every sent RFQ × vendor conversation, so you can read vendor replies and start new messages without opening each RFQ one at a time. Conversations are **private per vendor** (one row per RFQ + invited vendor); unread threads carry a badge and sort to the top. Pick a conversation on the left and read/reply on the right — posting the first message starts the conversation and notifies that vendor. Use **Open RFQ →** to jump to the full RFQ. Search filters by project, RFQ, or vendor name.

## Masters

The **Masters** tab manages the small dropdown lists the grid uses: **Fit**, **Closures**, **Waist Type**, **Comment Templates**, and **Compliance Codes** (auto-seeded with common requirements like CPSIA, PROP65, FLAMMABILITY the first time it loads empty). It also shows two freeform lists — **Color Master** and **Vendor Master** — which simply mirror what you've typed in the grid and are **auto-pruned** by the system when the same color or vendor turns up in the canonical source data. Fabric is **not** managed here; the grid's Fabric cell sources from the Fabric Codes master directly.

## Exports

Every table has an **Export** button (Projects list, project grid). It produces an Excel file of exactly the rows currently shown, so filter or sort first to scope your export. The **project grid** export now ends with a **TOTAL row** that footers the numeric columns — total quantity, total cost, total sales, and the weighted margin % — matching the totals shown on screen at the bottom of the grid.

Search boxes throughout the app (the RFQ list search, the Messages inbox search) **select all their text when you click into them**, so you can retype a new search without first clearing the old one.

## Tips and gotchas

> **The header gates the grid.** If **+ Add row** is greyed out, a required header field is still empty — check the red-bordered fields and the warning strip naming what's missing.

> **Pick the payment term first.** It decides whether you see FOB build-up columns or a single DDP cost column. Switching terms mid-build changes the grid layout and which figure feeds margin.

> **The grid is your sheet; sources are read-only.** Avg Cost, PO History, and LY/T3 come from live purchase and sales data and never change when you edit a line. Awarding is the one action that pushes a price back into the project.

> **Margin works two ways.** Use **Margin %** to back-solve the cost (sell stays fixed); use **Sell Tgt Frm Mrgn** to derive the sell price (cost stays fixed). Typing a Sell Tgt by hand clears the Sell Tgt Frm Mrgn cell.
