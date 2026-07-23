# 7 — Inventory Planning

The **Inventory Planning** app is where ROF planning and merch staff turn sales history into a forward demand forecast, net that demand against what's already on-hand and on order, and produce a defensible **buy plan**. It is a standalone app reached at `/planning`, with one screen per stage of the planning cycle.

This chapter is for the people who actually run the plan each season — it walks every screen, every editable cell, and the data feeding them. You do not need to know where the numbers are stored; you do need to know which button commits which change.

## What the app is for

The planning cycle the app supports, in order:

1. **Forecast** demand — wholesale (by customer/style/color/period) and ecom (by SKU/week).
2. **Reconcile** that demand against supply — on-hand, open purchase orders, and incoming receipts — to surface shortages and excess.
3. **Recommend** buys — the system emits buy recommendations wherever projected inventory falls short.
4. **Model** alternatives — what-if scenarios let you tune assumptions and compare against the base plan before committing.
5. **Execute** — gather approved recommendations into a buy plan, export it to Excel, or hand it to Tangerine as draft purchase orders.

> The plan is built around **planning runs**. A run is a named forecast over a date horizon (e.g. "Wholesale — 2026-06"). Almost everything you do — building a forecast, overriding a quantity, reconciling supply, creating a scenario — happens *inside* a run. Pick or create a run before you expect to see data.

## Getting in: access and the Beta gate

Two checks must both pass before any `/planning/*` screen will open:

| Check | What it means if you fail it |
|---|---|
| **Planning app permission** | Your user account must be granted access to the Planning app (the same per-user app permission used across the suite). Without it you see an "Inventory Planning — no access" block. |
| **Beta allowlist** | While the app is in **Beta**, access is restricted to an email allowlist. If you're signed in but not on the list, you see a "Planning is in Beta" block. |

When the app is in Beta, the Planning card on the PLM home launcher carries a small amber **Beta** badge so you know it's not yet general-availability. If you can open `/planning` from the launcher card, you have both checks satisfied.

> If a colleague can see Planning and you can't, the difference is almost always the Beta allowlist, not a bug. Ask the operator to add your work email.

## The shell: every screen's chrome

Every Planning screen sits inside a common header (the "Planning shell"):

- A collapsible **left navigation drawer** — the same shared drawer the other suite apps (GS1, Costing, Design Calendar) use. It lists every Planning screen (Wholesale, Ecom, Supply, Scenarios, Accuracy, Execution, Reports, Data quality, Admin); the current screen is highlighted. Collapse it to a thin icon rail with the ⟨ toggle; the choice is remembered. **← PLM** (back to the home launcher) lives in the drawer's footer.
- The current screen's name in the header (e.g. "Wholesale Planning", "Supply Reconciliation"). The browser tab title follows it too, so multiple Planning tabs are easy to tell apart.
- **✨ Ask AI** — a chat assistant (top-right). Ask it about forecasts, shortages, recommendations, lead times, or how to use a screen. It reads live planning data and this guide; it never invents figures.
- **🔔 Notifications** — planning-relevant alerts, with an unread badge.

Move between screens from the **left drawer** (or by editing the URL path directly). *(The old in-workbench top menu bar — the "IP" logo row with Ecom / Supply / Scenarios / Reports links — has been removed; the drawer is now the single navigation surface.)*

## Where the numbers come from

Planning reads its own data set, fed nightly and on demand from the other ROF systems. You do not enter raw sales or inventory by hand.

| Input | Source | Notes |
|---|---|---|
| **Wholesale sales history** | Xoro invoices | Pulled nightly ("Last Calendar Year to Date"). A manual **▶ Fetch all Xoro sales** walk exists for back-history beyond the nightly window. |
| **Ecom demand** | Shopify orders | Shopify is the source of truth for ecom; refunds fold back into the same SKU/week as returns. |
| **On-hand** | ATS snapshot | The ATS app's persisted Excel snapshot, at color grain. Refresh mid-day with **Sync on-hand (ATS)**. |
| **Open POs (incoming)** | PO WIP (Tanda) | Open purchase-order lines; each PO's arrival month comes from its Tanda "In House / DDP" milestone. Refresh with **Sync open POs (TandA)**. |
| **Item master** | Xoro products | Style/color/description/avg cost; new items arrive in the nightly master sync. |

> **You normally don't press the sync buttons.** The nightly pipeline already refreshes sales, on-hand and open POs at 21:00. The on-screen **Sync on-hand (ATS)** / **Sync open POs (TandA)** buttons are mid-day top-ups for when you can't wait for tonight's run.

## The Wholesale screen (the app home)

`/planning` or `/planning/wholesale` — the main planning grid. This is the largest and most-used screen.

### Picking or creating a run

The **Planning run** card at the top of the grid is your starting point:

1. Use the **run dropdown** to pick an existing run (each option shows name · status · horizon dates).
2. Or click **+ New run** to create one — name it, set a **Horizon start/end** (the months to forecast) and a **Snapshot date** (the on-hand cut-off), then **Create run**.
3. With a run selected, click **Build forecast** to compute the forecast for every (customer, SKU) pair in the run.
4. **Edit run** — change a run's **name**, **Horizon start/end**, **Snapshot date** or note after it's created. If the run is already built, changing the horizon makes the existing forecast stale, so the modal offers **Save & rebuild** — it saves your changes and then opens the usual rebuild dialog (preserve edits vs. wipe + rebuild) so the forecast recomputes for the new dates.

