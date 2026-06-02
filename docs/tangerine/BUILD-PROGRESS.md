# Tangerine ERP — Live Build Progress

> **Single source of truth for "% complete."** Update this doc whenever a phase or module lands (it's part of the PR, like the user-guide chapters). Roadmap: `project-erp-build-roadmap` memory + `docs/tangerine/` arch docs. 25 phases (P1–P25), 49 modules (M1–M49), 7 pre-existing apps (E1–E7).

**Last updated:** 2026-06-01

## Summary

| Metric | Done | Total | % |
|---|---|---|---|
| **Phases / slots (P1–P25)** | 12 + P14-slot (RBAC) + P15-slot (Brand Master) ✅; **P13 build complete (PO→receive→QC→customs→3-way→close)**, **P16 core complete (M10/M18/M44 + M11 PO + matrix)**, **P18 B2B portal MVP live** | 25 | **~68%** |
| **Modules (M1–M49 + ➕M50)** | ~35 + ➕M50; M10 SO + M18 alloc + M44 carrier + M11 PO + **M43 Pricing** + **M26 QC / M38 Receiving / M48 Trade Compliance** done; size-matrix; M40/M41 B2B portal; Customer/Vendor 360° + Employee masters | 49 (+ins) | **~67%** |
| **Path to Xoro retirement (P1–P23)** | through P12 + P14/P15 + P16 core + P18 portal + **P13 build complete** (cutover = operator parallel-run) | 23 | **~70%** |

> Note: the **P14/P15 slots** hold operator insertions (RBAC, Brand Master), not the original roadmap scope (PLM-ext, Pricing — deferred). The brand / allocation / partition work is **built but GATED** (`BRAND_SCOPE_MODE` off) — shipped code, not yet *enforced* in prod.

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
| **P13** Procurement | M11 PO origination · M38 Receiving · M26 QC · M48 Trade Compliance | 🟡 **schema + M11 PO panel only** — P13-1/2 schema (all procurement tables applied, dormant) + M11 native PO panel (#732). **Receiving / QC / customs / broker / 3-way-match UI NOT built yet** (the prior "#548 UI shipped" note was stale). **Completion program in flight (C0–C5):** C0 (#799) reconciles the two PO systems — dual receipt + commitment FK so receiving attaches to EITHER a native `purchase_orders` PO or a mirrored `tanda_pos` PO; open-PO `po_commitments` recorded on native PO issue. **C1 (#801):** Receiving (`InternalReceiving`, M38) against a native PO → `tanda_po_receipts/_lines` + landed-cost rollups; Post creates FIFO `inventory_layers` (`source_kind='po_receipt'`) at landed unit cost, queues rollup AP invoices for **bookkeeper approval** (`InternalBookkeeperApproval`), consumes commitments; new **Procurement** nav group (h585–h589). (No receipt-GRNI JE yet; matched-vendor-AP-skip-layer handled in C4.) **Wave C (#804):** C2 QC inspections (`InternalQCInspections`, tanda_po_qc_inspections/_findings, pass/partial/fail + pass-rate + line dispositions; h590-h591); C3 Trade Compliance (`InternalCustomsEntries` + `InternalBrokerInvoices`, customs_entries/_lines + broker_invoices; landed-cost revaluation JE deferred; h592-h595); C4 vendor-invoice **3-way match** (`InternalThreeWayMatch`, vendor_invoice_drafts, $5/2% tolerance vs received-accepted value, approve→AP draft; h596-h597). All draft-only / no new GL-posting code (GL flows through existing AP/adjustment posting). **C5 (#805):** Procurement Reconciliation inbox + open-commitments-by-vendor report (`InternalProcurementRecon`, h598) + **period-close pre-flight blockers (D16)** — unresolved 3-way (blocking), stale customs >60d no broker invoice (blocking), failed QC (warning), added to `gl-periods/preflight.js`. ✅ **BUILD COMPLETE** — full PO→receive→QC→customs→3-way→close operational layer. **Remaining = operator-run per-vendor parallel-run cutover** (pilot: Zhejiang Zhuji Newdan) + the deferred GL refinements (receipt GRNI JE, landed-cost revaluation JE, QC-disposition postings). | #799 #801 #804 #805 |
| **P14** PLM ext | M32 (Design-Calendar PLM) · M33 (Tech-Pack PLM) | ⬜ | superseded in slot by ➕RBAC insertion |
| **P15** Pricing | M43 Pricing Engine | ✅ **COMPLETE** — A (#792): `price_lists` / `price_list_items` (qty breaks) / `price_promotions` schema, unified JS engine `api/_lib/pricing/engine.js` (precedence customer-own → assigned → tier → default list, + best promotion), `customers.price_list_id`, B2B catalog/orders repointed, resolve endpoint h578. B (#793): **Price Lists** + **Promotions** admin panels + customer→price-list assignment, new **Pricing** nav group (h579–h584). C (#794): internal **Sales-Order line price auto-fill** (resolve accepts SKU `item_id`→style; prefills unit $, editable, ↻ re-pull, source-list hint). User-guide ch31. (P15 *slot* itself was taken by ➕Brand Master; M43 proper now done.) | #792 #793 #794 |
| **P16** Sales | M10 SO entry · M18 Product Allocations · M24 Showroom/Line Review · M44 Carrier | ✅ **core complete.** M10 (#698-#700) + Sales/CRM/HR batches (#701–#717) + **M18 allocations (#725)** + **M44 carrier/ship (#726)** → full draft→confirm→allocate→ship→invoice lifecycle. M24 line-review delivered as **matrix SO entry**. **Matrix initiative (#727–#733):** Size Scale master, color/size/inseam matrix on inventory view + SO entry + adjustments, **M11 native Purchase Orders** (draft→issued→in_transit→received), shared style-matrix/auto-SKU lib + scale-ordered columns. **M18 Allocations Workbench (#788):** standalone `Sales → Allocations` screen — demand grouped by style/color → SKU → competing SO lines, editable per-line allocation cells, and an Auto-allocate run (priority **factor-approved → credit-card → oldest**) with a size-level preview + a hard factor-credit gate (`apply_allocations` RPC, `v_allocation_demand` view). **Fill modes (#789):** Priority full-fill + Fair-share (pro-rata) + Capped-% (per SKU / per style-color), chosen at run time. | #698–#733 #788 #789 |
| **P17** Planning | M31 Planning/Allocations (E4 ATS foundation) | ⬜ | |
| **P18** B2B customer-facing | M40 B2B Customer Portal · M41 B2B Wholesale Website | 🟡 **portal live** — A foundation (b2b_accounts/b2b_price_list schema + portal-origin SO cols) · B passwordless buyer auth + session chokepoint (`resolveB2BSession`) · F internal admin (authorize buyers + price lists) · **C/D/E buyer pages**: Catalog + per-customer wholesale pricing, Cart→draft SO (`origin='b2b_portal'`, server-resolved prices, ship-to validated), Account invoices/AR + open balance + Reorder. **Next: M41 storefront polish, M43 Pricing Engine.** | #719–#723 |
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
| ➕ **P15 Brand Master** (brand + channel axes, inventory partitions) | ✅ **COMPLETE** — C1 dims + C2 switchers + C3 AR/AP aging + C4/M50 GL allocation + stock-pool (receipt #681, On-Hand-by-Pool report #685, adjustment pool #689, partition-aware consumption #692) + **Axel entity (Syndicated Apparel Group)** #686. ALL gated `BRAND_SCOPE_MODE` off → inert until operator go-live config (OPERATOR-TODO). | #650–#664 #675 #681 #685 #686 #689 #692 |
| ➕ **M50 GL Brand Allocation** (per-brand P&L accounts + %-allocation engine) | ✅ arch + A schema + B (COA UI) + C-engine (manual-JE split) + C-2 (AP-invoice split) + **D Income-Statement done** (handler enriches rows w/ brand meta + brand list; UI groups brand-children under rollup parent w/ subtotal, per-brand filter dropdown, hide-account-# toggle, brand-aware export). All gated `BRAND_SCOPE_MODE=enforce` — inert until brands configured + flag flipped. | #665 #666 #669 #670 #671 #674 #675 |
| ➕ **M51 Payroll Integration (Paycor)** | ⬜ arch (`payroll-paycor-integration-architecture.md`); **integrate, don't build** — Paycor = system-of-record (calc/withholding/e-filing/deposits/W-2); Tangerine posts the run to GL (dual-basis, `source='paycor'`) + reconciles bank draw + optional M50 labor allocation. ~2 chunks. Blocked on Paycor GL-export-vs-API access + pay-code→GL mapping. | #667 |
| ➕ **M52 Multi-Warehouse** | ⬜ planned (CEO 2026-05-31). Foundation exists: `inventory_locations` table (kinds: warehouse/fba/wfs/3pl/dropship/virtual) + `inventory_transfers`. Gaps: (1) **admin panel** to add/edit warehouses, (2) **per-location stock** — FIFO `inventory_layers` aren't location-scoped (the "advanced multi-warehouse" stretch: per-location on-hand + transfers moving qty). ~2–3 chunks when pulled in. | — |
| ➕ **Vendor default AP/expense auto-fill** (part of M50 C-2) | 🟡 done — AP-invoice entry auto-fills AP+expense accounts from the vendor's defaults; on change, prompts "set as default for this vendor?" → writes back to vendor master. (Vendor schema fields already existed.) | #672 |

---

## Modules (M1–M49) quick index

✅ **Built (~25):** M1 Tenancy · M2 GL · M3 AP · M4 AR · M5 Inventory FIFO · M6 Close · M7 Bank Feeds · M8 Recon · M9 (subset) · M12 Shopify · M16 CC Capture · M17 Commissions · M25 CRM · M27 Approvals · M28 Notifications · M29 Documents · M30 HR · M34 Style Master · M35 Vendor Master · M36 Customer Master · M37 Inventory Ops · M39 Scanner · M42 PIM · M45 Marketplaces · M47 Cases

🟡 **Partial (4):** M11 PO · M26 QC · M38 Receiving · M48 Trade Compliance (all P13)

✅ **M10 SO** complete (P16): entry panel + API, draft→confirm→AR invoice, factor approval, multi-store split. **M18 Allocations** complete: per-SO reserve (#725) + standalone **Allocations Workbench** (#788, cross-SO priority full-fill + factor-credit gate). **M44 Carrier** complete (#726).
⬜ **Not started (~15):** M9-full · M13 3PL · M14 EDI · M15 API · M19 Sales Tax · M20 1099 · M21 Fixed Assets · M22 Budgets · M23 RMA · M24 Showroom · M31 Planning · M32/M33 PLM ext · M40/M41 B2B · M46 BI · M49 Drop-ship

---

## How to update this doc

When a phase or module lands (or partially lands), in the SAME PR:
1. Flip its row status (⬜→🟡→✅) + add the PR number(s) in Refs.
2. Re-count the Summary table (done phases / 25, done modules / 49) and update the three %s.
3. Bump **Last updated**.

Keep it honest — 🟡 for "arch/partial," ✅ only when the phase is functionally shippable. The % is derived from the rows, so the rows are the source of truth.
