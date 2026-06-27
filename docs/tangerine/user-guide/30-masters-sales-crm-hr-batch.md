# 30. Masters, Sales, CRM & HR — Operator Batch (P16)

> **P16 status (2026-06-02):** all chunks shipped to prod (PRs #701–#718 + follow-ups #735–#785). This is the "everything else" chapter: the many smaller Sales / CRM / HR / master-data features that the dedicated chapters — Brand (ch26), Sales Orders (ch27), Matrix (ch28), B2B portal (ch29) — do **not** cover. Several items are *config-inert* until the operator does a one-time setup (tag dilution GL accounts, set commission rates, assign customer factors); those are collected under "What's NOT yet usable" at the end.

P16 was delivered as a long series of operator-requested batches rather than one module. The work clusters into eight themes, documented in order below. Where a feature has its own home, this chapter points there (e.g. the SO ship-gate mechanics live in [ch27](27-sales-orders-allocations-shipping.md); the three core masters in [ch02](02-master-data.md)).

---

## 30.1 New reference-master panels

Four new global / entity-scoped reference masters landed under **📚 Master Data**. They all share the simple `list + search + add` skeleton described in [ch02](02-master-data.md), with a `?q=` ilike search, an "include inactive" toggle, and a `sort_order` column for manual ordering.

| Panel | Route | Scope | What it holds |
|---|---|---|---|
| **Countries** | `/tangerine?m=countries` | Global (entity-agnostic) | `country_master`: `iso2` (2-letter, uppercased), `name`, `phone_code` (E.164 calling code, e.g. `1`, `86`, `880` — the source of the Vendor master's phone dial-code dropdown), `sort_order`, `is_active`. Search matches iso2 OR name. |
| **Genders** | `/tangerine?m=genders` | Global | `gender_master`: `code`, `label`, `sort_order`, `is_active`. Seeded M/W/B/G/C/T/U. Search matches code OR label. |
| **Group / Category / Sub** | `/tangerine?m=style_classifications` | Entity-scoped (ROF) | `style_classifications`: one table, three `kind`s — `group`, `category`, `sub_category`. Filter by kind; search on name. |
| **Factors / Insurance** | `/tangerine?m=factors` | Entity-scoped (ROF) | `factor_master`: a receivables financier / insurer with a full contact profile (`name`, `contact_name`, `phone`, `email`, `website`, `address` jsonb, up to **3 additional contacts** `contacts` jsonb {name·phone·email·title}, `api_enabled`, `notes`). The address Country/State are searchable dropdowns (the old standalone Country picker was removed — it duplicated the address one); email shows a ✉ click-to-send link and phones auto-mask to (XXX) XXX-XXXX. |

Notes that matter:

- **Countries and Genders are global** — they have no `entity_id` and are shared across all entities. Group/Category/Sub and Factors are scoped to the default ROF entity.
- The **Add-Gender** modal auto-fills `code` from the uppercased first letter of `label` (Men→`M`, Women→`W`, Boys→`B`, …) as an *editable* default (#764). Typing your own code makes it stick. The Edit modal keeps `code` immutable.
- **Factor codes are auto-generated** (`FCT-…`) — see [§30.2](#302-auto-generated-codes). Country, Gender, and Group/Category/Sub codes are operator-entered.

The **Factors / Insurance** master is the lookup behind customer factoring ([§30.3](#303-customer-factoring--insurance)).

---

## 30.2 Auto-generated codes

Before P16 the operator typed the `code` for every new master row by hand. Chunk M (#717) moved six masters to **server-generated, read-only codes**: the handler counts existing rows carrying the prefix, adds 1, zero-pads to 5 digits (e.g. `CUST-00001`), and a small retry bumps the number on the rare concurrent collision. Any client-supplied `code` on those panels is now ignored.

The rule, stated precisely:

| Entity | Table | Prefix | Auto-coded? |
|---|---|---|---|
| Customers | `customers` | `CUST-` | ✅ auto |
| Vendors | `vendors` | `VEND-` | ✅ auto |
| Employees | `employees` | `EMP-` | ✅ auto |
| Fabric codes | `fabric_codes` | `FAB-` | ✅ auto |
| Factor / Insurance | `factor_master` | `FCT-` | ✅ auto |
| Payment Terms | `payment_terms` | `TERM-` | ✅ auto |
| GL accounts | `gl_accounts` | — | ❌ manual (accountant-chosen account numbers) |
| Style Master | `style_master` | — | ❌ manual (human-readable design identifier) |
| Country | `country_master` | — | ❌ manual (`iso2`) |
| Gender | `gender_master` | — | ❌ manual (semantic code, auto-suggested from label) |
| Brand | `brand_master` | — | ❌ manual (see [ch26](26-brand-master-gl-allocation.md)) |

> **Source correction (vs. the working notes):** the auto-code helper `insertWithAutoCode` is *also* used by two later masters not in the original "six" — **Prepack Matrices** (`prepack_matrices`, prefix `PPKM-`) and **Size Scales** (`size_scales`, prefix `SCALE-`). The six in the table above are the P16 Chunk-M set; the inventory masters reuse the same generator. The "stays manual" set is exactly GL / Style / Country / Gender / Brand as the notes stated.

The generator lives in `api/_lib/autoCode.js` — `nextCode()` computes the next string, `insertWithAutoCode()` wraps the insert with the collision retry. Codes are **suggestions, not a strict monotonic sequence** (deletes leave gaps); a `(entity_id, code)` unique index is the real guarantee.

---

## 30.3 Customer factoring & insurance

P16 Chunk K (#714) added a factoring relationship to the customer record so a financed/insured customer's shipments can be gated on factor approval.

On the **Customer Master** record (`customers` table):

- **`is_factored`** (boolean) — flags the customer as factored / credit-insured.
- **`factor_id`** (uuid → `factor_master.id`) — which factor/insurer covers them, picked from the [Factors / Insurance master](#301-new-reference-master-panels).

These are the **master-data side** of the gate. The actual enforcement is on the sales order:

- A Sales Order carries `factor_approval_status`, `factor_approved_cents`, `factor_reference`, `factor_source`.
- The **ship-gate** (`POST /api/internal/sales-orders/:id/ship`): if the SO's customer has `is_factored = true` and the SO's `factor_approval_status ≠ 'approved'`, the ship call is rejected with a 409 — *"Factored customer — factor approval required before shipping."* See [ch27 § factor gate](27-sales-orders-allocations-shipping.md) for the full SO-side mechanics.

The Customer scorecard ([§30.4](#304-360-scorecards)) consumes the same data for dilution/commission math.

---

## 30.4 360° scorecards

Chunk E (#708) added two drill-through scorecards reachable from a labeled **"📊 Scorecard"** button on Customer / Vendor master rows (#722), and as nav-reachable panels:

| Scorecard | Route | Returns |
|---|---|---|
| **Customer Scorecard** | `/tangerine?m=customer_scorecard` | Header (customer + up to two sales reps with their commission %s), metrics (open AR balance, avg days-to-pay, by-brand, by-gender, period blocks for This-Year / This-Month / Last-Month / LY-same, commission, dilution, margin, net profit), plus Invoices / Sales-Orders / Journal-Entries tabs. |
| **Vendor Scorecard** | `/tangerine?m=vendor_scorecard` | Header (vendor + country), a **Vendor Health** tile (overall score /100 + A–F grade, pulled from the same source as the **Vendors → Vendor Health** panel), purchase/delivery metrics (avg lead-time days, % on-time vs promised, AP balance), plus AP-invoice and PO tabs. |

Data-source honesty is baked in — each metric is computed from a documented source, and metrics with no honest source return `null` with a "needs X" caption rather than a fabricated number. For example:

- **Customer `by_brand`** comes from `sales_orders.total_cents` grouped by `brand_id` (AR invoices carry no brand column).
- **Customer `dilution`** is `Σ(DR−CR)` on `contra_revenue` / `dilution` JE lines for JEs sourced from that customer's invoices — and shows **0 with a caption** until dilution GL accounts exist (see [§30.6](#306-pl-dilution-line)).
- **Customer `commission`** is split by **closeout**: This-Year net sales (gross − dilution) from invoices whose sales order is flagged **closeout** (`sales_orders.is_closeout`, ticked via the **Closeout order** checkbox on SO entry) use the customer's **closeout commission rate** (`customers.closeout_commission_pct`, set on the Reps tab); the rest use the normal `sales_rep_1% + sales_rep_2%`. The scorecard reports `closeout_sales_cents`, `closeout_commission_pct`, and a blended effective `commission_pct`. When no closeout rate is set, the normal rate applies to everything (unchanged behaviour).
- **Vendor `pct_ontime_required`** is deliberately `null`: the PO schema has no separate required-vs-actual delivery date, so it would be dishonest to compute one.

> **Note:** the **Vendor Scorecard** here (P16, `m=vendor_scorecard`) is the financial/360° drill-through. It is *separate* from the older procurement **Vendor Scorecards** performance grid in the PO-WIP app (`/tanda?view=scorecards`, handler `api/_handlers/internal/scorecards/`), which scores on-time delivery / invoice accuracy / acknowledgment.

### Drill-through to the underlying transactions

**Vendor Scorecard — per-line drill opens in a new tab (2026-06-05).** The vendor scorecard's "Drill to:" bar, clickable metric tiles, and per-tab "Open in … ↗" buttons have been **removed**. Instead, **each transaction line in the AP-Invoices and POs tabs is now clickable** (cursor pointer + row hover highlight + a small ↗ next to the doc number). Click (or double-click) a line to **open that exact record in a new browser tab**:

| Tab line | Opens (new tab) | Deep-link |
|---|---|---|
| AP invoice row | AP Invoices panel | `/tangerine?m=ap_invoices&q=<invoice_number>` |
| PO row | Purchase Orders panel | `/tangerine?m=purchase_orders&q=<po_number>` |

The target panel reads `?q=` on mount and seeds its search box, filtering to the single matching record (`invoice_number` / `po_number` `ilike`) so the clicked transaction is the only row shown. Draft POs (no PO number) are not clickable. The vendor's name/code is always shown — never a raw UUID.

**Customer Scorecard — per-line drill opens an in-place popup (2026-06-15).** The customer scorecard's **"Drill to:"** bar and the per-tab **"Open in … ↗"** buttons have been **removed**. Instead, **each row in the Invoices / Sales Orders / Journal Entries tabs is clickable** (cursor pointer + row hover highlight; the number/date renders in the accent colour). Click a row to open that exact record in a **popup over the scorecard**:

- The popup shows the record's **header** (customer/date/status/total — for a JE: type + description) and its **line items** (invoice/SO: item/description · qty · unit · line total; JE: account *(resolved to `code — name`, never a UUID)* · memo · debit · credit).
- **✎ Edit (new tab)** opens the full record in the matching module in a **new browser tab** (`?m=ar_invoices|sales_orders|journal_entries&q=<number>`), so the scorecard stays open behind it.
- **✕** (or the backdrop, or **Esc**) closes the popup and **returns you to the scorecard** unchanged.

Sourced from the existing single-record endpoints (`/api/internal/ar-invoices/:id`, `/sales-orders/:id`, `/journal-entries/:id`); the metric tiles still drill in place as before.

---

## 30.5 Employees, titles/departments & commissions

Chunk G (#707) plus the title/department migration (#770 nav + #768 modal polish) extended HR:

### Employee Titles & Departments masters

| Panel | Route | Table |
|---|---|---|
| **Employees** | `/tangerine?m=employees` | `employees` |
| **Employee Titles** | `/tangerine?m=employee_titles` | `employee_titles` — `name`, **`is_sales_role`** flag, `sort_order` |
| **Employee Departments** | `/tangerine?m=employee_departments` | `employee_departments` — `name`, `sort_order` |

An employee now carries `title_id` and `department_id` FKs (the older free-text `title` / `department` columns are still written for back-compat).

### Sales-rep commission rates (Wholesale vs Closeout)

The `employees` table gained two commission-percent columns:

- **`commission_wholesale_pct`** — commission on wholesale sales (**margin > 14%**).
- **`commission_closeout_pct`** — commission on closeout sales (**margin ≤ 14%**).

A **"closeout" for commission purposes is defined as any sale with margin ≤ 14%** (the rate columns hold the two %s per rep; the commission engine picks which rate applies by the sale's margin). Both rates are validated server-side to a number in `[0, 100]`.

The **`employee_titles.is_sales_role`** flag is what unlocks commission-rate entry on an employee — and it is also the new definition of "who is a sales rep."

### Sales Reps were unified INTO Employees (#785)

> **Source correction (vs. the working notes):** **Sales Reps is no longer its own master panel.** PR #785 retired the standalone Sales Reps master CRUD. **Employees flagged sales-role (`employee_titles.is_sales_role = true`) ARE the sales reps.** Specifics:
>
> - The `/api/internal/sales-reps` **GET** now searches sales-role employees; the **POST** returns **410 Gone** ("create reps via Employees"); the `[id]` master-CRUD route was deleted.
> - The `sales_reps` table itself is **kept** as the commission-subledger identity anchor (FK target of `commission_accruals` / `payouts` / `tiers` / `assignments` + `costing_projects`). A per-employee shadow `sales_reps` row is resolved-or-created on demand (`sales_rep_for_employee`, `employee_id` now UNIQUE), copying name/email/wholesale %.
> - Global search `sales_rep` results now route to the **Employees** module (the old `/sales-reps/` deep-link was dead).
> - This carried zero data-loss risk: all rep/commission tables were empty in prod at unification time.
>
> The earlier "Sales Reps panel" described in [ch19 § M17](19-revenue-operations.md#192--m17--sales-reps--commissions) is the historical P7 surface; for P16-onward, manage reps through **Employees** + a sales-role title.

---

## 30.6 P&L Dilution line

P16 item 2 (#702) added a **Dilution** section to the Income Statement, presented between gross **Revenue** and **Net Revenue**.

Mechanically (`20260712140000_p16_income_statement_subtype.sql`): the `income_statement(entity, basis, from, to)` RPC and the `v_income_statement` view now **return `account_subtype`**. Dilution is modeled as:

- `account_type = 'contra_revenue'`
- `account_subtype = 'dilution'`

The RPC already nets *all* `contra_revenue` out of revenue (sign convention: contra-revenue = `debit − credit`); the only change is surfacing the subtype so the UI can break dilution out as its own line instead of lumping it with returns/discounts. Returns/discounts use a different subtype (or NULL) and stay netted but un-broken-out.

Until the operator **tags** GL accounts with `account_subtype = 'dilution'`, the dilution line is **empty / $0** — the data path is correct but there's nothing to show. (The same accounts drive the Customer scorecard dilution metric in [§30.4](#304-360-scorecards).)

---

## 30.7 Navigation reorganization

A run of nav PRs (#736, #738, #739, #748, #770) reshaped the Tangerine top nav. The current shape (from `src/lib/menuKeys.ts`, registry v9):

- **Sales vs Customers split.** Sales-side panels (Sales Orders, Allocations, **Sales by Rep**) live under **Sales**; customer-side reporting (**Sales by Customer**, **Customer Scorecard**) under **Customers**.
- **AR grouped under "Customers – Accts Rec"** (#748): AR Invoices, AR Receipts, AR Aging, AR Backfill all moved here from generic Accounting.
- **Vendors is a top-level section** (#739) — previously nested inside Accounting. Vendor Master, **Vendor Scorecard**, and **❤️ Vendor Health** (relocated from Reports → Health Scores, 2026-06-05) sit under it.
- **"Operations" → "Inventory"** (#738/#736): the old Operations section folded into **Inventory** (Purchase Orders, Inventory Matrix, Prepack Matrices, Transfers, Adjustments, Cycle Counts).
- **Scorecards/Reports regrouped** (#770): scorecards became nav-reachable under Vendors / Customers; the standalone Sales-Reps master entry and the On-Hand-by-Pool report were dropped from the menu.
- **HR** now lists Employees + Employee Titles + Employee Departments.
- **Signed-in user name** (not email) is shown in the header (#712) — part of the broader name-not-email push in [§30.8](#308-ux-polish-sweep).

---

## 30.8 UX polish sweep

Chunks J / L (#715, #716) and follow-ups bundled app-wide quality items:

- **Name, not email / UUID.** User-facing raw UUIDs were replaced with a resolved name (or `—`) across SalesOrders, AP/AR Invoices, AR Receipts, Anomalies, SCF, Discount Offers, RFQ detail, Shopify refunds, Bank Reconciliation, Compliance Audit, Vendor/Customer Master payment-terms, and several inventory-planning cells. IDs are still kept in keys, payloads, navigation, and accountant-only JE/audit references.
- **Row-click sweep.** The `useRowClickEdit` + `ScrollHighlightRow` primitive was extended to Payment Terms, Fabric Codes, AR Receipts, Product Catalog, Employee Departments, Employee Titles, and Approval Rules. Per-row action buttons `stopPropagation`. Div-grid and read-only panels were intentionally left alone (the primitive is `<tr>`-only).
- **Brand in global search** (#716): `v_global_search` was extended with a `brand_master` branch and brand name/code folded into the style `search_doc`, so a brand query surfaces both the brand and its styles. The search palette gained a brand entity type/badge routing to the Product Catalog. (Brand-on-style/catalog itself is [ch26](26-brand-master-gl-allocation.md).)
- **Fabric COO dropdown** (#715): the fabric country-of-origin field became a dropdown backed by the new [Countries master](#301-new-reference-master-panels) instead of free text.
- **gender_code normalization & backfill** (#744): `ip_item_master.gender_code` and `style_master.gender_code` were both empty; an idempotent backfill filled them from `ip_item_master.attributes->>'gender'` (the authoritative ATS/Xoro signal). `ip_item_master` keeps the **raw Xoro code** (`{M,WMS,B,C,G,U}`); `style_master` gets the **canonical UI code** (`{M,B,C,G,W,U,T}`, with `WMS → W`) derived from its SKUs, **only when all variants agree** (ambiguous styles left NULL). The backfill only fills blank/invalid values and never overwrites a valid code.

---

## What's NOT yet usable / operator TODO

These features are wired but **inert until a one-time operator setup**:

1. **P&L Dilution line is empty** until you **tag GL accounts** with `account_type = 'contra_revenue'` and `account_subtype = 'dilution'` (use the COA subtype dropdown). Same gate makes the Customer scorecard's dilution metric show 0.
2. **Commissions are 0** until you **set per-rep commission rates** — give an employee a sales-role title, then fill `commission_wholesale_pct` and `commission_closeout_pct`.
3. **The factored-customer ship-gate does nothing** until you **assign customer factors** — set `is_factored = true` and pick a `factor_id` on the relevant customers, and create the factor rows in the Factors / Insurance master first.
4. **Scorecards read thin** until there is transactional history (confirmed SOs, posted AR invoices, applied receipts) for the customer/vendor in question.

---

## Code map

Confirmed file paths (all under `C:\Users\Eran.RINGOFFIRE\design-calendar-app`):

- **Auto-code generator:** `api/_lib/autoCode.js` (`nextCode`, `insertWithAutoCode`); tests `api/_lib/__tests__/auto-code.test.js`.
- **New master handlers:** `api/_handlers/internal/countries/index.js`, `.../genders/index.js`, `.../style-classifications/index.js`, `.../factors/index.js`.
- **Auto-coded master handlers (CODE_PREFIX const):** `.../customer-master/index.js` (`CUST-`), `.../vendor-master/index.js` (`VEND-`), `.../employees/index.js` (`EMP-`), `.../fabric-codes/index.js` (`FAB-`), `.../factors/index.js` (`FCT-`), `.../payment-terms/index.js` (`TERM-`); plus `.../prepack-matrices/index.js` (`PPKM-`), `.../size-scales/index.js` (`SCALE-`).
- **Customer factoring + ship-gate:** `api/_handlers/internal/customer-master/index.js` (`is_factored` / `factor_id`); `.../sales-orders/ship.js` + `.../sales-orders/[id].js` (the 409 gate).
- **Scorecards:** `api/_handlers/internal/customer-scorecard/index.js`, `.../vendor-scorecard/index.js`; UI `src/tanda/InternalCustomerScorecard.tsx`, `src/tanda/InternalVendorScorecard.tsx` (+ `CustomerScorecard.tsx` / `VendorScorecard.tsx`). (Distinct from the procurement grid `api/_handlers/internal/scorecards/index.js`.)
- **Employees / titles / departments:** `api/_handlers/internal/employees/index.js` (+ `[id].js`), `.../employee-titles/index.js`, `.../employee-departments/index.js`; UI `src/tanda/InternalEmployees.tsx`, `InternalEmployeeTitles.tsx`. Schema `supabase/migrations/20260712160000_p16_employee_titles_depts_commission.sql`.
- **Sales-rep unification:** `api/_handlers/internal/sales-reps/index.js` (GET → employees, POST → 410); migration `20260715000000…` (`employee_is_sales_role`, `sales_rep_for_employee`, `v_global_search`).
- **P&L dilution:** `supabase/migrations/20260712140000_p16_income_statement_subtype.sql` (RPC `income_statement` + view `v_income_statement`).
- **Nav registry:** `src/lib/menuKeys.ts` (+ server mirror `api/_lib/menuKeys.js`).

### See also

- [ch02 — Master data (Style / Vendor / Customer)](02-master-data.md)
- [ch26 — Brand Master](26-brand-master-gl-allocation.md)
- [ch27 — Sales Orders (factor gate, allocations, ship)](27-sales-orders-allocations-shipping.md)
- [ch19 — Revenue Operations (historical P7 Sales Reps / Commissions)](19-revenue-operations.md)
