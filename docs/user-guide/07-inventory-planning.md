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

### Forecast method

Above the grid, pick the baseline method the build uses:

| Button | What it does |
|---|---|
| **Same Period LY** | Uses last year's sales for the same period as the baseline. |
| **Weighted Recent Demand** | Weights recent months more heavily. |
| **Reorder Cadence** | Drives the forecast from how often the SKU historically reorders. |

### Reading and editing the grid

Each row is a customer × style × color × period demand line. Columns can be shown or hidden with the **Columns** button; the key ones:

| Column | Meaning | Editable? |
|---|---|---|
| Category / Sub Cat / Style / Description / Color / Customer / Period | The dimensions of the row | TBD rows only (see below) |
| Class | Style classification | No |
| Hist T3 / SP/LY | Trailing-3-month and same-period-last-year history | No |
| Margin % | Gross margin on the line | No |
| **System** | The system's forecast suggestion — **type to override it** | **Yes** |
| Buyer | Buyer-requested future demand | Via Future Demand Requests |
| Override | The adjustment you've made | derived from System edits |
| Final | The committed forecast for the line | No (computed) |
| Conf. / Method | Confidence band + method used for the line | No |
| On hand / On SO / Receipts / Hist Recv / **ATS** | Supply context | No |
| **Buy** | Your planned buy quantity for the line | **Yes** |
| Avg Cost / **Unit Cost** | Cost per unit (Unit Cost overrides Avg Cost for this line) | **Unit Cost: Yes** |
| Buy $ | Buy × Unit Cost | No (computed) |
| Short / Excess | Shortage / excess vs supply | No |
| Action | The recommended action (buy / hold / monitor / reduce / expedite) | No |

**Editing cells:**

- **System** — type a whole number to override the suggestion; the cell turns yellow + italic and remembers who changed it from what (hover for the audit note). **Clear the box (or type 0)** to revert to the system suggestion.
- **Buy** — type a planned buy quantity (comma-formatted when idle, e.g. "10,000"). Clearing it removes the planned buy.
- **Unit Cost** — click the cell, type a cost, Enter to commit / Esc to cancel.

> Overrides are remembered per row. A normal **Rebuild (preserve edits)** keeps your Buyer / Override / Buy / Unit Cost edits on rows that get recomputed. Only a **Wipe + rebuild** discards them (see below).

### TBD stock-buy rows

Some buys aren't tied to a known style yet — you're buying ahead into stock. These appear as **TBD** rows, and on a TBD row the dimension cells *are* editable:

- **TBD style** — click the style cell to pick any style in the same category, type a brand-new style code (flagged **NEW** in amber until the item master catches up), or revert to the catch-all **TBD** slot.
- **TBD description / customer / color** — likewise editable inline so you can flesh out the line as the buy firms up.

A row whose style isn't yet in the item master shows an amber **NEW** badge; it auto-clears once a future build sees that style in the master.

### Future demand requests

The second tab on the Wholesale screen, **Future demand requests**, is where buyer-submitted future demand lives (with its own per-category sales-history readout). Applied requests fold into the next build and the build toast tells you how many were marked applied.

### Saving snapshots and rebuilding

The Planning run card also lets you:

- **Save build** — capture the current run (forecast rows, your edits, TBD rows, recommendations) as a named **saved build** snapshot. Find it later in the **Saved builds** dropdown; it can be browsed like any run.
- **Fork & save** — when you're viewing a saved build, "Save" becomes a fork (clone-of-clone) so the original snapshot is preserved.
- **🗑 Delete run** / **Delete saved** — permanently remove a run or snapshot (a run with execution batches can't be deleted until those batches are removed).

When you click **Build forecast** on a run that already has a build, you're offered two paths:

1. **Rebuild (preserve edits)** — re-upserts forecast rows in the current scope; out-of-scope rows and your planner edits survive.
2. **⚠ Wipe + rebuild (destructive)** — deletes *everything* tied to the run (forecast, recommendations, TBD rows, bucket buys, override audit log, and your Buyer / Override / Buy / Unit Cost edits). It requires a final confirmation where you **type the run name** to enable the button. There is no undo.

> **Build (filtered):** if you've set grid filters (customer, style, category, etc.), the Build button relabels itself **Build (filtered)** and only rebuilds the matching subset. A filtered build wipes out-of-scope rows within that scope — that is intentional.
>
> **Supply-only rows honor a product filter.** The build adds a synthetic **(Supply Only)** row for any SKU that has incoming inventory (open PO / on-hand) but no demand pair, so you don't miss inbound stock. When your filter is **product-scoped** (style, category/group, sub-category, or gender), those supply-only rows are now restricted to the same product scope — so a "Cargo Shorts" build only shows cargo-shorts inbound, not every style with an open PO. A **customer-only** filter still shows all supply-only rows (they carry no customer). *Note: to clear supply-only rows a prior full build already wrote, use **Wipe + rebuild** — a plain rebuild leaves out-of-scope rows in place.*

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

- **Sort any column** — click a column header to sort ascending (▲); click again for descending (▼); a third click clears the sort and returns to the screen's natural order. The active sort is remembered per screen. Computed/action columns (badges, inline editors, buttons) stay un-sortable by design.
- **Search boxes select-all on focus** — clicking into a search/filter box highlights the current text so you can type a new term straight over it.
- **Cascading filters** — where a screen has a search box plus more than one category filter (for example the Ecom grid's **Channel** and **Category**), each filter only offers values that still have rows under the other active filters, so you never pick a combination that shows nothing.

## Exports

Every table-bearing screen carries the suite-standard Excel export. **Reports** downloads include a **TOTAL** row that sums the numeric columns (quantities and dollars; percentages are left blank since averaging them would mislead). The biggest workbook is the **consolidated scenario export** (Scenarios → Exports) covering the whole plan. Execution batches export with vendor/customer/channel names resolved — never raw IDs — and all dates render in US format (MM/DD/YYYY).

## A typical planning cycle

1. **Wholesale** — create a run, pick a method, **Build forecast**, then tune **System** overrides, **Buy** quantities, and any **TBD** rows. Apply any **Future demand requests**.
2. **Supply** — **Run reconciliation** to net demand against on-hand + open POs and surface shortages.
3. **Scenarios** — fork the run into a what-if, **Apply assumptions + recompute** (or **Push planner buys → plan**), **Compare**, then **Approve** once it's right.
4. **Execution** — **+ New batch** from the approved scenario, **Approve**, then **Export** to Excel and/or **🍊 Create Tangerine POs**.
5. **Accuracy / Reports** — after the season, review how the forecast performed and pull the reports.
