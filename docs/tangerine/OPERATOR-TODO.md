# Tangerine — Operator Action Items (things only the CEO can do)

> Living list of items **blocked on the operator** — external accounts, credentials, env vars, business decisions, and go-live switches. Agents append here whenever a build hits an operator dependency (same discipline as updating BUILD-PROGRESS). Check items off / strike them as done.

**Last updated:** 2026-06-04 (SaaS-finalize decision + user-guide screenshot list added)

---

## 🔴 Blocking — a build is waiting on these

| Item | Needed for | Detail |
|---|---|---|
| **Shopify store + Admin API token** | P11 Shopify (orders + COGS + product images) | `shopify_stores` is **empty in prod** (0 stores, no token) — the entire Shopify integration (order/refund/payout webhooks, COGS posting, product mirror, image re-host) is **dormant** until a store + Admin API token are connected. |
| **`VENDOR_DATA_ENCRYPTION_KEY` on Preview** | Vendor portal field crypto on preview deploys | Set on Vercel **prod + dev**; the **Preview** environment still needs it or banking/card submit fails with "Encryption failed". ⚠️ Never change once data is encrypted (orphans all ciphertext). |
| **Paycor access** | M51 Payroll | Confirm your Paycor plan exposes a **GL export** (preferred) **or the API**, and get credentials (API key/OAuth, or SFTP). Usually a plan-tier/partner gate — ask your Paycor rep. Then: the **pay-code→GL mapping**, a **Net-Pay-Clearing vs Cash** choice, and whether to **brand-allocate labor** on day one. *(arch: `payroll-paycor-integration-architecture.md`)* |
| **Plaid credentials** | M7/M8 Bank feeds + reconciliation (live) | Live Plaid API keys / item link so bank + CC feeds pull real transactions (recon engine is built; needs the live connection). |
| **Stock-allocation rule** | P15 inventory stock-pool separation | How existing on-hand maps to the new WS/EC "store" pools. Recommended default: **all current stock → each brand's Wholesale pool**, tag new receipts going forward. (Or "import the Xoro store split.") |
| **Axel entity details** | Axel brand standup | Axel is a separate legal entity. Provide its legal name / tax / fiscal info to stand up the entity + brand, then its 15 unmapped `ip_item_avg_cost` rows get attributed. |

## 🟡 Go-live switches — when you're ready (operator-controlled, not blocking the build)

| Switch | Effect | Pre-req |
|---|---|---|
| `RBAC_MODE` = `log` → `enforce` (Vercel) | Turns on per-user permission enforcement | First configure roles in 🔐 User Access; run `log` a few days to watch telemetry, then `enforce`. The per-user JWT prerequisite is now live (`TANGERINE_JWT_SECRET` set), so `enforce` is technically unblocked. |
| `BRAND_SCOPE_MODE` = `log` → `enforce` (Vercel) | Activates ALL brand behavior, currently inert: brand/channel report filtering (C3), **M50 GL allocation auto-splitting** of postings into brand sub-accounts, and **P15 inventory pool separation** (FIFO draws from the brand pool). | **Sizable go-live — do the prereqs first (see the dedicated checklist below).** Run `log` first to watch telemetry, then `enforce`. Verify a brand-filtered report sums back to "All". |
| Xoro cutover gates (P9) | Retire Xoro per area | 2 consecutive months reconciling within tolerance; first gate (Cash) ~2026-07-28. |
| `VITE_TANGERINE_AS_HOME` = `true` (Vercel) | **Makes Tangerine the front door + retires the PLM launcher.** Root `/` then redirects to the standalone Tangerine login (`/login`, Microsoft-365 sign-in); from there users launch every other app via the 🧩 Apps menu. OFF today: `/` still shows the PLM launcher and `/login` is reachable directly for preview. | Build is done — flip when you're ready to retire the PLM launcher. Verify `/login` signs in and the 🧩 Apps menu reaches all apps first. Note: the other apps still use the username/password `plm_user` session for their own gating, so keep those credentials working (or migrate them) before fully dropping PLM. |

## 🟠 Module go-lives — config / data the operator must enter (the build is done)