> **Vendor (cost source) at build time.** Next to the Build button is a **Vendor** dropdown, defaulting to **— Any vendor —**. The same style is often bought from more than one vendor at a different true cost (e.g. a camo prepack at **$121.20/pack** from one vendor vs **$122.16/pack** from another). Pick a vendor here and the grid populates each row's **Unit Cost vendor-first** — see the cost-precedence note under *Reading and editing the grid*. The choice is saved **on the run**, so rebuilds and reloads keep using it, and an active vendor shows as a **Vendor cost: …** chip on the toolbar. Leaving it on **— Any vendor —** keeps costs exactly as before. A vendor that has no purchase orders for a style simply doesn't match — the row falls back to its normal cost; picking a vendor never blocks a build. *(The list shows only vendors you actually have POs with.)* The build vendor also becomes the **vendor on any draft PO** this plan later creates — see *Execute* below.

> **If a build reports "0 rows"** it means the build scope matched nothing — almost always a **grid filter left active** (the button reads **Build (filtered)** instead of **Build forecast**), or a **period filter whose months fall outside the run's horizon**. Clear the grid filters and check the run's horizon dates, then rebuild. (A period filter that doesn't overlap the horizon is now ignored with a warning rather than silently producing an empty build.)

### Forecast method

Above the grid, pick the baseline method the build uses:

| Button | What it does |
|---|---|
| **Same Period LY** | Uses last year's sales for the same period as the baseline. |
| **Weighted Recent Demand** | Weights recent months more heavily. |
| **Reorder Cadence** | Drives the forecast from how often the SKU historically reorders. |

### Reading and editing the grid

Each row is a customer × style × color × period demand line. Columns can be shown or hidden with the **Columns** button. Flip **Totals: ON** (above the grid) to show a **sum under each numeric column header** for the rows currently in view — demand and buy columns sum per row, while the other supply columns (On hand / On SO / Receipts) are counted once per SKU-period so a SKU shared across customers isn't double-counted. The **Hist T3/6/9/12** total counts each customer + style line's trailing window **once** (at its latest month in view), not once per month — the same history repeated across 8 horizon rows is still one history. **SP/LY** stays a plain sum: each month's same-period-last-year is its own number, so the column total is the true horizon LY. The **ATS** and **On Hand** totals are different: both are *rolling* balances carried month to month (each period's On Hand is the prior period's ATS), so each total is the **ending figure of each style/color group exactly as displayed in the column, summed** — read the latest-period cell of each style/color and add them up (RYB0412PPK Black ending 5,000 + the next style's ending figure, and so on). They always agree with the numbers on screen and follow your filters — narrowing the period filter moves each group's ending point with it.

> **Category, Sub Cat, Gender and Season come from Tangerine's Style Master.** The grid's **Category** column is the Style Master's *Category* (e.g. SHORTS), **Sub Cat** is its *Sub Category* (e.g. CARGO SHORTS, DENIM SHORTS), **Gender** uses its *Gender* code (Mens / Womens / Boys / Child / Girls) and **Season** its *Season* — the same values you see and edit on Tangerine's Style Master screen, so re-categorizing or re-tagging a style there flows straight into planning (rows, filters, build scoping and reports included) on the next load. (Denim shorts live under SHORTS → DENIM SHORTS, while Category DENIM holds the jean fits.) Season is only as complete as the Style Master — styles you haven't tagged yet simply don't appear under a season.

### The filter bar

The filters sit in three rows above the grid:

1. **Customer · Season · Category · Sub Cat · Gender · Style · Color**, then **Clear** (green) · **Confidence · Methods · Actions · Periods**. On a narrower screen the filters shrink together (up to 15%) to stay on one line rather than wrapping; narrower still and they wrap as before.
2. **Totals · PPK inherits base · Explode PPK · Zero-qty rows · System suggestions**, then the **search box**.
3. **Shift Buyer ◀ 1 mo** (with its *customers* picker) · **Copy Final → Buy** · **Hist T3/6/9/12** · **Freeze through…** · **Columns**.

Directly above the grid: **+ Add row**, then **Collapse**, then **Carton qty**.

> **The first seven filters are interdependent.** Customer, Season, Category, Sub Cat, Gender, Style and Color all narrow one another: whatever you pick, every other dropdown re-scopes to only the values still reachable — in **both** directions. Picking Category SHORTS → Sub Cat DENIM SHORTS leaves only the genders Tangerine files under denim shorts (Mens / Boys / Girls); picking a **Style** narrows the **Customer** list to whoever actually buys it. On a run you haven't built yet the product filters still cascade (from the Style Master) so you can scope a filtered build up front; Customer and Color populate once the run is built, since those only exist as real demand. **Clear** resets the search box and every filter at once. Stock-buy (TBD) rows also display the **live** Style Master category — not the value captured when the row was created — so a Tangerine re-categorization updates existing planning rows too.

