# 39. Fixed Assets · Budgets · 1099 (P25 finance batch)

Three finance modules under **Accounting**. (Two P25 pieces — **Sales Tax (M19)**
and the **Public API (M15)** — are deferred; see the end.)

## 39.1 Fixed Assets & Depreciation (M21) — `/tangerine?m=fixed_assets`

A full fixed-asset register with a multi-method depreciation **schedule**, a
**roll-forward** report, and a **GL tie-out** that reconciles the register
against the general ledger. The panel has three tabs.

### Why this module posts NOTHING to the GL (read this first)

Tangerine's general ledger is a **faithful 1:1 mirror of Xoro**
(`journal_type='xoro_gl_mirror'`), and **Xoro is the system of record — it
already books depreciation** into the GL we mirror. If this module also posted
depreciation, every dollar would be **counted twice**. So while Xoro is the
system of record, this module only **records the register-side schedule** and
**reconciles it** to what Xoro already booked. It is a controllership control,
not a posting engine.

A posting engine *does* exist (DR Depreciation Expense / CR Accumulated
Depreciation), but it is **gated OFF** behind
`fixed_asset_settings.posting_enabled` (default **FALSE**). That flag is the
**Xoro-cutover switch**: it may be turned on **only** when Tangerine becomes the
system of record. Turning it on earlier double-counts depreciation. The banner
at the top of the panel always shows the gate state.

### Register tab

- **+ New Asset** — name, category, **method** (Straight-line, 200% Declining,
  150% Declining, Units of production), acquisition date, **in-service date**,
  **cost**, **salvage**, **useful life (months)**, and — for units-of-production
  — **total expected units**. The code (`FA-NNNN`) is assigned automatically.
- Click an asset **code or name** (blue) to open its full **depreciation
  schedule** (period, depreciation, accumulated, book value, posted flag) with
  an Export button.
- **Generate schedule** — deterministically (re)builds the asset's full-life
  schedule into the register. Idempotent (replaces non-posted rows). For
  units-of-production you enter the per-period usage series. **No GL is posted.**
- **Dispose** — marks the asset disposed; the schedule truncates at the disposal
  month. Gain/loss = proceeds − net book value (recorded, not posted).

**Depreciation methods & conventions** (pure, unit-tested engine
`src/lib/depreciation.ts`, mirrored server-side in
`api/_lib/fixed-assets/depreciation.js`):

- **Mid-month (half-month) convention** — the in-service month earns a half
  period, every whole month after earns a full period, and a final half period
  lands after the useful life elapses. Period weights sum to the useful life, so
  total depreciation equals the depreciable base (cost − salvage) to the cent.
- **Declining balance** applies factor ÷ life monthly to the opening book value
  and **switches over to straight-line** once that yields more — guaranteeing
  the asset fully depreciates to salvage by end of life. Book value never drops
  below salvage.
- **Units of production** distributes the base by per-period usage ÷ total units.

### Roll-forward tab

Beginning net book value → **+ additions** (asset cost placed in service) →
**− depreciation** (from the register schedule) → **− disposals** (net book
value removed) → **ending net book value**, by month. Exportable.

### GL Tie-out tab

Per month, the register's depreciation vs the **mirror GL's** depreciation-
expense account **6319** and accumulated-depreciation account **1590** activity,
with a category:

- **tie** — the register agrees with what Xoro booked.
- **register ahead** — the register booked more depreciation than Xoro did.
- **gl ahead** — Xoro booked more than the register (e.g. the register isn't
  built yet).
- **unmapped** — the register has depreciation but no GL account is mapped.

This answers the controllership question **"does our asset register agree with
the depreciation Xoro already booked?"** GL codes used: **1500** Fixed Assets,
**1590** Accumulated Depreciation, **6319** Depreciation Expense, **4903**
Gain/loss on disposal.

> **To activate the register**, the CEO/controller provides the asset list with
> acquisition costs, methods, and useful lives. The posting gate stays OFF until
> Xoro cutover.

## 39.2 Budgets (M22) — `/tangerine?m=budgets`

Budget vs actual by account. Pick a fiscal year, **set a budget** per GL account (full-year), and the table shows the **actual** GL balance beside it with the **variance** (budget − actual). Actuals come from the GL balance view (read $0 until transactions post). Per-period budgets are supported in the data model (`period_number` 1–12); the UI sets full-year (period 0).

## 39.3 1099 Worksheet (M20) — `/tangerine?m=form_1099`

A year-end 1099-NEC worksheet: every vendor flagged **1099** (Vendor Master `is_1099_vendor`) with the **total AP paid** to them in the calendar year (cash basis). It flags vendors **over the $600 threshold** ("reportable") and any **missing a Tax ID**. MVP sums `invoices.paid_amount_cents` by `paid_at` year; box mapping + e-file are deferred.

## Deferred P25 pieces
- **M19 Sales Tax** — a sales-tax-collected report by jurisdiction (needs tax captured on sales orders / AR first).
- **M15 Public API** — an external REST API + API-key management (a larger, security-sensitive build).
