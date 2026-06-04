# 35 · Inventory Planning — Reports

The planning app has a dedicated **Reports** hub at **`/planning/reports`** (the
**📊 Reports** link in the planning nav). Every report is viewable on screen and
**downloadable to Excel** with the universal **⬇ Export** button — the download is
exactly what you see (same filter, same sort, same columns).

All reports read the planning `ip_*` tables (Xoro/Shopify-backed), aggregate in
the browser, and let you re-group on the fly. Click any column header to sort.

## The four reports

### Sales Performance
Wholesale sales over a date window, grouped by **Month / Category / Customer /
Channel / SKU**.
- **This-Year vs Last-Year**: the window you pick is "TY"; the equal-length period
  immediately before it is "LY", giving a **YoY %** column and summary.
- **Txn type** filter (default `invoice` = realized revenue) prevents
  double-counting the order→ship→invoice lifecycle.
- At **SKU** grain you also get an **ABC class** (A = top 80% of revenue, B = next
  15%, C = last 5%) and per-SKU margin %.

### Inventory Health
Latest on-hand snapshot per SKU/warehouse, grouped by **Category / SKU /
Warehouse**.
- **On-Hand $** values stock at best-available unit cost (`ip_item_avg_cost` →
  item-master `unit_cost`).
- **Weeks of Supply** = on-hand ÷ recent weekly sales velocity, with a **Status**
  band: **Stockout** (≤ 0 on hand), **Low** (< 4 weeks), **Healthy** (4–26),
  **Excess** (> 26 weeks, or stock with no recent sales).
- Summary cards: total on-hand value/units, stockout count, excess count.

### Forecast Accuracy
Scores a selected **planning run** vs actuals, grouped by **Method / Category /
Period / SKU**.
- **MAPE** (volume-weighted absolute error ÷ actuals) for both **System** and
  **Final** forecasts, plus **Δ vs System** — a negative delta means planner
  overrides improved accuracy.
- **Bias %** shows over/under-forecasting.
- *Empty until a run has been scored on the Accuracy screen.*

### Buy Plan & Supply
Two lenses, chosen by the **Group by** control:
- **Demand lenses** (Category / SKU / Priority) roll up the selected run's buy
  recommendations — **Buy Qty**, **Buy $**, **Shortage**, **Excess**, **Critical
  Recs** — with open-PO coverage overlaid per SKU.
- **Supply lenses** (Vendor / Receipt month) roll up open POs — **Open PO Qty/$**
  and line counts — to show inbound receipts by source and timing.

## Exporting
Click **⬇ Export (N)** on any report. The file is named per report
(e.g. `planning-sales-performance-YYYY-MM-DD.xlsx`) and contains the on-screen
rows with typed columns (numbers, currency, percent, dates) ready for pivoting.

## Notes & caveats
- Reports load full tables and aggregate client-side, so the first render of a
  large grain (e.g. Sales by SKU) can take a few seconds.
- Ecom sales are dormant until a Shopify store is connected, so ecom-only cuts
  read empty (expected).
- Inventory aging by receipt date isn't available (the snapshot carries no lot
  date); the coverage bands stand in for it.