> **Supply flows in month order no matter how you sort.** The rolling supply chain (On Hand inheriting the prior month's ATS, per style/color) is computed **chronologically per style/color**, independent of the on-screen sort — sorting by Period, Customer, or anything else never resets the flow.

> **Stock-buy (TBD) rows show the family's history.** A planner-added stock-buy row displays **Hist T3/6/9/12 and SP/LY** aggregated across every SKU of its style + color (pack and each grain combined) for that customer — so a prepack stock-buy on a style the customer has bought for years shows the real history, not zero. Genuinely new colors with no sales still show 0/–. The key columns:

| Column | Meaning | Editable? |
|---|---|---|
| Category / Sub Cat / Style / Description / Color / Customer / Period | The dimensions of the row | TBD rows only (see below) |
| Class | Style classification | No |
| Hist T*n* / SP/LY | Both are **per horizon month** (not one flat figure): **SP/LY** = that month's same-period-last-year units (a Dec row → last Dec, a Jan row → last Jan); **Hist T*n*** = the trailing *n* months *through* that month's same period last year. The **Hist T3 / T6 / T9 / T12** selector above the grid switches the window (default T3) — instantly, no rebuild — and the column header + totals follow. So both slide with the horizon and reflect real seasonality | No |
| Margin % | Gross margin on the line | No |
| **System** | The system's forecast suggestion — **type to override it** | **Yes** |
| Buyer | Buyer-requested future demand | Via Future Demand Requests |
| Override | The adjustment you've made | derived from System edits |
| Final | The committed forecast — the **live sum of System + Buyer + Override** (floored at 0). It recomputes the instant you edit any of those cells, so it always reflects the columns to its left. | No (computed) |
| Conf. / Method | Confidence band + method used for the line | No |
| On hand / On SO / **Receipts** / **Hist Recv** / **ATS** | Supply context. **Receipts** = incoming units still due (open POs landing in that period); **Hist Recv** = units already received historically in that period. See *Where receipts come from* below. | No |
| **Buy** | Your planned buy quantity for the line | **Yes** |
| Avg Cost / **Unit Cost** | Cost per unit (Unit Cost overrides Avg Cost for this line) | **Unit Cost: Yes** |
| Buy $ | Buy × Unit Cost | No (computed) |
| Short / Excess | Shortage / excess vs supply | No |
| Action | The recommended action (buy / hold / monitor / reduce / expedite) | No |

**Where receipts come from.** The **Receipts** (incoming) column is derived from the PO WIP app's open purchase orders. **Hist Recv** (historical) now uses the **real goods-in date** from Xoro's item-receipt records whenever one exists, and falls back to the expected-arrival proxy only for lines with no receipt document yet.

- **Receipts** (incoming) = the still-open quantity on purchase orders whose expected arrival lands in that period.
- **Hist Recv** (historical) = the received quantity on POs that have already landed, bucketed into the period the goods **actually arrived**. Tangerine now pulls Xoro's item receipts (the true received date per PO line) each night, so a line received in, say, mid-February shows in February — not in the month it was *expected*. For older lines that pre-date the item-receipt feed (or POs Xoro hasn't formally received), Hist Recv falls back to the PO line's **expected/delivery date** as before. A line received across several physical deliveries is dated to its **first** goods-in. Both the real-date pull and the historical-receipt refresh run every night alongside the open-PO sync.

**Editing cells:**

- **System** — type a whole number to override the suggestion; the cell turns yellow + italic and remembers who changed it from what (hover for the audit note). **Clearing the box sets System to 0** (so **Final** drops to Buyer + Override) — use this when you want to remove the system forecast from a row. To bring the suggestion back, **re-type the suggested number** (the tooltip always shows it).
- **Buy** — type a planned buy quantity (comma-formatted when idle, e.g. "10,000"). Clearing it removes the planned buy. To seed the whole plan at once, use **Copy Final → Buy** (above the grid): it sets Buy = Final forecast for every row currently in view (matching your filters/search), so you can start from the forecast and adjust from there. It only touches rows in view and asks to confirm the count first.

> **Shift Buyer ◀ 1 mo.** This toolbar button moves stock-buy rows' **Buyer** quantities to the **prior month** — the whole schedule slides one month earlier, per style + color (e.g. April **1,200** → March **1,200**). The last month empties, and if the earliest month carries a quantity it creates the month before it. **Buy, System and Override are left unchanged.** It asks to confirm first and refreshes the grid when done.
>
> **Choose which customers to shift.** When more than one customer has stock-buy (TBD) rows, a **Customers to shift** picker appears next to the button. Pick any combination — e.g. shift only **Ross Procurement**, or Ross *and* Burlington together — and the button applies to just those. Each customer's schedule shifts independently (two customers sharing a style/color never merge). With only **(Supply Only)** rows present, the picker is hidden and the button behaves exactly as before.
- **Unit Cost** — click the cell, type a cost, Enter to commit / Esc to cancel. **A typed cost applies to the whole style + color at once**: entering e.g. **5.70** on one RYB0412PPK / Black row fills every RYB0412PPK / Black row in the run (all months, all customers) — a toast confirms how many rows were updated. Clearing the cost on any one of them reverts the whole group to the auto-resolved cost.

