# 11 — Tangerine ERP (Overview)

Tangerine is Ring of Fire's full ERP — the system that replaces Xoro for running the business end to end. It is where the company's accounting, money in and out, inventory, buying, selling, shipping, customer relationships, product catalog, pricing, and reporting all live in one place. This chapter is the **map**: it tells you what Tangerine covers, how to get into it, and where to go for the step-by-step detail.

> **This is an overview and index, not the full manual.** Tangerine already has its own 40-plus chapter guide. Each topic below links straight to that chapter. Read this page to find your bearings, then follow the link for how-to detail.

## What Tangerine is

Tangerine is the back office for the whole company. Think of it as everything Xoro used to do — and more — rebuilt as a single connected system:

- **Accounting** — the chart of accounts, fiscal periods, and journal entries that form the company's books.
- **Money owed to us (AR)** — customer invoices, receipts, aging, and credit limits.
- **Money we owe (AP)** — vendor bills, approvals, and payments.
- **Inventory operations** — transfers, adjustments, cycle counts, and the scanner.
- **Procurement and receiving** — purchase orders, receiving, quality inspection, customs, and three-way matching.
- **Sales, allocations, and shipping** — sales orders, reserving stock to orders, and getting it out the door.
- **CRM, PIM, and pricing** — the sales pipeline, the product catalog, and how prices are set.
- **Returns, drop-ship, 3PL, EDI** — the less-common flows for handling returns, vendor-direct shipments, outside warehouses, and electronic trading.
- **Reports and finance** — a single reports hub plus fixed assets, budgets, and 1099 worksheets.

## How to reach it — the front door

Open your browser to **`/tangerine`** (for example `https://<your-domain>/tangerine`). If you already signed into the suite through the **PLM launcher** (username + password) and open Tangerine from a launcher card or 🧩 Apps menu, Tangerine takes you **straight in** — it adopts that session and does **not** ask you to sign in again. The **Sign in with Microsoft** screen appears only when you open Tangerine cold with no existing suite session (the standalone front-door case).

> **Tangerine is becoming the front door of the whole suite.** Today you can launch the other apps (Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning, Costing, Vendor Portal) from the **🧩 Apps** menu in the Tangerine top nav. The plan is to make Tangerine the single sign-in and home for everything — sign in once, then launch any app from one place.

Inside Tangerine, the top navigation is organized into section dropdowns (Master Data, Accounting, Treasury, Vendors, Procurement, Inventory, Sales, Customers, ESG, Admin) plus an Apps launcher. There is also a **🔍 Find a panel** type-ahead box — start typing a panel name to jump straight to it. A floating **✨ Ask AI** button on every screen answers both "what are our numbers" questions and "how do I do this" questions (pulling from this guide).

## Major module groups at a glance

| Module group | What it covers |
|---|---|
| **Master Data** | The core reference records — styles, vendors, customers, fabric codes, payment terms, and other lookup masters that everything else points to. |
| **Accounting** | Chart of accounts, fiscal periods (open / soft-close / closed), and manual journal entries — the foundation of the books. |
| **Accounts Receivable (AR)** | Customer invoices, receipts and their application, aging report, overdue alerts, and credit-limit checks. |
| **Accounts Payable (AP)** | Vendor bills through their lifecycle (draft → posted → paid → void), the approval gate, and the payments ledger. |
| **Inventory** | Stock movements — transfers between locations, adjustments, cycle counts, and the mobile scanner that feeds them. |
| **Procurement / Receiving** | Native purchase orders, receiving against them, QC inspections, customs entries, broker invoices, and three-way match. |
| **Sales / Allocations / Shipping** | Sales orders, reserving stock (per-order and the cross-order Allocations Workbench), and carrier shipping. |
| **B2B Portal** | The wholesale self-service portal where buyers see their pricing, build a cart, and place orders that become draft sales orders. |
| **Pricing** | Price lists, quantity breaks, and promotions, with the rules that decide which price a customer gets. |
| **Returns / RMA** | The reverse-sales flow — raise a return, decide restock vs. scrap per line, and issue a credit memo. |
| **Drop-Ship** | Orders the vendor ships directly to the customer, with no warehouse or inventory movement. |
| **3PL** | Tracking inbound, outbound, and return shipments handled by an outside (third-party) logistics provider. |
| **EDI** | Electronic trading of standard documents (purchase orders, acknowledgements, ASNs, invoices) with EDI-enabled vendors. |
| **Reports** | A single hub tying together the financial and operational reports, with live finance KPI tiles. |
| **Finance** | Fixed-asset register and depreciation, GL budgets and budget-vs-actual, and the year-end 1099 worksheet. |

## Complete chapter index

The detailed how-to for every area lives in the dedicated Tangerine guide. Use the links below — this overview is only the entry point.

### Foundations

- [01 — Getting started](../tangerine/user-guide/01-getting-started.md) — logging in, the nav layout, the 10-minute smoke test
- [02 — Master data](../tangerine/user-guide/02-master-data.md) — Style, Vendor, Customer Master CRUD
- [03 — Accounting](../tangerine/user-guide/03-accounting.md) — chart of accounts, periods, journal entries
- [04 — Concepts](../tangerine/user-guide/04-concepts.md) — multi-entity, dual-basis, control accounts, matrix dimensions, audit
- [05 — Workflows](../tangerine/user-guide/05-workflows.md) — end-to-end recipes (COA setup, monthly close, adjustments)
- [06 — Troubleshooting](../tangerine/user-guide/06-troubleshooting.md) — error reference and recovery patterns

