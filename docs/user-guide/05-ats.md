# 5 — ATS (Available To Sell)

## What ATS is for

ATS is the sales team's **free-to-sell** view of inventory. For every style and colour it pulls together four things — what you have on hand, what's already committed to open sales orders, what's incoming on purchase orders, and how much is **available to sell in each future period** — so you can answer the question a buyer always asks: *"Can you ship me X, and when?"*

It's a fast, Excel-style grid built for promising stock. It is **not** an accounting system (that's Tangerine) and it doesn't change any inventory — it reads, projects, and exports.

**Open it** from the 🧩 Apps launcher in any suite app, or go straight to `https://<your-domain>/ats`. The top bar reads **ATS · ATS Report · Available to Sell**, followed by a live count of how many SKUs are showing and when the data was last synced.

> **Access:** ATS is gated per user. If you don't see the app tile, ask an admin to grant ATS access. Individual reports (in the green **Reports** menu) can also be switched on or off per user — see [Reports and exports](#reports-and-exports).

## Where the numbers come from

ATS combines three sources every time you open it. You only ever supply two of them by hand; the third arrives automatically.

| Number | Source | How it gets there |
|---|---|---|
| **On Hand** | Your **Inventory Snapshot** (a Xoro export) | You upload it (see [Uploading data](#uploading-data)) |
| **On Order** (committed) | Your **All Orders Report** (a Xoro export of open sales orders) | You upload it |
| **On PO** (incoming) | **PO WIP** (the Tanda app) | Pulled in live on every load — no upload needed |
| Style / colour / category / cost | The shared item master | Joined automatically behind the scenes |

> **On Hand is at colour grain.** Each grid row is one **style + colour** combination. ATS does not track per-size on hand in the main grid — if you need a size breakdown, use the **By Size Matrix** export ([below](#by-size-matrix)).

## Uploading data

Click **Upload Excel** in the top-right. The upload window asks for two files:

1. **Inventory Snapshot** — on-hand quantities by SKU.
2. **All Orders Report** — open sales orders by ship date.

Steps:

1. Drag each file onto its drop zone, or click the zone to browse. Accepted types: `.xlsx`, `.xls`, `.csv`.
2. A green tick and the file name confirm each slot is filled. The button at the bottom counts your progress (`1/2 ready`, `2/2 ready`).
3. Click **Process Files →**. The button notes "(PO data from PO WIP)" as a reminder that purchase-order numbers don't come from a file — they're fetched live from PO WIP.
4. A progress overlay shows the steps. You can **Cancel Upload** mid-way.
5. On success a green confirmation toast appears and the grid rebuilds.

> **Both files are required** before the Process button enables. There is no separate "purchased items" file any more — PO data always comes from PO WIP.

After processing, the **Upload Excel** button in the top bar carries a small badge (e.g. `2/2`) so you can see at a glance what's loaded.

### When a SKU can't be matched

If some uploaded rows don't match anything in the item master, an amber banner appears under the toolbar:

> ⚠ *N styles not in item master — these rows are hidden from the grid*

- Click **View list ▼** to see the unmatched SKUs. Click any SKU to copy it, or **Copy all** to grab the whole list.
- Fix the SKU in your inventory file, **or** add the style to the planning Item Master and re-upload.
- **✕** dismisses the banner for this session; it returns on the next upload if anything is still unmatched.

Unmatched rows are hidden from the grid (they have no category, cost, or colour to display), so the banner is your signal that the numbers may be incomplete.

### Reviewing SKU normalisation and merges

If your uploaded SKUs need standardising (spacing, casing, suffixes) ATS will surface a **review step** so the cleanup is never silent — you approve the changes before they're applied. Separately, you can **drag one grid row onto another** to merge two SKUs you know are the same item; a confirmation dialog shows the two codes and a similarity score before the merge sticks. Any merge you make can be undone from the **↩ Undo Merge** button that appears in the top bar (it counts how many merges are pending).

## Reading the grid

The grid is frozen on the left so the identity and summary columns stay put while you scroll the date columns sideways.

### Left (sticky) columns

| Column | Meaning |
|---|---|
| **Category** | Top-level grouping (from the master) |
| **Sub Cat** | Sub-category |
| **X** | Exclude checkbox. Tick it to drop that row from **every total, calculation, and report** — On Hand / On Order / On PO sums, ATS availability, the totals row, the stat cards, and all exports. The row stays visible (greyed) so you can untick it. Exclusions are saved and persist across reloads. See [Excluding rows](#excluding-rows-the-x-column). |
| **Style** | Style code |
| **Description** | Style description |
| **Color** | Colour |
| **On Hand** | Units physically on hand right now |
| **On Order** | Units committed to open sales orders |
| **On PO** | Units incoming on open purchase orders |

You can **hide any of these** columns and **freeze through** any of them — see [Tailoring the grid](#tailoring-the-grid). (The **X** exclude column is always shown.)

### Excluding rows (the X column)

The **X** checkbox between **Sub Cat** and **Style** lets you take a row out of play. Tick it and that row is **dropped from every number on the page**:

- the **totals row** (Qty / Cost / Sale / Margin / B-Inven / E-Inven),
- the **stat cards** (Total SKUs, Low / Zero stock, Negative ATS, Units on Order, SO / PO value, margin),
- the **On Hand / On Order / On PO** column totals and ATS availability totals,
- and **every report and export**.

The excluded row itself **stays visible** in the grid (greyed out, box ticked) so you can always find it and untick it. Its own per-row numbers still show — only the *roll-ups* ignore it. Exclusions are **saved** and persist across reloads (they're a shared business setting, like "these sample/discontinued styles don't count").

**Before any report or export runs**, if you have rows excluded you'll see a warning listing the excluded styles (style number + description) with three choices:

- **Continue** — run the report **without** the excluded styles (the normal case).
- **Include them** — count the excluded styles **just for this one report** (they stay excluded everywhere else).
- **Cancel** — don't run it.

### Date (period) columns

To the right of On PO are the **period columns**. Each one represents a slice of the future (a day, week, or month, depending on your range setting). What each cell shows depends on the **View** setting:

- **ATS** (default) — availability. The first period shows what's free to sell today (on hand minus everything already committed, never below zero); each later period shows the change as new receipts land.
- **On SO** — the quantity of sales orders falling in that period.
- **On PO Receipt** — the quantity of purchase orders expected to arrive in that period.

A **Total** column at the right sums the periods.

### Right-clicking for detail

Right-click any **On Hand**, **On Order**, or **On PO** cell (or a period cell) to open a detail popup:

- **On Hand** — average cost, total value, and last-received date.
- **On Order** — every committed sales order for that SKU, grouped by order number, with customer, customer PO, quantity, cancel date, unit/pack price, line total, and margin %. It also shows **T3** (trailing 3 months) and **SP LY** (same 3 months last year) sales history. Click an **order number** to open the full sales order with every line.
- **On PO** — every open purchase order, with vendor, expected date, quantity, and value. Click a PO number to **open it in PO WIP** in a new tab.

Each popup has an **✨ Ask Claude** button that asks the AI assistant about that exact row.

> **Prepacks (PPK).** For prepack styles, popups and totals show both grains — e.g. *"142 packs (3,408 units) · Avg $135.00/pack / 24 Each $5.63"* — so the per-pack and per-unit figures are always visible side by side.

## The status cards

A row of nine cards sits above the grid, summarising the **currently filtered** set:

| Card | Meaning |
|---|---|
| **Low Stock (≤10)** | SKUs with 10 or fewer units on hand |
| **Zero Stock** | SKUs with nothing on hand |
| **Negative ATS** | SKUs where commitments exceed on hand (you've oversold) |
| **Total SKUs** | Count of rows in the filtered set |
| **Units on Order** | Total committed sales-order units |
| **$ on Order** | Dollar value of those orders |
| **Units on PO** | Total incoming purchase-order units |
| **$ on PO** | Dollar value of incoming POs |
| **Margin** | Blended margin dollars and % across the set |

Click **Low Stock**, **Zero Stock**, **Negative ATS**, **Total SKUs**, or **Units on Order** to filter the grid down to just those rows. Click the active card again to clear it (or use **✕ Clear all** in the toolbar).

## Filtering and searching

The toolbar holds every control for narrowing and shaping the grid. All filters apply **as you type / click** — no Search button to press.

| Control | What it does |
|---|---|
| **✕ Clear all** | Resets search, all filters, store (back to ROF), and collapse. **Keeps** your date range and units — those describe the planning horizon, not a filter. |
| **Search SKU or description** | Free-text match on SKU code or description |
| **Category / Sub Cat / Style / Gender / Brand** | Multi-select dropdowns. Each shows a search box; tick as many as you like. The header reads *All*, the one name, or *N selected*. Click the **×** in the header to clear that filter. Gender labels read Mens / Boys / Child / Women's / Girls, and are read from the **item master** (the gender set in Tangerine / Xoro) rather than the upload feed — so a style filters under its correct gender even when the inventory export leaves the per-row Gender column blank. **Brand** lists every brand from the Tangerine app (Ring of Fire, Psycho Tuna, Axe Crown, …) and matches each row to **its style's brand as set in Tangerine** (the Style Master) — so e.g. Psycho Tuna styles filter correctly even though the underlying Xoro catalog labels everything Ring of Fire. |
| **Collapse** | Roll rows up to **Category**, **Sub Cat**, or **Style** subtotals (or **None** for full detail). A **Style** subtotal row shows that style's description (e.g. *LAIDBACK Baggy Fit*); Category / Sub Cat rows, which span many styles, show an *(N items)* count instead. Click the **▶** to expand a group back to its rows. |
| **Store** | Tick which sales channels to include — **ROF**, **ROF ECOM**, **PT**, **PT ECOM**, or **All**. Defaults to **ROF**. |
| **Min ATS** | Hide any row whose availability is below this number in **any** visible period |
| **Cust/Vend** | Narrow the grid to a single customer (from sales orders) or vendor (from POs) |

### The On-Order date window

A dedicated **On-Order from … to …** control scopes **only** the On Order total/column to sales-order lines whose **cancel date** falls in the range. Use it to reproduce a date-windowed "open orders" total without touching the availability projection. When a date is set the control turns amber so it's obvious the On Order numbers are scoped. Click **×** to clear it.

> This date is the order's **cancel date** (the Xoro "Date to be Cancelled"), not the ship date.

### Setting the planning horizon

Two controls define how far out the period columns reach:

- **From** — the start date of the projection.
- **Show N Days / Weeks / Months** — how many periods, and at what granularity. Switching units resets to a sensible default (14 days, 2 weeks, or 1 month).

## Tailoring the grid

| Control | Effect |
|---|---|
| **View** | ATS / On SO / On PO Receipt — see [Date columns](#date-period-columns) |
| **TOTALS** | Show a totals strip above the headers with Qty, Cost, Sale, and Margin summed across the filtered set |
| **EXPLODE PPK** | On (default): show prepacks as **units** (5 packs of a 24-pack = 120). Off: show **pack counts** with a faded "PPK24 = 120" hint |
| **IMAGES** | On (default): show a small **style image thumbnail** on each row inside the Style column, colour-matched to the row's colour when that colour has its own picture. Click a thumbnail to open the full image gallery — **enlarge, download, or print**. Images come straight from the Tangerine PIM, so styles gain pictures automatically as they're added there; styles with no image show a blank tile. Off: hide thumbnails for a denser grid. |
| **Freeze through …** | Pin the sticky columns up to and including the one you pick, for horizontal scrolling |
| **Columns** | Show or hide any individual sticky column (Category through On PO). A badge shows how many are hidden; **Show all columns** resets |
| **MARGIN %** | (Visible only with TOTALS on) The target gross margin used as a fallback in the totals row when a SKU has no sale price or cost. Default 21%; it lights up blue once you change it |

> **Why isn't there click-to-sort on the columns?** The ATS grid has frozen columns and running per-period maths, so a naive row re-sort would fight that. Ordering is driven by the filter, collapse, and status-card controls instead.

## Reports and exports

Every report lives under the green **Reports** menu (top-right). Each one opens a **View** preview first — you see the workbook on screen, then click **Download** to save the `.xlsx`. Exports are branded with the Ring of Fire logo and carry the US (MM/DD/YYYY) date format used across the suite.

| Report | What it gives you |
|---|---|
| **Export Excel…** | The full grid with options (below) |
| **Neg Inven** | Rows where on hand can't cover committed orders |
| **Aged Inven…** | On-hand inventory older than a days threshold you choose, optionally by category |
| **NO Mrgn Data** | Styles with no open SO, no average cost, and no PO cost (the rows that show a red *Mrgn:** asterisk) |
| **Stock Vs SO** | Per-sales-order breakdown: what fills from stock, from incoming PO, or needs a new PO |
| **Sales Comps…** | This-year vs same-period-last-year for a date range and filters you pick |

> If you don't see some entries, an admin has turned those reports off for your account under User Management.

### Export Excel options

Choosing **Export Excel…** opens an options panel. Tick what you want, then **View** (preview) or **Export** (download):

> Export works on **any** grid view. Collapsing the grid (Category / Sub Cat / Style) is display-only — the export and every report always run over the full filtered SKU list, and prepack quantities follow the **EXPLODE PPK** toggle, regardless of how the grid is collapsed.

- **Subtotals (per style)** — subtotal rows per style.
- **Avg Cost** — adds Avg Cost and Total Cost columns.
- **Sls Prc @ Margin** — adds the implied **Sls Prc** (price = cost ÷ (1 − margin)) and a **Mrgn %** column. All variants of a style show the same price (the highest implied across the style, so nothing is under-priced) — a single wildly-out-of-line cost is ignored as a likely data error so it can't inflate the rest.
- **Trailing 3 & SP LY sales** — adds quantity / sale price / margin for the last 3 months and the same period last year.
- **Customer Facing** — strips **every** cost and margin column (Avg Cost, Total Cost, Sls Prc @ Mrgn, T3/LY Mrgn %), so the workbook is safe to send to the customer.
- **Buyer worksheet** — the live internal **pricing tool** (shows cost — *not* for customers). Adds an **Avg Cost** column, an editable **Sls Prc**, a **Mrgn %**, and a **Total $**, where **Mrgn % and Total $ are live Excel formulas**: type a new sale price into a Sls Prc cell and the margin % and total recalculate instantly. The live formulas run on **every** row — including the per-style **subtotal** rows and the bottom **grand-total** row (when the **Subtotals (per style)** toggle is on) — so editing a subtotal/total Sls Prc recomputes its margin and total too. Uses the **Margin %** you set as the starting price. Mutually exclusive with Customer Facing.

> **Total column alignment:** the **Total** column's numbers are right-aligned across every report (main grid, Aged Inventory, Negative Inventory, Stock-vs-SO, Incomplete, Sales Comps, By Size Matrix) so the column reads consistently.
- **Hide zero columns** — drops any data column that's entirely empty.
- **By Size Matrix** — adds the size breakdown worksheet (below).
- **Hide ATS data** — drops the date/availability columns and keeps the identity + history blocks (useful for a pure sales-history pull). This mode lets you set a **custom date range** for the trailing/last-year windows.
- **By Customer** — narrows the trailing / last-year blocks to one customer.

> The first export of a session fetches up to 15 months of sales history and shows a *"Loading sales history…"* overlay — you can **Cancel** it. Later exports in the same session reuse the cache and are instant.

### By Size Matrix

Turning on **By Size Matrix** adds a worksheet that pivots ATS availability into a **colour × size** grid, with a separate **PPK** pack column and one tab per selected period. The size split is an estimate distributed from the on-hand/incoming size shape, but the totals **tie exactly** to the main colour-grain report.

## Sales Comps

**Sales Comps…** is an interactive this-year-vs-last-year comparison:

1. Pick a **date range** (the modal opens on **year-to-date through today**, so shipped sales appear immediately — the grid's own forward-looking availability window is *not* inherited, since a future window has no shipped sales by definition).
2. Narrow by category, sub-category, style, store, gender, or customer — pre-populated from your grid filters, and broadenable beyond them. The **Style** picker lists **every style in the item master — including sold-out styles that have no row on the ATS grid** — as *code — description* (e.g. *RYB1416 — ARENA Loose Relaxed*) — the dropdown widens to show the full description — and its search box matches on either, so you can find a style by name as well as number. That means you can run comps on a style that has fully shipped through (zero on-hand, no open orders) and still see its sales history.
3. Choose **Summary** or **Detailed** output.
4. The results show totals for quantity, revenue, cost, margin $, and margin %; Detailed mode adds a per-SKU table sorted by largest revenue, plus a section comparing your open sales orders against last-year shipments of the same style. When viewing **by Style**, each row shows the style **description** next to its code.
5. **Download** to save the comparison as a branded workbook.

## Notifications and Ask AI

- **🔔 Notifications** (top bar) opens the in-app notification feed; a red badge counts unread items.
- **✨ Ask AI** opens a chat assistant that can answer questions about the grid in front of you and even apply filters or sorts for you. You can also launch it from the **✨ Ask Claude** button inside any right-click detail popup to ask about one specific row.

## A typical day

1. **Open ATS** and check the **Synced** time in the header. PO data is always live; on-hand and orders are as fresh as your last upload.
2. If your Xoro exports are newer, click **Upload Excel**, drop in the **Inventory Snapshot** and **All Orders Report**, and **Process**.
3. Clear any **unmatched-SKU** banner by fixing or adding those styles.
4. **Filter** to the customer, category, or styles you're working a deal on. Set the **horizon** (From + Show) to cover the ship window.
5. Read **availability** in the period columns. Right-click cells to see who's already committed and what's incoming.
6. Watch the **Negative ATS** card — anything there is oversold and needs attention.
7. **Export** what the customer needs: a **Customer Facing** workbook to send out, or **By Size Matrix** when they want the size split.

## See also

- **PO WIP (Tanda)** — the source of the On PO numbers; click any PO in ATS to open it there.
- **Inventory Planning** — consumes the ATS on-hand snapshot as its supply source.