> **Unit Cost auto-fills on stock-buy (TBD) rows too.** A planner-added stock-buy row resolves its cost through the **same cascade as regular rows**: the SKU's own average cost → a **sibling color's** average cost in the same style → the style's **open-PO price** (per-pack for PPK styles, per-each otherwise). You only need to type a cost when the style has no cost signal anywhere; a typed cost always wins and shows in *italics* like any planner override. Clearing the typed value reverts to the auto-resolved cost. Buy $ fills in as soon as a cost resolves.

> **Cost precedence when a Vendor is selected.** If you pick a vendor in the **Vendor** dropdown at build time, Unit Cost is resolved **vendor-first**, in this order: **(1)** the cost from that vendor's **open POs** for the style/color, then **(2)** that vendor's **most-recent received PO** (a price guide), then **(3)** the normal average cascade (own avg → sibling-color avg), then **(4)** any-vendor open-PO price. With **— Any vendor —** selected, only tiers 3–4 apply — identical to how costs worked before. The vendor tiers are grain-aware just like the rest (per-pack for PPK, per-each for base garments). Change the vendor and **rebuild or reload** to see the new costs.

> **Prepack (PPK) styles round up to full packs.** On a PPK style, any quantity you type into **System / Buyer / Override / Buy** is rounded **up to the next whole pack** when you commit it (Tab / Enter / click out) — e.g. on a **PPK-24** style, entering **1,190** becomes **1,200** (50 packs). This keeps the plan orderable in whole prepacks. The pack size comes from the SKU/size **PPKn** token when present, otherwise from the style's **Prepack Matrix in Tangerine** — so digit-less styles like `RYB0412PPK` round up too. A **⚠** on a PPK style means no pack size could be found (no `PPKn` token and no Prepack Matrix in Tangerine); set up its matrix in Tangerine to enable pack rounding + conversion.

> **Carton qty (non-prepack styles).** The **Carton qty** box in the toolbar (default **24**) rounds every quantity on a **non-prepack** style UP to the next whole carton — System, Buyer, Override, Final and Buy, both in what the grid shows and when you type into a cell. So with Carton qty 24, a system forecast of **100 becomes 120** (5 cartons). Prepack (PPK) styles ignore this and keep rounding to their own pack size. Set Carton qty to **0 or 1** to turn the rounding off. The value is remembered per browser.

> **Explode PPK toggle (packs vs. eaches).** The **Explode PPK** button above the grid switches the whole grid between two grains. **ON** (default) shows everything in **selling units (eaches)**. **OFF** shows everything in **pack grain**: supply, demand, Buy and demand-history all read as **pack counts**, and the demand/Buy cells are **editable in packs** — type **50** on a PPK-24 row and it stores **1,200** eaches (50 × 24). Flip the toggle any time; a value entered as 1,200 eaches with Explode ON shows as 50 with Explode OFF.

> **PPK inherits base toggle.** A prepack (PPK) style has no sales of its own — all the demand and history live on the base garment (e.g. RYB0412's sales, not RYB0412PPK's), so a plain build leaves the PPK rows empty. Turn **PPK inherits base: ON** (button above the grid, default OFF) and every prepack row shows the **base garment family's** System / Final / SP·LY / Hist T3-12 for the same color and period — so you can plan a prepack buy against real demand. It works even when a run was built with **only** the PPK styles selected (the reference comes from the family's sales, not from base rows being present). Both the base and the PPK rows stay visible, and the column **totals dedupe by family** so seeing the demand on both grains never doubles the total — the total still reflects the real (base) demand once, and you enter your prepack **Buyer / Buy** on the PPK rows as usual. Flip it off any time to return to the plain view.

> **"No rows match your filters" with stale selections.** Your filters are remembered per browser — if the catalog is re-categorized after you saved them (e.g. a Category renamed), a saved selection can suddenly match nothing and the grid comes up empty. When that happens the empty state now **names the stale selections** (e.g. `Category "DENIM"`) and offers **Remove stale filters**, which strips only the outdated values and keeps the rest of your filters.

> Overrides are remembered per row. A normal **Rebuild (preserve edits)** keeps your Buyer / Override / Buy / Unit Cost edits on rows that get recomputed. Only a **Wipe + rebuild** discards them (see below).

### TBD stock-buy rows

Some buys aren't tied to a known style yet — you're buying ahead into stock. These appear as **TBD** rows, and on a TBD row the dimension cells *are* editable:

- **TBD style** — click the style cell to pick any style in the same category, type a brand-new style code (flagged **NEW** in amber until the item master catches up), or revert to the catch-all **TBD** slot.
- **TBD description / customer / color** — likewise editable inline so you can flesh out the line as the buy firms up.

A row whose style isn't yet in the item master shows an amber **NEW** badge; it auto-clears once a future build sees that style in the master.

