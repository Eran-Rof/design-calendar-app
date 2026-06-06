# 42 — Costing Module

The Costing app (`/costing`) builds a price/cost workbook per project: one row per
style/color/vendor, then turns selected rows into vendor RFQs, compares quotes, and
awards the winner.

## Project header (required before rows)

Open a project and fill the header **before adding any costing rows**. These fields
are required — `+ Add row` is blocked with a list of what's missing until they're set:

- Project name, Brand, Gender
- Customer, Sales rep
- Payment terms
- Request date, Due date

> **Payment terms drive the cost mode.** Pick a **DDP** term (any term whose name
> contains "DDP") to switch the grid into DDP costing.

## The costing grid

Each row is a style line. Key columns:

- **Style# / Description / Scale / Fabric / Fit / Color / Closures / Waist** — the spec.
- **Qty** — target units.
- **Vendor** — the intended vendor (used to group RFQs). Pick from the dropdown or add a new one.
- **Avg Cost / PO History** — historical reference. PO History shows the per-unit cost
  from past POs; prepack (PPK) pack prices are **exploded to per-unit** so a pack POs
  don't inflate the figure. A "Pack" column shows the pack size used.

### Cost basis: FOB/Landed vs DDP

The grid has two cost modes, chosen by the project's payment term:

| Mode | Cost columns shown | Cost basis for margin |
|------|--------------------|-----------------------|
| **Non-DDP** (default) | FOB, Duty %, Freight, Insur, Other, **Landed** (computed) — grouped under the **"FOB / Landed Target"** header band | Landed cost |
| **DDP** | **Tgt DDP Cost** only (FOB→Landed columns hidden) | Tgt DDP Cost |

In non-DDP mode, **Landed = FOB + FOB×Duty% + Freight + Insurance + Other**.

### Margin %

**Margin %** auto-fills from the **Sell Tgt** price and the cost basis:

```
Margin % = (Sell Tgt − cost basis) / Sell Tgt × 100
```

(There is no separate "Sell" column — margin and the footer totals use **Sell Tgt**.)

**Margin % is editable.** Type a target margin and the grid back-solves the cost to hit it:

- **DDP mode** → sets **Tgt DDP Cost** = `Sell Tgt × (1 − margin/100)`.
- **Non-DDP mode** → solves **FOB** so that Landed hits the implied cost, holding Duty %,
  Freight, Insurance and Other fixed.

A **Sell Tgt** must be entered first (you can't solve a cost without a selling price).

### LY / T3 comparison

LY (last year) and T3 (trailing 3 months) cost, sales price and margin are pulled from
sales history for the **base style** — both the base style and its PPK variants
contribute, with pack rows exploded to per-unit so prepack pricing doesn't skew the average.

## Incomplete-row guard

A row is **incomplete** if it's missing any of: style, color, vendor, qty, cost
(Tgt DDP Cost or a target/FOB cost), or **Sell Tgt**. Incomplete rows can't be sent.
You'll be warned — with the option to **delete the incomplete rows and continue**, or
**go back and fix** — when you:

- click **Vendor RFQ** (Send) with an incomplete row selected, or
- leave the project (**← Projects** button, or closing the tab).

## RFQ flow

1. Tick rows and click **Vendor RFQ** to generate one RFQ per vendor.
2. **Send** publishes the RFQ to the vendor; they submit a quote.
3. In the **RFQ list**, the **Fabric** column shows `CODE — Description`, and clicking a
   row opens that RFQ's **source project in a new tab** (the title cell still opens the
   RFQ editor).
4. **Compare RFQs** lays quotes side-by-side; **Award** picks the winner.

See also: [14 — Payment Terms](14-payment-terms.md), [15 — Fabric Codes](15-fabric-codes.md),
[32 — Procurement & Receiving](32-procurement-receiving.md).
