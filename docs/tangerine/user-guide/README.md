# Tangerine ERP — User Guide

The operator + accountant guide for the Tangerine ERP. It began (chapters 01–06) as the guide for the 6 admin panels shipped in Phase 1 — **Style Master · Vendor Master · Customer Master · Chart of Accounts · Periods · Journal Entries** — and now spans through **P17/M31** (Sales, Procurement, Pricing, B2B, the size-matrix initiative, brand-scoped accounting, and the Inventory-Planning ⇄ Tangerine integration). Tangerine has its own URL and top nav at **`/tangerine`** — separate from the Tanda PO WIP app.

> **Coverage:** chapters 01–25 cover P1–P14 (foundation → RBAC/identity). Chapters 26–33 cover P15 (brand scope), P16 (Sales: SO / allocations / shipping / native PO / size matrix), P18 (B2B portal), the P16 master-data / CRM / HR operator batches, **M43 Pricing (ch31)**, **P13 Procurement (ch32)**, and **M31/P17 Planning ⇄ Tangerine (ch33)**.

## Who this is for

| Persona | Primary panels |
|---|---|
| **Internal operator** (CEO, ops manager, merchandiser) | 🎨 Style · 🏭 Vendor · 🤝 Customer · 🗓️ Periods (view-only) |
| **External accountant** (contractor or CPA firm) | 📒 Chart of Accounts · 🗓️ Periods (status changes) · 📓 Journal Entries |

Login is the same for both; access to the data inside each panel is gated by Row-Level Security on the underlying tables.

## Table of contents