> **+ Add row** creates TBD rows in bulk. **Customers**, **Periods**, and now **Colors** are all multi-select — each combination becomes its own row. Pick your color(s) with the color picker (existing colorways or type a brand-new one, added as a removable chip); pick the customers and periods; the confirm step tells you exactly how many rows will be created (customers × periods × colors). Leave colors empty for a single **TBD**-color row.
>
> After you add, a confirmation banner names the batch — e.g. *"Added 4 rows: Navy Camo · Ross Procurement · Mar–Jun 2027"* — with a **Show them** button. Click it and the grid filters to exactly those rows (all periods and customers in the batch) so you can fill them in together; clear the filters to return to the full grid. The just-added rows are **no longer pinned to the top** — use **Show them** whenever you want to jump back to them. (If a color you typed is already saved in the company database for that style, there's nothing to add and no **Add to DB** button appears — that's expected; the row itself is still saved to the run.)

> **↶ Undo** in the toolbar reverses your **+ Add row** actions — up to the **last 4** batches. The button shows the depth (`↶ Undo (3)` means three adds are still undoable). Each press removes the *entire* most-recent batch — every customer × period × color row it created for that style/color — and refreshes the grid. Editing a TBD row's customer, color, or style, or switching to another run, clears the undo history.

### Buyer vs LY and Buy vs LY reports

These two reports live under **Reports** in the left menu (Planning → **Reports**). The Reports page is a **selection screen** — pick a report card (Buyer vs LY, Buy vs LY, Sales Performance, Inventory Health, Forecast Accuracy, Buy Plan & Supply) to open it, and use the **✕** or **Close** button at the top to return to the report list. For Buyer/Buy vs LY, pick a planning run at the top and the report builds.

> **SP/LY base style.** A prepack build shows under its PPK style (e.g. RYB0412PPK). Turn on **SP/LY base style** to label the **Last-Year block** with the base garment style (RYB0412) — where those last-year sales actually happened — while This Year / Comparison keep the PPK style you're planning. Off by default; the download (PDF/Excel) follows the toggle. They're formatted, printable comparisons: for each **Customer**, they break out **Style → Color** across the run's months in three blocks:

- **SP/LY** — same-period-last-year quantities (the SP/LY column). A style and its prepack (PPK) sibling are the same garment, so they're shown as **one style row** and last-year sales are counted **once** — never added twice under both the base and the PPK code. The row is **labeled by the style actually on the build**: a run that includes the base garment (base-only or a mixed base + PPK build) shows under the base code (e.g. **RYB0412**), while a build filtered to **only the prepack** shows under the **PPK code** (e.g. **RYB0412PPK**) — so the report never labels a group with a base style that isn't on the build.
- **TY** — this year's quantities. The **Buyer vs LY** report uses your **Buyer** column; the **Buy vs LY** report uses your **Buy** column. The two reports are otherwise identical.
- **Comparison** — the difference (**Δ = TY − LY**) and **%** per month and in total. A brand-new color with no last-year history reads **+100%**.

