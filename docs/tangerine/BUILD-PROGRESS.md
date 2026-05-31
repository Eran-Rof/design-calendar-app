# Tangerine ERP — Live Build Progress

> **Single source of truth for "% complete."** Update this doc whenever a phase or module lands (it's part of the PR, like the user-guide chapters). Roadmap: `project-erp-build-roadmap` memory + `docs/tangerine/` arch docs. 25 phases (P1–P25), 49 modules (M1–M49), 7 pre-existing apps (E1–E7).

**Last updated:** 2026-05-31

## Summary

| Metric | Done | Total | % |
|---|---|---|---|
| **Phases (P1–P25)** | 12 + P13 partial | 25 | **~50%** |
| **Modules (M1–M49)** | ~25 + 4 partial | 49 | **~51%** |
| **Path to Xoro retirement (P1–P23)** | through P12, P13 in flight | 23 | **~55%** |

> **Two important caveats when reading the %:**
> 1. **The done half is the hard half** — full dual-basis (accrual+cash) accounting, FIFO inventory, 5-yr AR backfill, close/financials, bank recon, and all three revenue integrations. Remaining phases are more numerous but individually lighter.
> 2. **Code ≠ Xoro off.** Retirement (P23) is gated by **calendar-floor parallel runs** — Tangerine must reconcile against Xoro within tolerance for ~2 consecutive months *per area* before each cutover. Actual retirement is paced by parallel-run verification, not just shipping code.

Legend: ✅ done · 🟡 in progress / partial · ⬜ not started · ➕ operator insertion (off original numbering)

---

## Phases

| Phase | Scope (modules) | Status | Refs |
|---|---|---|---|
| **P1** Foundation | M1 Tenancy · M2 GL · matrix primitive · M34 Style Master · M35 Vendor Master · M36 Customer Master | ✅ | P1 arch doc |
| **P2** Cross-cutters | M27 Approvals · M28 Notifications · M29 Documents · M30 HR/Employee | ✅ | |
| **P3** Acc Core | M3 AP · M5 Inventory FIFO · M37 Inventory Ops · M39 Mobile Scanner | ✅ | |
| **P4** AR + backfill | M4 AR (5-yr backfill) | ✅ | |
| **P5** Close + Financials | M6 Close · TB / IS / BS / CF / Year-End | ✅ | |
| **P6** Bank Recon | M7 Bank/CC Feeds · M8 Reconciliation Engine | ✅ | |
| **P7** Revenue Ops | M16 CC Capture · M17 Sales Reps & Commissions · M9-subset reporting · M47 Customer Service/Cases | ✅ | |
| **P8** Data + CRM | M25 CRM · M42 PIM | ✅ | |
| **P9** Parallel-Run | reconciliation framework + variance gate + cutover automation | ✅ | first cutover gate (Cash) ~2026-07-28 |
| **P10** Tenancy | RLS flip + entity switcher (M1 ext) | ✅ | |
| **P11** Shopify | M12 Shopify + COGS posting | ✅ | |
| **P12** Marketplaces | M45 Marketplaces (FBA / Walmart / Faire) | ✅ | PR #515 |
| **P13** Procurement | M11 PO origination · M38 Receiving · M26 QC · M48 Trade Compliance | 🟡 arch (#518) + UI (#548) shipped; full per-vendor cutover pending | |
| **P14** PLM ext | M32 (Design-Calendar PLM) · M33 (Tech-Pack PLM) | ⬜ | superseded in slot by ➕RBAC insertion |
| **P15** Pricing | M43 Pricing Engine | ⬜ | superseded in slot by ➕Brand Master insertion |
| **P16** Sales | M10 SO entry · M18 Product Allocations · M24 Showroom/Line Review · M44 Carrier | ⬜ | |
| **P17** Planning | M31 Planning/Allocations (E4 ATS foundation) | ⬜ | |
| **P18** B2B customer-facing | M40 B2B Customer Portal · M41 B2B Wholesale Website | ⬜ | |
| **P19** Returns | M23 RMA / Returns | ⬜ | |
| **P20** Drop-ship | M49 Drop-ship Management | ⬜ | |
| **P21** 3PL | M13 3PL | ⬜ | |
| **P22** EDI | M14 EDI | ⬜ | |
| **P23** 🚩 Xoro decommission | — (cutover milestone) | ⬜ | the practical finish line |
| **P24** Reporting | M9 full reporting · M46 BI/Analytics | ⬜ | |
| **P25** Finance + API | M15 Public API · M19 Sales Tax · M20 1099 · M21 Fixed Assets · M22 Budgets/Forecasting | ⬜ | |

---

## Operator insertions (➕ — ahead of the original roadmap)

These were prioritized by the operator and built out-of-sequence; they occupy the P14/P15 *slots* but are not the roadmap's original P14/P15 scope.

| Item | Status | Refs |
|---|---|---|
| ➕ **P14 RBAC** (per-module × per-action permissions, `RBAC_MODE` off→log→enforce) | ✅ | #630 #632 #634 #645 #646 #647 |
| ➕ **JWT identity bridge** (MS-OAuth → verifiable per-user token) | ✅ (live; `TANGERINE_JWT_SECRET` set) | #648 #652 |
| ➕ **P15 Brand Master** (brand + channel axes, inventory partitions) | 🟡 C1 data + C2 switchers + C3a list filtering + **C3b AR/AP aging brand-aware** (views + RPCs, gated on `BRAND_SCOPE_MODE=enforce`) done; remaining: C4 financial-statement filtering + required-tagging (needs expense-account list), stock-pool separation | #650–#664 |

---

## Modules (M1–M49) quick index

✅ **Built (~25):** M1 Tenancy · M2 GL · M3 AP · M4 AR · M5 Inventory FIFO · M6 Close · M7 Bank Feeds · M8 Recon · M9 (subset) · M12 Shopify · M16 CC Capture · M17 Commissions · M25 CRM · M27 Approvals · M28 Notifications · M29 Documents · M30 HR · M34 Style Master · M35 Vendor Master · M36 Customer Master · M37 Inventory Ops · M39 Scanner · M42 PIM · M45 Marketplaces · M47 Cases

🟡 **Partial (4):** M11 PO · M26 QC · M38 Receiving · M48 Trade Compliance (all P13)

⬜ **Not started (~20):** M9-full · M10 SO · M13 3PL · M14 EDI · M15 API · M18 Allocations · M19 Sales Tax · M20 1099 · M21 Fixed Assets · M22 Budgets · M23 RMA · M24 Showroom · M31 Planning · M32/M33 PLM ext · M40/M41 B2B · M43 Pricing · M44 Carrier · M46 BI · M49 Drop-ship

---

## How to update this doc

When a phase or module lands (or partially lands), in the SAME PR:
1. Flip its row status (⬜→🟡→✅) + add the PR number(s) in Refs.
2. Re-count the Summary table (done phases / 25, done modules / 49) and update the three %s.
3. Bump **Last updated**.

Keep it honest — 🟡 for "arch/partial," ✅ only when the phase is functionally shippable. The % is derived from the rows, so the rows are the source of truth.
