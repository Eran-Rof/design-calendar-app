# Ring of Fire — Suite User Guide

The single, operator-facing guide to every Ring of Fire app. One login, one launcher,
and the apps below. Each chapter is written for the people who use that app day to day —
designers, product developers, sourcing, planning, warehouse, sales, ops, and the CEO —
not for developers.

> **New here?** Start with [Chapter 1 — Getting Started & Navigation](01-getting-started.md).
> It covers signing in, the app-card launcher, and how access works across every app.

---

## The apps

| # | App | What it's for | URL path |
|---|-----|---------------|----------|
| 1 | [Getting Started & Navigation](01-getting-started.md) | Sign-in, the launcher, top navigation, and access/permissions across the suite | `/` |
| 2 | [Design Calendar](02-design-calendar.md) | The PLM calendar — collections, the Collection Wizard, Dashboard / Timeline / Calendar views, tasks & phases, trend briefs | `/design` |
| 3 | [Costing](03-costing.md) | Cost build-ups, margin/sell targets, RFQs to vendors, and quote comparison | `/costing` |
| 4 | [Tech Packs](04-techpack.md) | Spec sheets, measurements, BOM, colorways, approvals, and emailing tech packs | `/techpack` |
| 5 | [ATS (Available To Sell)](05-ats.md) | On-hand / on-order availability grid, status cards, reports and sales comps | `/ats` |
| 6 | [PO WIP (Production WIP)](06-po-wip-tanda.md) | The production work-in-progress board — PO milestones, size matrix, templates, archive | `/tanda` |
| 7 | [Inventory Planning](07-inventory-planning.md) | Wholesale & ecom buy planning, scenarios, reconciliation, accuracy, and Tangerine PO creation | `/planning` |
| 8 | [GS1 Prepack Labels](08-gs1-prepack-labels.md) | GTIN/UPC management, pack composition, label batches, and scan-based receiving | `/gs1` |
| 9 | [B2B Wholesale Portal](09-b2b-wholesale-portal.md) | The customer-facing catalog, cart, and order portal (plus ROF setup) | `/b2b` |
| 10 | [Vendor Portal](10-vendor-portal.md) | Vendor onboarding, POs, RFQs, shipments, and invoices (plus ROF invite/approval) | `/vendor` |
| 11 | [Tangerine ERP](11-tangerine-erp.md) | The Xoro-replacing ERP — accounting, AR/AP, inventory, procurement, sales, CRM. Overview + index to its 40+ detailed chapters | `/tangerine` |

> Tangerine has its own deep, multi-chapter guide. Chapter 11 above is the entry point and
> links straight to each detailed topic under [`../tangerine/user-guide/`](../tangerine/user-guide/).

---

## Conventions used throughout

- **Bold** marks an exact on-screen label — a button, tab, column, or status — so you can find it in the app.
- Numbered lists are step-by-step procedures; follow them in order.
- `>` call-out boxes flag tips, prerequisites, and gotchas.
- Dates display in **US format (MM/DD/YYYY)** across the suite.

## Two things that apply everywhere

1. **Always use `apps.ringoffire.com`** — not the `*.vercel.app` address. The vercel.app domain
   sits behind a separate sign-in wall that breaks data loading.
2. **Access is per-app.** Most people can open most apps by default; an admin can lock specific
   apps per person from **User Access**. See [Chapter 1](01-getting-started.md#how-access-works).

---

## Related references

- App quick-overviews (legacy short notes): [`../apps/`](../apps/)
- Tangerine ERP detailed chapters: [`../tangerine/user-guide/`](../tangerine/user-guide/)
- This guide lives in `docs/user-guide/`. When an app changes, update the matching chapter here in the same PR.