At the top of each report: a **customer picker** (choose which customers' sections appear — including hiding the "(Supply Only)" stock line; empty = all) and **Hide zero rows**. On a prepack-only build, the SP/LY block fills from the base garment family's last-year sales automatically. The Comparison block's difference columns are headed **Diff** (= This Year − Last Year). The report stacks three tables per customer — **SP/LY (Last Year)**, **TY (This Year)**, and **Comparison** — so "Hide zero rows" is applied **per table**: the Last Year table hides colors with no last-year sales, the This Year table hides colors with no quantity, and Comparison hides colors zero in both. (So a brand-new color you're buying won't clutter the Last Year table with a blank row, and vice-versa.) The toggle applies the same way to whatever you download. Use **Download PDF** for a landscape, Ring-of-Fire-branded sheet, or **Download Excel** for the same Ring-of-Fire-branded workbook every Tangerine report uses (logo, blue headers, blue total rows, red negatives; quantities and percentages come through as real Excel numbers you can re-sort or chart). As with the grid, the report reflects **saved** quantities — if a run's Buy (or Buyer) column is empty, that report's This Year block will be blank until you fill it.

### Future demand requests

The second tab on the Wholesale screen, **Future demand requests**, is where buyer-submitted future demand lives (with its own per-category sales-history readout). Applied requests fold into the next build and the build toast tells you how many were marked applied.

### Saving snapshots and rebuilding

The Planning run card also lets you:

- **Save build** — capture the current run (forecast rows, your edits, TBD rows, recommendations) as a named **saved build**. Find it later in the **Saved builds** dropdown; it can be browsed *and edited* like any run. When you save, you're switched onto the saved build automatically.
- **A saved build keeps saving itself.** A saved build isn't a frozen file — it's a live planning run. Once you're on it, **every edit and added row writes straight into it; there is no separate "Save" step.** The toolbar shows a green **"✓ Changes save automatically to this build"** note so this is obvious.
- **Fork** — when you're viewing a saved build, the **Fork** button makes a **separate new copy** (with your current edits) and leaves this build untouched. Use it only to branch off a second version — *not* to "save," since saving already happens automatically.
- **🗑 Delete run** / **Delete saved** — permanently remove a run or saved build *entirely* (a run with execution batches can't be deleted until those batches are removed).

> To clear a run's build **without** deleting the run, just click **Build forecast** again and choose **Wipe + rebuild** — that path already wipes everything (forecast, recommendations, TBD rows, bucket buys, your edits) and rebuilds. (There's no separate "Clear build" button; the wipe lives on the rebuild flow.)

When you click **Build forecast** on a run that already has a build, you're offered two paths:

1. **Rebuild (preserve edits)** — re-upserts forecast rows in the current scope; out-of-scope rows and your planner edits survive.
2. **⚠ Wipe + rebuild (destructive)** — deletes *everything* tied to the run (forecast, recommendations, TBD rows, bucket buys, override audit log, and your Buyer / Override / Buy / Unit Cost edits). It requires a final confirmation where you **type the run name** to enable the button. There is no undo.

> **Build (filtered):** if you've set grid filters, the Build button relabels itself **Build (filtered)** and only rebuilds the matching subset. A filtered build wipes out-of-scope rows within that scope — that is intentional. **Every input filter is honored, and each is multi-value** — Customer, Style, Category, Sub-category, Gender and Period all accept several selections at once, and the filtered build rebuilds exactly that combination (e.g. "these 4 styles for these 2 customers"). So the filtered build always matches what you see in the grid. *(Action / Confidence / Method are build **outputs**, not inputs, so they only narrow the on-screen view — they can't scope a build.)* Tip: to just *work on* a subset without rebuilding, set the filters and the grid shows only those rows — the rest of the build stays intact underneath.
>
> **A filtered build honors the filter even with no history.** If you filter to a style (or category / gender) the customer has never bought — e.g. a **prepack (PPK)** style, which has no sales of its own — the build now still creates rows for that filter selection (as zero-forecast lines you can plan against), instead of building nothing. Those rows are **shown even at zero** whenever the style is in your active Style filter (an explicit selection is honored, not hidden as clutter). Turn on **PPK inherits base** to fill a prepack's rows with the base garment's real demand + history. So "filter to RYB0412PPK for Burlington and build" gives you Burlington RYB0412PPK rows to plan, every time.
>
> **Supply-only rows honor a product filter.** The build adds a synthetic **(Supply Only)** row for any SKU that has incoming inventory (open PO / on-hand) but no demand pair, so you don't miss inbound stock. When your filter is **product-scoped** (style, category/group, sub-category, or gender), those supply-only rows are now restricted to the same product scope — so a "Cargo Shorts" build only shows cargo-shorts inbound, not every style with an open PO. A **customer-only** filter still shows all supply-only rows (they carry no customer). *Note: to clear supply-only rows a prior full build already wrote, use **Wipe + rebuild** — a plain rebuild leaves out-of-scope rows in place.*

## From a finished build to the final buy

Once **Build forecast** has run, the demand is on the grid. Turning that into purchase orders is a short, deliberate path across a few screens. Nothing here is auto-committed to vendors — you approve at each gate.

### 1. Finish the demand and enter the buy (Wholesale grid)

- Get **Final** right on every line: **System** is the app's suggestion; add **Buyer** (requested future demand) and **Override** (your manual adjustment). Final = System + Buyer + Override, floored at 0, and updates live as you type.
- Fill the **Buy** column — the quantity you actually intend to purchase per line. Shortcut: **Copy Final → Buy** fills Buy from Final across the view, then tweak individual cells. **Unit Cost** drives **Buy $**.
- All of this **saves as you type** — there is no "save the grid" button.

### 2. Reconcile against supply (Supply screen)

Open **Supply** (`/planning/supply`), pick the run, and click **Run reconciliation**. This nets your demand against the three supply buckets — **on-hand** (ATS), **open POs** (timed by their DDP milestone), and **receipts** — to produce **projected inventory**, **buy recommendations**, and a **shortage / excess** view. The **Reconciliation grid** shows the netted per-SKU picture; **Exceptions** shows where demand can't be fully covered.

### 3. (Optional) Snapshot and combine builds

- **Save build** to snapshot the plan (see *Saving snapshots and rebuilding* above). Handy for a paper trail or to plan several cuts in parallel.
- The **Reconcile** screen (`/planning/reconcile`) folds the recommendations of **several saved builds** into one buy plan — **one PO per build × vendor**. Use **Pick all / Clear** to choose which builds to include.

### 4. Approve the plan (Scenarios screen)

Approval is the gate Execution reads, and it lives on the **Scenarios** screen. Fork the run into a scenario, **Apply assumptions + recompute** (or **Push planner buys → plan** to carry your grid buys straight in), **Compare** against the base, and when it's right, **Approve**. The approval is recorded on the *scenario*, not the run.

### 5. Execute — create the POs (Execution screen)

Open **Execution** (`/planning/execution`):

1. **+ New batch** from the **approved scenario** (type *buy plan*).
2. **Approve** the batch.
3. **Export** it to Excel for a manual/vendor hand-off, **and/or** **🍊 Create Tangerine POs** — this groups the buys **by vendor** and creates **one draft PO each**.