These modules are **built and shipped** but produce nothing / stay inert until you supply the data or config below.

| Module | What to do |
|---|---|
| **P18 B2B Portal** (#719–#724) | (1) Supabase → Auth → URL Config → add `<origin>/b2b` to the **Redirect allowlist**; (2) configure the **magic-link email / SMTP** + template; (3) create active **`b2b_accounts`** rows (internal "B2B Buyers" panel); (4) assign customers a **price list** (now via M43, below). Until then buyers can't sign in / see pricing. |
| **M43 Pricing Engine** (#792–#794) | The engine is live but **inert until lists have prices**. Add entries to a **Price List** (💲 Pricing → Price Lists), set qty breaks / promotions, and assign customers a `price_list_id`. B2B + internal SO line auto-fill both read it. |
| **P13 Procurement** (#799–#822) | Build complete (PO→receive→QC→customs→3-way→close + all four GL postings). Remaining is the **per-vendor parallel-run cutover** — pilot vendor **Zhejiang Zhuji Newdan**: run Tangerine receiving alongside Xoro and reconcile before retiring the Xoro path for that vendor. |
| **M31 / P17 Planning → Tangerine (direction A: buy plan → PO)** (#827/#828/#875) | To turn a buy plan into draft Tangerine POs: (1) **populate `ip_vendor_master`** and assign a vendor to each buy recommendation; (2) **create + approve an execution batch** from the 7,807 recommendations in `/planning/execution`; (3) **link each planning vendor → its Tangerine vendor** (one-click 🔗 Link on the Execution screen, or set `ip_vendor_master.portal_vendor_id`). The CEO planning **admin** role is already granted. |
| **M31 / P17 Planning (direction B: Tangerine supply)** (#880) | Now available — on the `/planning` **Supply** screen click **🍊 Sync Tangerine supply**, then create a reconciliation run with **Supply source: Tangerine ERP** to reconcile against native Tangerine on-hand (~1.35M units synced). Native open-PO input stays empty until you issue POs in Procurement. No action required unless you want to use it. |
| **P&L Dilution line** (#701–#710) | Tag the dilution GL accounts `account_type='contra_revenue'`, `account_subtype='dilution'` so the Income Statement Dilution line populates. |
| **Sales-rep commissions** (#701–#717) | Set **Wholesale / Closeout %** on sales-role employees and assign reps + commission % on customers (Closeout = margin ≤ 14%). |
| **EDI** (P22, vendor-side) | EDI is built + surfaced (Procurement → 🔌 EDI) but **inert** until: (1) set `EDI_INBOUND_SHARED_SECRET` on Vercel; (2) configure each EDI vendor (partner / ISA sender ID) in the EDI Partners tab; (3) stand up the **AS2/SFTP/VAN transport** (your EDI provider) — Tangerine prepares/stores X12 but does not yet transmit. Retailer-side EDI (850 from Macy's/Ross → SO, 810/856 out) is not built. |
| **Internal notifications** (#829) | Per-employee notification **subscriptions** route internal alerts to staff emails. Verify `INTERNAL_ONBOARDING_EMAILS` (and any other `INTERNAL_*_EMAILS`) are set / employees subscribed — before #829 no internal alerts reached anyone. |

## 🔵 Decisions the operator must make

| Decision | Detail |
|---|---|
| **Finalize the SaaS build** (multi-tenant isolation) | The SaaS / multi-tenant initiative was deliberately **deferred** pending a real 2nd tenant or ~Xoro-decommission (verified 2026-06-02). Operator now wants it on the list to **finalize**. Four concrete deliverables make up "SaaS gap #1": (1) **GUC/session wiring** so the DB knows the current tenant per request; (2) **entity-scoped RLS** — today's 469 policies are anon-permissive / 0 entity-scoped, the headline risk is the browser→PostgREST path (server handlers already fail-closed); (3) an **entity claim in the per-user JWT** (the JWT bridge exists — `TANGERINE_JWT_SECRET` set — but carries no entity); (4) move the browser off the single shared anon key. **Operator call needed:** schedule this now vs. keep waiting for the 2nd tenant. It's a multi-week hardening phase, not a single PR — say the word and I'll scope it into chunks. _(see `project_saas_isolation_verified_2026_06_02` memory.)_ |

### 🟠 Brand-scope enforcement — go-live checklist (`BRAND_SCOPE_MODE=enforce`)

Everything below is **built and inert today**; flipping the flag turns it on. Do these in order:

1. **Configure brand allocations** on the P&L accounts that should split by brand (COA → account edit → Brand Allocation). Parent accounts with >1 brand auto-generate `{code}-{BRAND}` children.
2. **Assign brands to items / styles** (Style Master / item master `brand_id`) — today everything is tagged ROF by default, so all stock/sales would map to ROF pools until real brands are set.
3. **Decide existing on-hand handling** — currently forward-only (legacy stock is "(unpartitioned)"). If you want historical stock attributed to brand pools, do a one-time backfill (e.g. from a Xoro store export) — otherwise leave it.
4. ~~Build partition-aware FIFO consumption~~ ✅ **DONE (#692)** — a sale draws from its brand pool when enforcing; inert (draws all layers) until then. **No remaining P15 dev work** — the steps above/below are operator config only.
5. **Set `BRAND_SCOPE_MODE=log`** on Vercel; watch the silent-log telemetry for a few days; spot-check that a brand-filtered Income Statement / AR aging foots to the "All brands" total.
6. **Flip to `enforce`.** From then on: manual JE + AP postings auto-split by allocation %, reports filter by the brand switcher, and inventory separates by pool.

## 🖼️ User-guide screenshots to supply

The Tangerine user guide (`docs/tangerine/user-guide/`) needs images. **You take each screenshot and drop the PNG at the given path** (create `docs/tangerine/user-guide/screenshots/` if it doesn't exist), then it renders in the guide. **14 are already referenced (the link is live but the file is missing → shows broken)** — those are priority. The rest are net-new suggestions for chapters that describe a screen but have no picture.

### Priority — referenced in the guide but file is missing (14)

| Chapter | File to drop at `…/screenshots/` | Screenshot should show |
|---|---|---|
| 01 Getting Started | `01-tangerine-login.png` | Branded login: orange T logo + "Sign in with Microsoft" |
| 01 Getting Started | `01-tangerine-home.png` | Home landing: top nav + module cards by group |
| 01 Getting Started | `01-tangerine-apps-launcher.png` | 🧩 Apps dropdown open (all suite app links) |
| 02 Master Data | `02-style-master-list.png` | Style Master list (search, columns, rows) |
| 02 Master Data | `02-style-master-add-modal.png` | Add Style modal with all fields |
| 02 Master Data | `02-vendor-master-list.png` | Vendor Master list (Code, Name, Country, 1099?, Terms) |
| 02 Master Data | `02-customer-master-list.png` | Customer Master list with type filter |
| 03 Accounting | `03-coa-list.png` | Chart of Accounts list (Code/Name/Type/Balance/Control) |
| 03 Accounting | `03-coa-add-modal.png` | COA add modal (normal_balance auto-fills) |
| 03 Accounting | `03-coa-delete-blocked.png` | 409 "account has posted lines" alert |
| 03 Accounting | `03-periods-list.png` | FY2026 periods with status badges |
| 03 Accounting | `03-je-list.png` | Journal Entries list (posted + reversed) |
| 03 Accounting | `03-je-post-modal-balanced.png` | Post JE modal, green "● Balanced" |
| 03 Accounting | `03-je-post-modal-unbalanced.png` | Post JE modal, red "out of balance", Post disabled |

### Nice-to-have — chapters describing a screen with no image (suggested filenames)

| Chapter | Suggested file | Screenshot should show |
|---|---|---|
| 13 AP | `13-ap-invoices-list.png` / `13-ap-invoice-add-modal.png` / `13-ap-payment-modal.png` | AP invoice list, new-draft modal, payment capture |
| 16 AR | `16-ar-invoices-list.png` / `16-ar-invoice-add-modal.png` / `16-ar-invoices-filters.png` | AR invoice list, new-draft modal, filter row |
| 17 Bank Recon | `17-bank-recon-plaid-link.png` / `17-bank-recon-match-engine.png` | Plaid link / connected account; ±5-day match results |
| 20 CRM | `20-crm-sales-pipeline.png` / `20-crm-activity-log.png` | Pipeline stages; activity timeline |
| 21 PIM | `21-pim-product-catalog.png` | Category tree + style detail + image library |
| 24 User Access | `24-user-access-matrix.png` | Permission matrix (modules × actions) |
| 26 Brand/GL Alloc | `26-brand-allocation-editor.png` | Per-account brand % splits totalling 100% |
| 27 Sales Orders | `27-sales-order-list.png` / `27-allocations-workbench.png` | SO list; allocations workbench |
| 28 PO & Matrix | `28-purchase-order-list.png` / `28-size-matrix-grid.png` | PO list; size matrix grid |
| 29 B2B Portal | `29-b2b-portal-landing.png` | `/b2b` landing (account, invoices, reorder) |
| 30 Reference Masters | `30-countries-genders-master.png` | Countries/Genders master with auto-codes |
| 31 Pricing | `31-price-list-editor.png` | Price list + qty breaks + promotions |
| 32 Receiving | `32-receiving-against-po.png` | Receiving against PO + QC dispositions |
| 33 Planning⇄Tangerine | `33-create-tangerine-pos.png` | Buy plan → "Create Tangerine POs" flow |
| 34 Returns/RMA | `34-rma-lifecycle.png` | RMA raise→approve→receive→credit |
| 35 Drop-Ship | `35-dropship-order.png` | Drop-ship order + margin + tracking |
| 36 3PL | `36-3pl-shipment.png` | 3PL shipment lifecycle |
| 37 EDI | `37-edi-message-log.png` | EDI message log (doc types + status) |
| 38 Reports Hub | `38-reports-landing.png` | Reports hub KPI tiles + report links |
| 39 Fixed Assets/Budgets/1099 | `39-fixed-asset-register.png` / `39-budget-vs-actual.png` | Asset register; budget-vs-actual variance |

## ✅ Done

- **Chart of Accounts loaded** (#908, 2026-06-04) — the full COA from your QuickBooks export: **474 new accounts** (+ the 52 existing kept) grouped under **reporting headers** via `parent_account_id`, control accounts pinned (**AR 1200 · AP 2000 · Revenue 4000 · COGS 5000**), and the **entity default accounts wired** (AR/AP/Revenue/COGS/Inventory 1300/Bank 1000/Retained Earnings 3900). AR/AP/COGS posting + drop-ship document generation are now **unblocked**. ⚠️ **Review** `Downloads/COA_assigned_mapping_for_review.csv` and tell me any account that should be re-typed or re-grouped. A few legacy operational accounts (e.g. Inbound Freight 5100, Sales Commissions 6210, Inventory Write-off 6420) overlap conceptually with new ones — they coexist; say the word to merge.
- **`ip_item_master` dup-SKU cleanup** (#867 / #872 / #874 / #866) — the ~7,047 duplicate rows are merged + a logical `UNIQUE` backstop + dup-proof SKU resolver are in place. Prod now: 12,691 rows, only **14 residual dup rows in 4 groups** (down from ~7k). No operator decision needed.
- **CEO planning `admin` role** granted (#875) → the buy-plan → Tangerine-PO buttons are usable; `run_writeback` / `manage_integrations` available.
- **`VENDOR_DATA_ENCRYPTION_KEY`** set on Vercel **prod + dev** (Preview still pending — see 🔴 above).
- **`TANGERINE_JWT_SECRET`** set on Vercel (`design-calendar-app` project) → JWT identity bridge live.
- **M50 GL Brand Allocation** design signed off (4 open items resolved).
- **Brand model** finalized (8→10 brands, channels, partitions, allocation engine).

---

## How to use
Agents: when a chunk needs something only the operator can provide (a credential, an external-account setting, a business rule, a flag flip), add a 🔴 row here with what + what-it-unblocks, instead of silently stalling. Move it to ✅ when done. The operator works from this list.
