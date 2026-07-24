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

## Wholesale filters populate before a build

A brand-new planning run has **no forecast rows** until you click **Build forecast** — the grid stays empty until then. To let you *pre-scope* the build, the **Customer**, **Category**, **Sub Cat**, and **Style** filters above the grid are seeded from the item/customer masters, so they list every value even before a build. Pick a customer or category first, then **Build (filtered)** to forecast just that slice. (Period also pre-lists from the run's horizon.) The remaining filters — recommended action, confidence, forecast method — are *outputs* of a build and only appear once rows exist.

The **Category** filter is the merchandising group (`ip_item_master.attributes.group_name` — DENIM, PANTS, TEE, …); **Sub Cat** is the finer `category_name`. These come straight from the item master, so adding items via **Add new items** makes new categories selectable immediately.

### Category master (`ip_category_master`)

The reusable category reference list (used by the Future Demand Requests picker and the Reports category dimension) is seeded from the distinct group names on the item master. **Add new items** also registers any new group it encounters, so the list stays current. If it ever looks empty, re-run **Add new items** or re-apply the seed migration `…_seed_ip_category_master_from_items.sql`.

## Inseam as a planning line

Denim/pants styles carry an **inseam** (30 / 32 / 34) on the item master (`ip_item_master.inseam`, stamped by the Tangerine inseam style-merge). The wholesale grid shows an **Inseam** column, and inseam is a *grain* dimension: a style+color that exists in several inseams splits into **one planning line per inseam**, so each length is forecast and bought separately. Sizes still merge within an inseam (as everywhere). Styles with no inseam are unaffected — they stay a single line. In a Category/Sub-Cat/customer rollup that spans several inseams, the Inseam cell reads "(N inseams)". The column is toggleable (Columns button) and freezable like Style/Color.

## Size is NOT a planning line — plan at the rolled-up (2026-07-24)

Unlike inseam, **size is not a grain dimension in wholesale planning.** A style/color is planned as **one rolled-up line**, not one line per size. This is deliberate: wholesale demand and virtually all sales history sit at the style/color grain, and the size split is decided at PO time from a size curve — not forecast per size.

The item master often holds a style/color as **both** a rolled-up (size-NULL) SKU **and** several sized SKUs (created by AR size-enrichment, matrix/PO entry, etc.). The build used to forecast the rolled-up **and** every size, copying the family number onto each size — so one style/color/customer/period showed as ~7 lines and the demand was multiplied (RYB1787 "Black Sands" read as 195 on the rolled-up + 6×882 on the sizes). The build now **collapses to the rolled-up**: whenever a (customer, style, color) has a rolled-up SKU with a forecast, the sized siblings' forecast rows are dropped. A style/color that has **no** rolled-up SKU (a size-only group) is left alone — dropping its sized rows would leave it with no line at all. The same rule was applied once to the existing runs to clear the duplicates already written.

Sized SKUs still exist and still receive inventory, POs and sales; they're simply not a separate **forecast** line. (Incoming inventory a supply-only view surfaces by size is unaffected — the collapse is per customer, so it never hides another customer's only line.)

## Promote a new style/color to the company database

New styles and colors you type on a TBD row stay **temporary** — they live only on the planning row and never touch the company masters. When you're ready to make one real, click the **🏢 DB** button at the end of the row (shown on planner-added rows that have a real style + color). It:
- creates the SKU in the item master (`ip_item_master`, `sku_code = STYLE-COLOR`) so it's visible in ATS and planning, and
- creates the style in the **Tangerine Style Master** (`style_master`), flagged `attributes.needs_review` so a merchandiser can find it and complete the details (brand, category, size scale, HTS, …).

Both writes are idempotent (re-clicking is safe), and the button flips to **✓ in DB** once promoted. The server endpoint is `POST /api/internal/planning/promote-style-color`.

**Reviewer notification.** When a style is newly promoted, the designated reviewers get an **in-app bell + email** ("New style needs review: …") linking to the **Style Master** filtered to styles awaiting review (`/tangerine?m=style_master&review=1` — a **⚠ Needs review** toggle that shows planning-promoted styles still flagged `needs_review`). Who gets notified is controlled per person: an admin opens **Tangerine → Employees**, edits the employee, and ticks the **"Style Master review"** notification subscription (alongside the `INTERNAL_STYLE_REVIEW_EMAILS` env list). Reviewers complete the details in Style Master, and the style drops off the Needs-review list once `needs_review` is cleared.

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

**Fixing an empty batch:** a batch is built from recommendations *at create time* —
reopening it won't add actions. So if a batch came out empty, generate the
recommendations (above), then **+ New batch** (or 🗑 Delete the empty one and
rebuild). An **exported** batch can be reopened to *ready* to revise/re-export
(xlsx export isn't a commit); a *submitted* batch cannot (writeback may have run).
On the Scenarios screen, the approved→in_review action is labelled **Reopen**.

## Click-to-sort (Admin dashboards)

The Admin **Job Runs** and **Audit Explorer** tables now support per-column
click-to-sort (2026-06-05): click a header to cycle ascending ▲ → descending ▼
→ off, blanks always sink to the bottom, and the choice is remembered per panel.
It layers on top of the existing filters and the Columns show/hide button —
only the on-screen rows are reordered. The big wholesale/ecom planning grids are
intentionally left out (their frozen columns + inline editors make a row-by-row
reorder unsafe). Shared primitive: `src/tanda/hooks/useSort.ts` +
`src/tanda/components/SortableTh.tsx`.

## Connects to

- **← ATS** (on-hand snapshot) and **← PO WIP / Tanda** (open POs + DDP timing).
- **→ Tangerine** (buy plan → PO; or read Tangerine supply).

## See also
- [ats-overview.md](ats-overview.md) · [po-wip-overview.md](po-wip-overview.md)
- Phase build notes: `src/inventory-planning/README.md` + `README_PHASE1..7.md`
