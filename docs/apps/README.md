# Apps overview (beyond Tangerine ERP)

Ring of Fire runs several apps off the same React/TS/Vite + Supabase/Vercel
codebase. The **Tangerine ERP** has its own deep docs under
[`docs/tangerine/`](../tangerine/) (build progress, user guide, architecture).
This folder documents the **three operational apps** that sit alongside it and
feed it data:

| App | Route | Purpose | Overview |
|---|---|---|---|
| **ATS** — Available To Sell | `/ats` | Wholesale free-to-sell inventory view + forward availability + Excel exports | [ats-overview.md](ats-overview.md) |
| **PO WIP** — Tanda (Tracking & Analysis) | `/tanda` | Track purchase orders through production milestones (order → DDP) | [po-wip-overview.md](po-wip-overview.md) |
| **Inventory Planning** | `/planning` | Forecast demand, reconcile supply, emit buy recommendations | [inventory-planning-overview.md](inventory-planning-overview.md) |

## How they connect

```
            Xoro (POs, sales, inventory)        Shopify (ecom orders)
                 │                                      │
        ┌────────┴─────────┐                            │
        ▼                  ▼                            ▼
   PO WIP (Tanda)     ATS (Available-To-Sell)    Inventory Planning
   tanda_pos +        app_data[ats_excel_data]   ip_* tables
   milestones              │                            ▲
        │                  │  on-hand snapshot          │
        │  open POs +      └──────────► ip_inventory_snapshot
        │  DDP milestone                                │
        └──────────────────► ip_open_purchase_orders ───┘
                                                         │
                                          buy plan ──────┘
                                                         ▼
                                          Tangerine Procurement
                                          (native purchase_orders, receipts)
```

- **PO WIP (Tanda)** mirrors Xoro POs and tracks them through production
  milestones; it feeds **ATS** (`onPO` qty) and **Planning** (open POs +
  the "In House / DDP" milestone date that times incoming supply).
- **ATS** computes per-color available-to-sell from an Excel/Xoro on-hand
  snapshot and feeds **Planning**'s on-hand (`ip_inventory_snapshot`).
- **Planning** turns demand + supply into buy recommendations, which can flow
  into **Tangerine** as draft purchase orders (M31 direction A) — and Planning
  can alternatively read its supply from Tangerine itself (M31 direction B).

See [`docs/tangerine/user-guide/33-inventory-planning-to-tangerine-po.md`](../tangerine/user-guide/33-inventory-planning-to-tangerine-po.md)
for the Planning ⇄ Tangerine integration.

> These overviews are operator-facing summaries kept at the "what it is / how it
> connects" level. Implementation detail lives in the code and the phase READMEs
> (Planning: `src/inventory-planning/README*.md`).