### Approvals, notifications, documents, people

- [07 — Approvals](../tangerine/user-guide/07-approvals.md) — configure approval rules and act on the inbox
- [08 — Notifications](../tangerine/user-guide/08-notifications.md) — in-app inbox plus email, with per-kind preferences
- [09 — Documents](../tangerine/user-guide/09-documents.md) — attach files to vendors and customers
- [10 — Employees](../tangerine/user-guide/10-employees.md) — the HR / identity layer behind display names

### Inventory, payables, masters

- [11 — Inventory operations](../tangerine/user-guide/11-inventory-operations.md) — transfers, adjustments, cycle counts
- [12 — Mobile scanner](../tangerine/user-guide/12-scanner.md) — the scanner contract and troubleshooting view
- [13 — Accounts Payable](../tangerine/user-guide/13-accounts-payable.md) — vendor bills, approval gate, payments
- [14 — Payment terms](../tangerine/user-guide/14-payment-terms.md) — the payment-terms master and due-date logic
- [15 — Fabric codes](../tangerine/user-guide/15-fabric-codes.md) — the textile master linked to Style Master

### Receivables, bank, exports, revenue

- [16 — Accounts Receivable](../tangerine/user-guide/16-accounts-receivable.md) — invoices, receipts, aging, credit limits
- [17 — Bank reconciliation](../tangerine/user-guide/17-bank-reconciliation.md) — bank feed / CSV upload, matching, recon report
- [18 — Table export](../tangerine/user-guide/18-table-export.md) — the universal Export button on every panel
- [19 — Revenue operations](../tangerine/user-guide/19-revenue-operations.md) — card capture, sales reps and commissions, customer service cases

### CRM, products, identity, access

- [20 — CRM](../tangerine/user-guide/20-crm.md) — the sales pipeline, activity log, and tasks
- [21 — PIM (Product Information Management)](../tangerine/user-guide/21-pim.md) — the product catalog, categories, attributes, and images
- [22 — Shadow Mirror](../tangerine/user-guide/22-shadow-mirror.md) — nightly mirror of Xoro AR/AP/inventory into Tangerine
- [23 — Searchable dropdowns](../tangerine/user-guide/23-searchable-dropdowns.md) — the type-ahead pickers used across panels
- [24 — User access & permissions (RBAC)](../tangerine/user-guide/24-user-access-rbac.md) — the per-module, per-action permission matrix
- [25 — Sign-in & per-user identity](../tangerine/user-guide/25-sign-in-and-identity.md) — the identity model behind per-user access

### Brand scope, sales, purchasing, B2B

- [26 — Brand master & GL allocation](../tangerine/user-guide/26-brand-master-gl-allocation.md) — brand as a sub-dimension of entity and per-brand P&L
- [27 — Sales orders, allocations & shipping](../tangerine/user-guide/27-sales-orders-allocations-shipping.md) — the full sell-side flow
- [28 — Purchase orders & the size matrix](../tangerine/user-guide/28-purchase-orders-and-size-matrix.md) — native POs and the size-matrix grid
- [29 — B2B wholesale portal](../tangerine/user-guide/29-b2b-wholesale-portal.md) — the magic-link buyer portal and its admin panels
- [30 — Masters, sales, CRM & HR batch](../tangerine/user-guide/30-masters-sales-crm-hr-batch.md) — reference masters, auto-codes, factoring, scorecards, commissions

### Pricing, procurement, planning

- [31 — Pricing engine](../tangerine/user-guide/31-pricing-engine.md) — price lists, qty breaks, promotions, and price resolution
- [32 — Procurement — receiving & approval](../tangerine/user-guide/32-procurement-receiving.md) — the Procurement group end to end
- [33 — Inventory Planning ⇄ Tangerine](../tangerine/user-guide/33-inventory-planning-to-tangerine-po.md) — turning an approved buy plan into draft POs and choosing the supply source

### Returns, drop-ship, 3PL, EDI

- [34 — Customer returns & RMA](../tangerine/user-guide/34-returns-rma.md) — the reverse sales flow and credit memos
- [35 — Drop-ship](../tangerine/user-guide/35-drop-ship.md) — vendor-direct shipments to the customer
- [36 — Third-party logistics (3PL)](../tangerine/user-guide/36-3pl.md) — outside-warehouse shipment tracking
- [37 — EDI](../tangerine/user-guide/37-edi.md) — electronic data interchange with vendors

### Reports, finance, integrations, costing

- [38 — Reports & analytics hub](../tangerine/user-guide/38-reports-hub.md) — the single reports landing and KPI tiles
- [39 — Fixed assets · budgets · 1099](../tangerine/user-guide/39-finance-fixed-assets-budgets-1099.md) — the finance extras
- [40 — Inventory Planning — reports](../tangerine/user-guide/40-planning-reports.md) — sales performance, inventory health, forecast accuracy, buy plan
- [41 — External / partner API](../tangerine/user-guide/41-external-partner-api.md) — the read-only REST API for authorized integrations
- [42 — Costing module](../tangerine/user-guide/42-costing-module.md) — the cost/price workbook and the RFQ → compare → award flow
- [43 — Shopify Connect](../tangerine/user-guide/43-shopify-connect.md) — connecting and syncing Shopify stores

## Where to go next

> **Start here, then dive in.** If you are new to Tangerine, open [01 — Getting started](../tangerine/user-guide/01-getting-started.md) and run the 10-minute smoke test. For anything specific, use the index above — each chapter holds the real detail; this page is only the map.
