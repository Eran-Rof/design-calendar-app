# 39. Fixed Assets · Budgets · 1099 (P25 finance batch)

Three finance modules under **Accounting**. (Two P25 pieces — **Sales Tax (M19)**
and the **Public API (M15)** — are deferred; see the end.)

## 39.1 Fixed Assets (M21) — `/tangerine?m=fixed_assets`

A fixed-asset register with **straight-line depreciation**.

- **+ New Asset** — name, category, acquisition date, **cost**, **salvage**, and **useful life (months)**. The code (`FA-NNNN`) is assigned automatically. Monthly depreciation = (cost − salvage) ÷ life.
- **Depreciate → today** — records the depreciation schedule from the start month through the current month (one row per month, never past the depreciable base; idempotent — already-recorded months are skipped). **Net Book Value** = cost − accumulated depreciation.
- **Dispose** — marks the asset disposed (optionally with proceeds).
- The depreciation **math** is pure + unit-tested (`api/_lib/fixed-assets/depreciation.js`). The **GL posting** (DR Depreciation Expense / CR Accumulated Depreciation, and the disposal gain/loss) is **deferred** — the COA has the accounts (1502 Accumulated Depreciation, a G&A Depreciation Expense, 4903 Gain/loss on disposal); auto-posting is a follow-up.

## 39.2 Budgets (M22) — `/tangerine?m=budgets`

Budget vs actual by account. Pick a fiscal year, **set a budget** per GL account (full-year), and the table shows the **actual** GL balance beside it with the **variance** (budget − actual). Actuals come from the GL balance view (read $0 until transactions post). Per-period budgets are supported in the data model (`period_number` 1–12); the UI sets full-year (period 0).

## 39.3 1099 Worksheet (M20) — `/tangerine?m=form_1099`

A year-end 1099-NEC worksheet: every vendor flagged **1099** (Vendor Master `is_1099_vendor`) with the **total AP paid** to them in the calendar year (cash basis). It flags vendors **over the $600 threshold** ("reportable") and any **missing a Tax ID**. MVP sums `invoices.paid_amount_cents` by `paid_at` year; box mapping + e-file are deferred.

## Deferred P25 pieces
- **M19 Sales Tax** — a sales-tax-collected report by jurisdiction (needs tax captured on sales orders / AR first).
- **M15 Public API** — an external REST API + API-key management (a larger, security-sensitive build).
