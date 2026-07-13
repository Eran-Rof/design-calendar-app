# Xoro→Tangerine GL-only backfill — design (CEO review required; nothing posted)

**#xoro-gl-truth, 2026-07-12.** From the complete Xoro GL mirror (`xoro_gl_transactions`, **702,686 rows, 99,492 txns, 2024-08 → 2026-07, no gaps**) and the monthly reconciliation view `v_xoro_tangerine_tb_recon` (OPERATING scope — excludes closing/opening/distribution entries).

## Why Tangerine ≠ Xoro
Tangerine is built from the **AR and AP subledgers** only. Xoro's GL additionally carries **GL-only entries that never came through a subledger** — Paycor payroll (through May 2026), inventory count/perpetual adjustments, markdowns, vendor discounts, freight/samples booked to COGS, revenue dilution, returns/chargebacks, bad debt, other income. These are exactly the CEO's May-2026 hand-comparison findings (Tangerine overstates NI ~$210K/month). This backfill posts the missing GL-only entries, source-dated, so Tangerine's TB matches Xoro account-by-account.

## Variance classification (per (month, account) cell — see `xoro-tangerine-tb-recon.csv`)
| Class | Meaning | Action |
|---|---|---|
| **SUBLEDGER:REVENUE / :COGS** | main sales (40xx) / channel COGS (501x) — Tangerine feeds these from AR | Variance is mostly **revenue/COGS channel MAPPING** (Xoro's channels ≠ ROF's 4005-4012 / 5010-5018) + timing. **Refine the map, do not backfill.** |
| **SUBLEDGER-DRIVEN** | expense Tangerine already posts (AP bills) | reclass in the subledger if needed (e.g. 6343 Inventory Adjustments — Xoro books to COGS 5003) |
| **GL-ONLY:\<cat\>** | Xoro-only; Tangerine ≈ $0 | **BACKFILL** — post the variance, source-dated |
| **BS-OPENING** | balance-sheet account | the un-booked 8/31/2024 opening (see `xoro-opening-balances.csv`) |

## GL-only backfill — what to post (24 months, net debit; per-month detail in `xoro-tb-gl-only-backfill.csv`)
| Category | Net debit missing from Tangerine | Notes |
|---|---|---|
| **PAYROLL / BAD DEBT** | **≈ $2,957,572** (~$123K/mo) | Paycor payroll on the Xoro GL, never in Tangerine (no payroll subledger). Bad-debt expense too. **Largest gap.** |
| **GL-ONLY:OTHER** | ≈ $1,050,850 | residual Xoro-only opex (e.g. security, water & power, HR software, rubbish, taxes booked GL-side) |
| **COGS-ADJ** (5001-5006, 5020-5023) | ≈ $949,312 | inventory count/perpetual adj, markdowns, vendor discounts, disassemble, purchases — Xoro puts these in COGS |
| **RETURNS / CHARGEBACKS** (42xx) | ≈ $691,228 | Xoro-booked returns, chargebacks, sales discounts |
| **OTHER INCOME** (49xx) | ≈ −$58,609 | Xoro other income (credit) Tangerine lacks |
| **FREIGHT** (54xx) | ≈ −$26,693 | net small |
| **SAMPLES** (52xx) | ≈ $13,138 | |
| **TOTAL GL-only** | **≈ $5.5M net debit over 24 months (~$230K/mo)** | aligns with the CEO's ~$210K/mo NI overstatement |

## Posting plan (NOT executed — CEO reviews first)
For each GL-ONLY (month, account) cell with a non-zero variance:
1. Post a JE **dated to the source month-end** (current month → latest source line date; never today) that moves the missing amount into the ROF account so the Tangerine net equals Xoro's:
   - variance > 0 (Tangerine short a debit): **DR the account / CR a clearing account** (`3999 GL-Backfill Clearing` or Retained-Earnings-opening, per controller) for the amount.
   - variance < 0 (Tangerine short a credit): **CR the account / DR clearing**.
2. `journal_type = 'xoro_gl_only_backfill'`, `source_table = 'xoro_gl_only_backfill'`, `source_id = '<gl_code>:<YYYY-MM>'` (idempotent), T11 `audit_reason` citing the mirror evidence. Never touch 2000/AR control (those are subledger-owned).
3. Payroll is the priority tranche (~$123K/mo): consider a dedicated payroll-expense + payroll-liability pair rather than a single clearing line, so the balance sheet is right too.

## Opening balances (8/31/2024) — `xoro-opening-balances.csv`
The 210 equity-touching opening entries give each BS account's 8/31/2024 value (Inventory, AR house/factor, AP, Factor Advances, Bank, Capital, Opening Balance Equity). Booking these as Tangerine's opening JE closes the BS-OPENING variance and is a prerequisite for a clean balance sheet.

## Before posting: refine the revenue/COGS map
The SUBLEDGER:REVENUE ($10.9M abs) and SUBLEDGER:COGS ($9.1M abs) variances are **inflated by channel mapping**, not real gaps — Xoro's revenue/COGS sub-accounts don't line up 1:1 with ROF's 4005-4012 / 5010-5018. Curate `RECON_MAP` in `scripts/build-xoro-account-map.mjs` for the exact channel correspondences (CEO/controller input) and re-run before treating any revenue/COGS variance as actionable.
