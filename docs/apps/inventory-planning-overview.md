# Inventory Planning

**Route:** `/planning/*` · **Code:** `src/inventory-planning/` · **Access:** `permissions.planning`

## What it is

A standalone, 7-phase demand-and-inventory planning app: it forecasts demand,
reconciles it against supply, and emits **buy recommendations**. It is
Xoro/Shopify-backed (its own `ip_*` tables), and as of M31 it also integrates
with Tangerine in both directions. Build notes live in
`src/inventory-planning/README*.md` (per phase); this is the current-state map.

## The screens

| Screen | Route | What it does |
|---|---|---|
| **Wholesale** | `/planning/wholesale` | 6-tier baseline wholesale forecast (`ip_wholesale_forecast`) + planner overrides + future-demand requests |
| **Ecom** | `/planning/ecom` | Shopify-driven weekly ecom forecast (`ip_ecom_forecast`) |
| **Supply** | `/planning/supply` | Reconcile demand vs on-hand + open POs + receipts → projected inventory, **buy recommendations**, supply exceptions (allocation waterfall) |
| **Scenarios** | `/planning/scenarios` | What-if scenarios + assumptions + approvals |
| **Accuracy** | `/planning/accuracy` | Forecast accuracy, anomalies, AI co-pilot suggestions |
| **Execution** | `/planning/execution` | Gather recommendations into execution **batches** (buy plans) → export / writeback / **Tangerine POs** |
| **Admin** | `/planning/admin` | Roles (`ip_roles`/`ip_user_roles`), integration health, job runs, audit |

## Supply inputs (the Supply screen)

The reconciliation reads three supply buckets and nets them against demand:

- **On-hand** ← `ip_inventory_snapshot` (latest per SKU)
- **Open POs (incoming)** ← `ip_open_purchase_orders`
- **Receipts** ← landed history

These are fed by sync handlers in `api/_lib/planning-sync.js`:

- **On-hand from ATS** (`syncOnHandFromAtsSnapshot`, `source='manual'`) — the
  ATS Excel snapshot, **color grain**.
- **Open POs from Tanda** (`syncOpenPosFromTandaPos`, `source='xoro'`) — open
  `tanda_pos` lines; each PO's arrival month now comes from the Tanda **"In
  House / DDP" milestone** ("inbound PO is WIP" — `wip_qty` stays 0 by design,
  WIP = the open PO, timed by its milestone).

## M31 — the Tangerine integration (P17)

Surfaced in the Tangerine shell (📈 Planning) and connected **both directions**,
each an opt-in choice that leaves the Xoro paths intact. Full guide:
[`docs/tangerine/user-guide/33-inventory-planning-to-tangerine-po.md`](../tangerine/user-guide/33-inventory-planning-to-tangerine-po.md).

- **Direction A — buy plan → Tangerine PO:** the Execution screen's **🍊 Create
  Tangerine POs** turns an approved batch's `create_buy_request` actions into
  draft native `purchase_orders` (one per vendor), with dry-run preview, cost
  fallback, coded skip reasons, and one-click vendor linking.
- **Direction B — Tangerine supply → planning:** a run can choose its
  `supply_source` (`xoro` default, or `tangerine`); **🍊 Sync Tangerine supply**
  fills on-hand from `inventory_layers` + open POs from native `purchase_orders`
  (tagged `source='tangerine'`). The reader filters by source so the two never
  double-count.
- **WIP timing** — the open-PO arrival month is refined from the Tanda DDP
  milestone (see above).

## Buy plan: two sources (recommendations table is what executes)

The Execution batch and the Wholesale-buy-plan / Recommendations **exports all
read `ip_inventory_recommendations`** — NOT the planner-typed
`ip_wholesale_forecast.planned_buy_qty`. So a scenario can show typed buy
quantities yet produce an empty batch + 0-row exports if no recommendations
were ever generated. Two ways to fill the recommendations for a scenario
(both on the **Scenarios** screen → Assumptions tab, disabled while the
scenario is read-only/approved):

1. **Apply assumptions + recompute** — supply-netted plan: nets forecast demand
   against on-hand + open POs and emits shortage-driven `buy` recommendations.
2. **Push planner buys → plan** — bypasses supply netting and writes your typed
   `planned_buy_qty` straight through as `buy` recommendations (summed per
   sku/period, `action_reason='planner_buy_plan'`), **replacing** any computed
   ones.

**Approve guard:** approving a scenario with 0 recommendations now warns
("approving will produce an empty execution batch") and requires an explicit
override, so an un-computed plan can't be approved silently.

## Connects to

- **← ATS** (on-hand snapshot) and **← PO WIP / Tanda** (open POs + DDP timing).
- **→ Tangerine** (buy plan → PO; or read Tangerine supply).

## See also
- [ats-overview.md](ats-overview.md) · [po-wip-overview.md](po-wip-overview.md)
- Phase build notes: `src/inventory-planning/README.md` + `README_PHASE1..7.md`