1. [Getting started](01-getting-started.md) — how to log in, where the panels live in the menu, 10-minute smoke test
2. [Master data](02-master-data.md) — Style, Vendor, Customer Master CRUD flows
3. [Accounting](03-accounting.md) — Chart of Accounts, Periods, Journal Entries
4. [Concepts](04-concepts.md) — multi-entity, dual-basis accounting, control accounts, matrix dimensions, PII handling, audit immutability
5. [Workflows](05-workflows.md) — end-to-end recipes (initial COA setup, monthly close, manual adjustment, vendor/customer onboarding, JE reversal)
6. [Troubleshooting](06-troubleshooting.md) — error reference, recovery patterns
7. [Approvals (M27)](07-approvals.md) — P2: configure approval rules, approve / reject from the inbox
8. [Notifications (M28)](08-notifications.md) — P2: in-app inbox + email channel; preferences per (kind, channel)
9. [Documents (M29)](09-documents.md) — P2: attach files to vendors / customers; signed-URL downloads
10. [Employees (M30)](10-employees.md) — P2: HR/identity layer + v_audit_user_resolved view for display names
11. [Inventory operations (M37)](11-inventory-operations.md) — P3: read-only Inventory Transfers panel (skeleton); grows as P3-5 / P3-6 ship
12. [Mobile Scanner (M39)](12-scanner.md) — P3: back-end contract for the native scanner apps + read-only troubleshooting view
13. [Accounts Payable (M3)](13-accounts-payable.md) — P3: vendor bill lifecycle (draft → posted → paid → void), approval gate, payments ledger
14. [Payment Terms](14-payment-terms.md) — P3: structured payment terms master + `compute_due_date` helper
15. [Fabric Codes (P3 / Chunk 11)](15-fabric-codes.md) — textile-specific master + many-to-many junction to Style Master; precursor to M42 PIM. Seeded with 9 common apparel fabrics.
16. [Accounts Receivable (M4)](16-accounts-receivable.md) — **P4 COMPLETE (2026-05-27 night)** — invoices, receipts (multi-application with sibling-linked accrual+cash JEs), aging report, daily overdue cron, customer credit-limit gate, and historical backfill (Aug 2024 onward). All four AR admin panels live under **💼 Accounting** in the top-nav group dropdown.
17. [Bank Reconciliation (M7 + M8)](17-bank-reconciliation.md) — **P6 COMPLETE (2026-05-27 night)** — Plaid Link + CSV upload + ±5d match engine + recon report + period-close pre-flight check + auto-post fee rules cron. Bank panel + Bank Recon Report panel live under **🏦 Bank** in the top-nav group dropdown.
18. [Table export — every panel](18-table-export.md) — **T3 cross-cutter (2026-05-28)** — universal `<ExportButton>` on every list / report / master panel. WYSIWYG xlsx + csv download with autofit columns and proper currency / date typing. **Companion `<TotalsButton>` (2026-07-15)** rides the same mounts to total any numeric column (money as $, qty summed, % skipped).
19. [Revenue Operations (P7 — M16 + M17 + M9-subset + M47)](19-revenue-operations.md) — **P7 COMPLETE (2026-05-28)** — CC capture provider interface (no concrete processor until admin picks), Sales Reps + Commissions full workflow with auto-clawback, 4 new operational reports under 📊 Reports, Customer Service / Cases panel with Resend inbound email-in, plus 3 notification triggers + 1 approval rule wired via cross-cutters.
20. [CRM (P8 — M25)](20-crm.md) — **P8 COMPLETE (2026-05-28)** — Sales pipeline (5 stages, atomic stage-change RPC with audit), append-only activity log, tasks with priorities + due dates, pipeline report (count / total / probability-weighted). New 🤝 CRM nav group. Resend `contact@<domain>` inbound auto-logs to activity timeline. 2 notification triggers + daily tasks-due-tomorrow cron seeded.
21. [PIM — Product Information Management (P8 — M42)](21-pim.md) — **P8 COMPLETE (2026-05-28)** — centralized product catalog with 3-level category tree, per-category attribute schema (mutable via API), per-style descriptions with draft/published lifecycle, image library with multi-size derivatives (Sharp pipeline: thumb 200px / web 800px / print 2400px). New Product Catalog panel under 📚 Master Data with 3-tab Style Detail editor.
22. [Shadow Mirror (Cross-cutter T10 — Xoro ⇄ Tangerine)](22-shadow-mirror.md) — **T10 COMPLETE (2026-05-28)** — nightly cron that mirrors Xoro AR / AP / inventory into Tangerine sub-ledgers + posts 3 daily summary JEs so reports / CRM / Cases populate against real numbers without operator dual-entry. Source-tagging (`manual` / `xoro_mirror` / future channels) on every sub-ledger row; mirror never touches `source='manual'`. `🔁 Shadow Mirror` status panel with 30-day history grid + unmatched-customer / unmatched-vendor inboxes + manual re-run. **§22.17 Cutover Reconciliation (2026-07-21)** — read-only Admin dashboard (`m=cutover_recon`) tying Tangerine to the Xoro mirror across six domains (Inventory, SO, PO, AR, AP, GL) with PASS/FAIL cards + xlsx export, to watch the gaps burn to zero before go-live.
23. [Searchable Dropdowns (Cross-cutter T9)](23-searchable-dropdowns.md) — **T9 COMPLETE (2026-05-28)** — drop-in `<SearchableSelect>` component replacing native `<select>` on every long-list dropdown (DB-backed lists, > 10 options, code + name labels). 25 swaps across 11 panels. ARIA combobox a11y, keyboard nav, 200-item visible cap. Forward rule: every new panel with a long dropdown ships SearchableSelect in the same PR.
24. [User Access & Permissions (P14 RBAC)](24-user-access-rbac.md) — **P14 schema + middleware shipped, enforcement OFF by default (2026-05-30)** — per-module × per-action permission matrix on top of entity membership. 3 seed roles (admin / accountant / viewer) + per-cell grant/revoke overrides; `v_effective_permissions` = grants ∪ grant-overrides − revoke-overrides. `RBAC_MODE` env rolls out off → log (dry-run) → enforce (403). RBAC tables are anon-read-only; all writes go through the service-role admin API. **User Access** panel (Analytics & Admin) shows the matrix + role dropdown + override checkboxes; every change is T11-audited.
25. [Sign-in & Per-User Identity (JWT bridge)](25-sign-in-and-identity.md) — **built, inert until `SUPABASE_JWT_SECRET` is set (2026-05-31)** — the MS-OAuth provision endpoint mints a short-lived signed per-user token; the browser attaches it as `Authorization: Bearer` on every internal call and the server verifies it locally. The static deploy token moves to `X-Internal-Token`. This is the prerequisite that makes RBAC `enforce` actually per-user. Activation = add the Supabase JWT secret to Vercel env; zero behavior change until then.
26. [Brand Master & GL Allocation (P15 + M50)](26-brand-master-gl-allocation.md) — **built, gated by `BRAND_SCOPE_MODE`, default OFF (inert)** — brand as a sub-dimension of entity; stock-pool inventory partitions + partition-aware FIFO; M50 per-brand P&L split across manual-JE / AP / Income-Statement via `{code}-{BRAND}` child accounts. AR is not split. Go-live = assign item brands → flip `BRAND_SCOPE_MODE=enforce`.
27. [Sales Orders, Allocations & Shipping (P16 — M10 + M18 + M44)](27-sales-orders-allocations-shipping.md) — **P16 Sales core COMPLETE** — SO entry → confirm → draft-AR-invoice lifecycle, factor / credit-insurance ship-gate, multi-store split, M18 allocations (per-SO soft reservation + the cross-SO **Allocations Workbench** with priority tiers & fill modes), M44 carrier shipping. FIFO/COGS posts at AR-invoice post, not at allocation.
28. [Purchase Orders & the Size Matrix (M11 + Matrix initiative)](28-purchase-orders-and-size-matrix.md) — native **M11 PO** module (draft → issued → in_transit → received), the 6-axis matrix primitive + **Size Scale** master (`SCALE-NNNNN`), matrix grids wired into Inventory / SO / Adjustments, the Inventory Matrix panel, and prepack matrices + Explode-PPK. Consumers must pass `axisValues={{size: scaleSizes}}` for column order.
29. [B2B Wholesale Portal (P18 — M40 + M41)](29-b2b-wholesale-portal.md) — **MVP shipped; has go-live config TODOs** — the `/b2b` magic-link portal (own GoTrue session via `resolveB2BSession`), per-customer pricing, cart → draft SO (`origin=b2b_portal`), account / invoices / reorder; internal **B2B Buyers** + **Price List** admin panels. `b2b_price_list` is interim pricing pending M43.
30. [Masters, Sales, CRM & HR — Operator Batch (P16)](30-masters-sales-crm-hr-batch.md) — new reference masters (Countries / Genders / Group-Category-Sub / Factors), auto-generated codes (CUST/VEND/EMP/FAB/FCT/TERM/PPKM/SCALE; GL/Style/Country/Gender/Brand stay manual), customer factoring, 360° scorecards, employees + Wholesale/Closeout commissions (Closeout = margin ≤ 14%), the P&L Dilution line, and the navigation reorg. **Sales Reps is no longer its own master — reps are sales-role employees.**
31. [Pricing Engine (P15 — M43)](31-pricing-engine.md) — `price_lists` / `price_list_items` (qty breaks) / `price_promotions`, customer → price-list assignment, the unified resolution precedence (customer-own → assigned → tier → default + best promo), and SO-line price auto-fill. Inert until lists have prices.
32. [Procurement — Receiving & Bookkeeper Approval (P13)](32-procurement-receiving.md) — the 💲 Procurement nav group: receiving against a native PO, QC inspections + dispositions, customs entries + broker invoices, 3-way match, reconciliation inbox, and the deferred procurement GL postings (GRNI / GR-IR clear / landed-cost reval / QC write-off).
33. [Inventory Planning ⇄ Tangerine (M31 / P17)](33-inventory-planning-to-tangerine-po.md) — both directions: **(A)** approved buy plan → draft native Tangerine POs (Preview/dry-run, cost fallback, coded skips, one-click vendor linking, persistent action→PO deep-link); **(B)** a per-run **supply-source choice** — reconcile against the Xoro/ATS mirror (default) or native Tangerine on-hand + open POs (`🍊 Sync Tangerine supply`).
34. [Customer Returns & RMA (P19 / M23)](34-returns-rma.md) — the reverse sales flow: raise an RMA, disposition each line (restock → back to FIFO + COGS reversal; scrap → credit only), then issue a credit memo (revenue → Sales Returns & Allowances 4100, reduces AR). Lifecycle requested→approved→received→credited.
35. [Drop-Ship (P20 / M49)](35-drop-ship.md) — vendor ships direct to the customer (no warehouse, no inventory movement): capture customer + vendor + lines (customer price vs vendor cost → margin), run the lifecycle requested→confirmed→shipped→delivered→closed with carrier/tracking. AR/AP document generation deferred (blocked on the COA).
36. [Third-Party Logistics — 3PL (P21 / M13)](36-3pl.md) — contract-3PL provider master + inbound/outbound/return shipment tracking (lifecycle draft→in_transit→received→closed, carrier/tracking). Inventory relocation + fee posting deferred.
37. [EDI — Electronic Data Interchange (P22 / M14)](37-edi.md) — surfaces the existing vendor-side X12 engine: enable EDI for a vendor (partner/ISA ID) + a global message log (850 PO · 855 ack · 856 ASN · 810 invoice · 820 payment · 997). Transport + retailer-side EDI deferred.
38. [Reports & Analytics hub (P24 / M9-full + M46)](38-reports-hub.md) — one landing tying together every financial + operational report, with live finance KPI tiles (open AR/AP, inventory @ cost, open SOs, current period).
39. [Fixed Assets · Budgets · 1099 (P25)](39-finance-fixed-assets-budgets-1099.md) — fixed-asset register + straight-line depreciation (M21), GL budgets + budget-vs-actual (M22), and a year-end 1099-NEC worksheet (M20). Sales Tax + Public API deferred.
40. [Inventory Planning — Reports (P17)](40-planning-reports.md) — the **📊 Reports** hub at `/planning/reports`: four analytical reports (Sales Performance with YoY + ABC, Inventory Health with weeks-of-supply + stockout/excess, Forecast Accuracy MAPE/bias, Buy Plan & Supply), each viewable on screen and one-click **Excel** export.
41. [External / Partner API (M15)](41-external-partner-api.md) — a read-only REST API at `/api/external/v1` for authorized integrations, authenticated with a Bearer **API key**. Covers the key admin panel (**Admin → 🔑 API Keys**), the auth model, and every endpoint with example `curl`.
42. [Costing Module](42-costing-module.md) — the `/costing` price/cost workbook: project-header gating, the costing grid (FOB/Landed vs **DDP** cost modes, editable **Sell Tgt** margin that back-solves cost), PPK-exploded PO history + LY/T3 comp, the incomplete-row guard, and the RFQ → compare → award flow.
45. [Lot Numbers](45-lot-numbers.md) — per style+color **lot** on PO / SO lines + inventory layers (not on Style Master): auto-stamped to the PO# at issue, inherited from the SO's customer PO on a PO-from-SO, editable via the 🏷 lot column, and carried onto the FIFO layer at receiving.
46. [Today Page](46-today-page.md) - your daily starting point: per-user to-dos (approvals, vendor replies, 3-way exceptions, receipts due, QC failures, chargebacks, close state), active-process status cards (mirror, EDI), and current-state suggestions - RBAC-scoped, every row drills to its panel.
47. [Assistant draft actions (P28-4)](47-assistant-draft-actions.md) - the assistant graduates from reading/routing to **drafting an action you confirm**: a single-unambiguous chargeback-match suggestion (Confirm writes the link) and copyable vendor/customer email drafts (compose-only, nothing sent or saved). Every write shows a Confirm card first; the assistant never self-executes, and money actions still route through approvals.