> **Which vendor the draft PO gets.** If you picked a **Vendor** at build time (see the build-stage note above), that build vendor becomes the created PO's vendor — every eligible line lands on **one draft PO for that vendor**, and the preview labels it **(from build)**. Because the build vendor is chosen explicitly, a run with one **never skips lines for a missing/unlinked planning vendor**, so the "link this planning vendor" affordances don't appear. Only when **— Any vendor —** was left selected does the PO vendor come from each buy line's own planning-vendor link (which must be linked to a Tangerine vendor first) — behavior unchanged from before.

### 6. Issue the POs (PO WIP / Tanda)

The draft POs land in **PO WIP** in Tangerine. There you review quantities and sizes, make final adjustments, and **issue** each PO to its vendor. That issue step — outside Planning — is what actually places the order.

> **Where the "final buy" really is:** the numbers you commit to on the Wholesale grid (**Buy**) flow through reconciliation and approval into the Execution batch, which becomes the **draft POs**. The buy isn't "final" until those POs are issued in PO WIP.

## The Ecom screen

`/planning/ecom` — a Shopify-driven weekly ecom forecast. Same run model, but the grain is **SKU × week**.

Columns include **Channel · Category · SKU · Week**, trailing-demand windows **4W** and **13W**, **Trend**, the editable **System** override, **Final**, **Protected** and **Return** demand, supply (**On Hand**, **ATS**), **Short** / **Excess**, **Buy** and **Buy $**, plus a **Flags** column for at-a-glance signals. A search box filters by channel or SKU, and the System and Buy cells are editable the same way as on the Wholesale grid.

## The Supply screen

`/planning/supply` — **Supply Reconciliation**. This nets demand against supply to produce projected inventory, buy recommendations, and supply exceptions.

The reconciliation reads three supply buckets and nets them against the forecast:

- **On-hand** — latest snapshot per SKU (from ATS).
- **Open POs (incoming)** — open purchase orders, timed by their DDP milestone.
- **Receipts** — landed history.

Steps:

