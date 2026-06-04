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

## Report links

Grouped quick links that open each report in place:

- **Financial Statements** — Trial Balance, Income Statement, Balance Sheet, Cash Flow, Year-End Close.
- **Receivables & Payables** — AR/AP Aging, AR/AP Invoices, Bank Reconciliation.
- **General Ledger** — GL Detail, Chart of Accounts, Journal Entries, Periods.
- **Sales** — Sales by Rep, Sales by Customer.

> A dozen procurement/vendor **analytics** endpoints also exist
> (`api/_handlers/internal/analytics/*`: spend, forecast, health-scores,
> diversity-spend, early-payment, fx…); folding those into charts here is the
> next BI step.