## 30-second quickstart

1. **URL:** `https://<your-domain>/tangerine`
2. **Top nav:** 6 module buttons across the top — 🎨 Style · 🏭 Vendor · 🤝 Customer · 📒 COA · 🗓️ Periods · 📓 Journal Entries. Click any one to open that panel.
3. **Other apps:** click the **🧩 Apps ▾** button on the right of the top nav to launch Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning, or Vendor Portal.
4. **First time?** Run the smoke test in [01-getting-started.md § Quickstart smoke test](01-getting-started.md#quickstart-smoke-test-10-minutes)

## Conventions in this guide

- **`code-style`** = exact field / column / value names
- 🟢 / 🟡 / 🔴 = period status colors (open / soft_close / closed)
- "(Chunk N)" tags indicate which implementation chunk shipped the feature, for cross-referencing the architecture doc
- Mermaid diagrams render natively on GitHub; if you're viewing this in another renderer, you may see raw code blocks instead
- Screenshots in `screenshots/` show real UI state from the production deploy (PII redacted where applicable)

## Related docs

- [`../P1-foundation-architecture.md`](../P1-foundation-architecture.md) — the full architectural spec for P1 (schemas, RLS, posting service, trigger semantics). Reference when you need to understand *why* a behavior exists.
- [`../P2-cross-cutters-architecture.md`](../P2-cross-cutters-architecture.md) — P2 (Approvals · Notifications · Documents · HR/Employees) architecture pass. Implementation in progress; user-guide chapters land alongside each chunk's UI.
- [`../accountant-coa-request-email.md`](../accountant-coa-request-email.md) — forwardable email template asking the accountant for the canonical COA list (gates the first Chart of Accounts seeding).

## P2 progress

- **P2-1 + P2-2 (merged 2026-05-27):** M27 Workflow/Approvals complete — schema, library, JE posting guard, and admin UI for both rules and inbox. See chapter 7. Dormant until rules are defined.
- **P2-3 + P2-4 (merged 2026-05-27):** M28 Notifications complete — schema, dispatcher library, admin UI (inbox + preferences), and email cron worker. See chapter 8. Dormant until a downstream caller invokes `notificationsAPI.enqueue`.
- **P2-5 + P2-6 (merged 2026-05-27):** M29 Document Management complete — schema, library, reusable `DocumentAttachmentList` component embedded in Vendor + Customer Master edit modals. See chapter 9. **Operator must create the `tangerine-documents` Supabase Storage bucket once** before uploads work (see MIGRATIONS.md).
- **P2-7 + P2-8 (merged 2026-05-27):** M30 HR/Employee Master complete — schema, view, admin panel. See chapter 10. Seed inserts EB001/CEO for ROF entity.

**P2 cross-cutters phase is feature-complete pending auto-apply.** All schemas, libraries, UI panels, and reusable components have shipped. Outstanding items are operational: (a) DB password sync to unblock auto-apply on the schema migrations; (b) one-time Supabase Storage bucket creation for M29.

## How this guide stays current

> **NON-NEGOTIABLE WORKING CONVENTION:** at the end of **every phase (and every module that lands)**, this user guide MUST be updated **in the same PR** that ships the feature — a new chapter for a new phase/module, or an edit to the existing chapter for a change to an existing surface. This sits alongside the standing rule to update `docs/tangerine/BUILD-PROGRESS.md` at each phase/module landing. A phase is not "done" until both docs reflect it. Do not defer doc updates to a later sweep.

Forward, this guide ships chunk-by-chunk: every Tangerine PR that adds or changes a UI surface includes the matching guide update in the same PR. This is a doc-maintenance convention, not a contract you need to know about — but if you spot a discrepancy between what you read here and what the panel actually does, that's a stale-doc bug we want to hear about.

The initial 6 P1 panels (this chapter set: 01–06) were back-filled in a single catch-up sweep against the post-P1 state of the code (`/tangerine` app, top-nav group dropdowns, P5-1 period close mechanics, P2-5/P2-6 document attachments on master records). Each chapter has been grounded against the matching source files; if you find a claim that doesn't match the UI, that's a sweep miss and we owe you a fix.

## Feedback

Spotted an error in this guide? Missing a workflow? Open a Github issue against the design-calendar-app repo or DM the developer.