1. Pick a run (or start a new one with **New run**).
2. Click **Run reconciliation** (the primary button) to compute projected inventory and emit recommendations.
3. Review the two tabs: **Reconciliation grid** (the netted per-SKU view) and **Exceptions** (the allocation waterfall — where demand can't be fully covered).

### Choosing the supply source (Tangerine vs Xoro)

A run can read supply from one of two sources, shown as a badge on the run:

- **Xoro / ATS mirror** (default) — on-hand from ATS, open POs from PO WIP.
- **Tangerine ERP** — on-hand and open POs from native Tangerine. After selecting this source, click **🍊 Sync Tangerine supply**, then reconcile.

The reader filters by source so the two never double-count.

## The Scenarios screen

`/planning/scenarios` — **Scenarios & Exports**. What-if planning on top of a base run.

Tabs: **Scenarios** (the list), **Assumptions**, **Comparison**, **Exports**.

A scenario forks a base run so you can tune assumptions without disturbing the live plan. On the **Assumptions** tab (disabled once a scenario is approved/read-only) you have two ways to fill the scenario's buy plan:

- **Apply assumptions + recompute** — the supply-netted path: nets forecast demand against on-hand + open POs and emits shortage-driven buy recommendations.
- **Push planner buys → plan** — bypasses supply netting and writes your typed Buy quantities straight through as buy recommendations, replacing any computed ones.

The **Comparison** tab shows base vs scenario side by side, ranked by gross-margin dollar impact, with an **Export comparison → xlsx** button. The **Exports** tab produces a **consolidated** workbook (Metadata, Summary, Buy Plans, Shortages, Excess, Recommendations, Comparison, Assumptions).

> **Why "buy" matters:** the buy plan that *executes* always reads the **recommendations**, not your typed Buy quantities. A scenario can show typed buys yet produce an empty execution batch if recommendations were never generated. Use one of the two Assumptions-tab actions above to fill them.

> **Approve guard:** approving a scenario with zero recommendations warns you ("approving will produce an empty execution batch") and requires an explicit override, so an un-computed plan can't be approved by accident. The approved→in-review transition is labelled **Reopen**.

## The Reconcile screen

`/planning/reconcile` — **Build Reconcile**. Where the Scenarios screen models one run, Reconcile combines the recommendations across **multiple saved builds** into a single buy plan (one PO per build × vendor). Use **Pick all** / **Clear** to choose which saved builds to fold in.

## The Accuracy screen

`/planning/accuracy` — **Accuracy & AI**. Measures how good past forecasts were and surfaces issues.

1. Pick a run and click the run's pass button to compute accuracy.
2. Review the tabs:
   - **Accuracy** — forecast accuracy (MAPE-style) per line.
   - **Overrides** — how planner overrides affected accuracy.
   - **Anomalies** — outliers worth a look.
   - **Suggestions** — AI co-pilot suggestions.
   - **AI demand** — AI-assisted demand reads.

## The Execution screen

`/planning/execution` — **Execution**. Turns approved plans into a buy plan you can export or push to Tangerine.

Tabs: **Batches** (the list) and **Detail**.

1. Click **+ New batch**. You build a batch from an **approved scenario** (the Scenarios screen is where a plan gets approved). A batch is assembled from recommendations **at create time** — reopening it later won't pull in new ones.
2. In **Detail**, review the actions table. **Approve batch** is blocked while any line has a blocking validation issue (e.g. zero approved qty).
3. **Export** the batch to Excel (the universal export, with vendor / customer / channel shown as names, not IDs).
4. **🍊 Create Tangerine POs** turns the batch's buy-request actions into **draft native Tangerine purchase orders**, one per vendor, with a dry-run preview. They land in **Tangerine → Procurement → Purchase Orders** as drafts to review and issue. (Each planning vendor must be linked to a Tangerine vendor first.)

Batch lifecycle and what's reversible:

| Status | Notes |
|---|---|
| draft → ready → approved | Approve requires no blocking issues. |
| **exported** | Excel export isn't a commit — an exported batch can be **Reopened to ready** to revise and re-export. |
| **submitted** | Writeback may have run; a submitted batch can't be reopened. |

> **Empty batch?** Generate the recommendations first (Scenarios → Assumptions → Apply/Push), then **+ New batch** (or delete the empty one and rebuild). Reopening an empty batch won't add actions.

> **Writeback** is export-first by default and per-action. It only hits live endpoints when the corresponding config row is enabled; otherwise it's dry-run only. Creating Tangerine POs is independent of Xoro writeback.

## The Admin screen

`/planning/admin` — **Planning Admin**. Operational oversight, in four tabs:

- **Roles & permissions** — who can do what in Planning.
- **Integration health** — status of the Xoro / Shopify / ATS / PO-WIP feeds.
- **Job runs** — history of nightly and on-demand jobs.
- **Audit explorer** — the audit trail.

The **Job runs** and **Audit explorer** tables support per-column click-to-sort: click a header to cycle ascending ▲ → descending ▼ → off (blanks sink to the bottom), and the choice is remembered per panel.

## The Reports screen

`/planning/reports` — **Planning Reports**. On-screen reports, each downloadable to Excel via the universal export button:

- **Sales Performance**
- **Inventory Health**
- **Forecast Accuracy**
- **Buy Plan & Supply**

## The Data Quality screen

`/planning/data-quality` — **Planning — Data Quality**. Lists data issues found in the planning data set, so you can trust the plan that's built on it.

- Issues are graded by **Severity** — **error**, **warning**, **info** — with a count pill for each; click a pill to filter to that severity.
- Filter by **Category** too, and read each issue's **Message** and the **Entity** it concerns.
- Columns can be shown/hidden, and the table exports to Excel.

> Treat results as indicative: when planning data is large, some cross-table checks (orphans, duplicates) may be sampled rather than exhaustive.

## Working with the tables

Every planning table behaves consistently:

- **Sort any column — including multi-column** — click a column header to sort ascending (▲); click again for descending (▼). To sort by **several columns at once**, **Shift+click** each additional header: the first column you sort is the **parent** and each Shift+clicked column becomes a **child** (tie-breaker) under it — so you can sort **Customer**, then **Period** within each customer, then more. When more than one column is sorted, each shows a small **priority number** (1 = parent, 2 = next, …) next to its ▲/▼. Shift+click a sorted column again to cycle it asc → desc → off; a plain (non-shift) click on any header resets to a single sort by that column. Your sort — including a multi-column stack — is **remembered across reloads**. Computed/action columns (badges, inline editors, buttons) stay un-sortable by design.
- **Search boxes select-all on focus** — clicking into a search/filter box highlights the current text so you can type a new term straight over it.
- **Cascading filters** — where a screen has a search box plus more than one category filter (for example the Ecom grid's **Channel** and **Category**), each filter only offers values that still have rows under the other active filters, so you never pick a combination that shows nothing.
- **Filter dropdowns show what's selected** — a multi-select filter (Gender, Color, Customer, etc.) lists your chosen values right in the button and reveals the full list on hover, instead of an opaque "N selected." Your selections persist across sessions, so if a dropdown looks empty but still shows a selection, the current run just has no rows for it yet — the selected value stays visible and removable, and hitting **Reset** (or clearing it) restores the full list once the run is built. (Gender and Color options come from the run's forecast rows, so they populate after a successful build.)

## Exports

Every table-bearing screen carries the suite-standard Excel export. **Reports** downloads include a **TOTAL** row that sums the numeric columns (quantities and dollars; percentages are left blank since averaging them would mislead). The biggest workbook is the **consolidated scenario export** (Scenarios → Exports) covering the whole plan. Execution batches export with vendor/customer/channel names resolved — never raw IDs — and all dates render in US format (MM/DD/YYYY).

## A typical planning cycle

1. **Wholesale** — create a run, pick a method, **Build forecast**, then tune **System** overrides, **Buy** quantities, and any **TBD** rows. Apply any **Future demand requests**.
2. **Supply** — **Run reconciliation** to net demand against on-hand + open POs and surface shortages.
3. **Scenarios** — fork the run into a what-if, **Apply assumptions + recompute** (or **Push planner buys → plan**), **Compare**, then **Approve** once it's right.
4. **Execution** — **+ New batch** from the approved scenario, **Approve**, then **Export** to Excel and/or **🍊 Create Tangerine POs**.
5. **Accuracy / Reports** — after the season, review how the forecast performed and pull the reports.
