# 38. Reports & Analytics hub (P24 / M9-full + M46)

**Where:** Tangerine → **Reports → 📊 Reports & Analytics** (`/tangerine?m=reports_hub`)

## What it is

One executive landing that ties together every financial and operational report
already in Tangerine, with **live finance KPIs** on top. The reports themselves
were built across P5 (Trial Balance / Income Statement / Balance Sheet / Cash
Flow / Year-End) and P7 (operational); this hub is the front door.

## KPI tiles

Live aggregates over the ledgers (read $0 until transactions post):

- **Open AR** — unpaid posted customer invoices (`ar_invoices` total − paid).
- **Open AP** — unpaid posted vendor bills (`invoices` total − paid).
- **Inventory @ cost** — Σ `inventory_layers.remaining_qty × unit_cost`.
- **Open sales orders** — SOs in confirmed / allocated / fulfilling / shipped.
- **Current period** — the open GL period.

(Served by `GET /api/internal/finance-kpis`.)

## Executive ratios

Cheap derived metrics computed from the KPIs above plus YTD paid spend:

- **Net working capital** — `Open AR + Inventory @ cost − Open AP` (a crude
  liquidity proxy; green when positive, red when negative).
- **AR / AP ratio** — receivables ÷ payables cover, shown as `1.23×`
  (green ≥ 1×, amber below).
- **YTD spend (paid)** — total paid vendor invoices this year, with a tiny
  inline-SVG **sparkline** of the monthly trend.
- **Active vendors (paid)** — count of vendors with paid invoices YTD.

## Business intelligence charts

Small dark-theme charts over the **existing** spend report
(`GET /api/internal/reports/spend`) and the finance KPIs — no new data sources:

- **Top vendors by spend** — horizontal bar of the top 8 vendors by paid
  invoice total, YTD.
- **Monthly spend trend** — line chart of paid spend by month.
- **Balance composition** — donut of Open AR vs Open AP vs Inventory @ cost.

Each chart shows a graceful empty state ("reads $0 until transactions post")
until the underlying data is present. Charts render with **recharts** (already a
repo dependency) plus a tiny inline-SVG sparkline; the reusable primitives live
in `src/tanda/components/MiniCharts.tsx`.

## Report links

Grouped quick links that open each report in place:

- **Financial Statements** — Trial Balance, Income Statement, Balance Sheet, Cash Flow, Year-End Close.
- **Receivables & Payables** — AR/AP Aging, AR/AP Invoices, Bank Reconciliation.
- **General Ledger** — GL Detail, Chart of Accounts, Journal Entries, Periods.
- **Sales** — Sales by Rep, Sales by Customer.

All the financial report panels (Trial Balance, Income Statement, Balance
Sheet, Cash Flow, Segment P&L, GL Detail, Sales by Customer/Rep, CRM Pipeline)
now guard against stale responses: if you change a filter or date range while a
slower earlier request is still in flight, the old response is discarded
instead of briefly overwriting the newer numbers.

## 🔖 UPC Report

Reports menu → **🔖 UPC Report**. Lists every barcode in the UPC master at `(style, color, size)` grain, joined to the style for its name:

| Column | Meaning |
|---|---|
| Style / Style Name | The style the UPC belongs to. |
| Color / Size | The variant the barcode identifies. |
| UPC | The 12-digit UPC-A. |
| Source | `GS1 (minted)` for barcodes minted by Tangerine, or `Excel` / `Xoro` for imported ones. |

Type in the search box to filter by style, color, size, or UPC. The **Export** button downloads the current view as xlsx, and **Columns** toggles which columns show. This is where the UPCs minted via the Style Master **Generate UPCs (GS1)** checkbox land (see [Master Data → Style Master](02-master-data.md)).

> A dozen procurement/vendor **analytics** endpoints also exist
> (`api/_handlers/internal/analytics/*`: spend, forecast, health-scores,
> diversity-spend, early-payment, fx…); folding those into charts here is the
> next BI step.
