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
   - The **target unit price** the vendor sees on each RFQ line matches the
     project's cost basis: **Tgt DDP Cost** for DDP projects, **FOB cost** for
     FOB/Landed projects (never the sell price). Editing the costing line's
     Tgt DDP / FOB cost re-syncs the target on any RFQ already generated.
2. **Send** publishes the RFQ to the vendor; they submit a quote.
3. In the **RFQ list**, the **Fabric** column shows `CODE — Description`, and clicking a
   row opens that RFQ's **source project in a new tab** (the title cell still opens the
   RFQ editor).
4. **Compare RFQs** lays quotes side-by-side; **Award** picks the winner.

### When a vendor revises a quote

A vendor can reopen an already-submitted quote and resubmit revised figures. When
they do:

- The procurement team is **notified automatically** — both **in-app** (the 🔔
  bell, for staff whose Employee record has a linked PLM login) and by **email**.
  The alert is titled "<vendor> revised their quote … (v2)" so you can tell it
  apart from a brand-new quote. Configure recipients via
  `INTERNAL_PROCUREMENT_EMAILS` or per-employee notification subscriptions; the
  in-app bell requires the employee's **PLM login** to be linked on their
  Employee record.
- The next time you **open that RFQ**, a banner + toast pop up at the top
  ("⚠ <vendor> revised their quote — review the highlighted rows"). The vendor's
  row in the comparison shows a gold **Revised v2** badge; expand it to see
  **current vs. prior** prices, lead time, and per-line figures.
- Click **Got it** to dismiss the banner. It won't nag you again for that RFQ
  unless the vendor revises *again* (a newer version re-triggers it).

**What the vendor sees:** the vendor gets their own **in-app + email confirmation**
("Your revised quote (v2) was submitted") and, on their RFQ page, a read-only
**🕑 Your revision history** expander listing their prior versions (totals, lead
time, per-line figures). A vendor only ever sees **their own** history — never
another vendor's quotes and never Ring of Fire's internal comparison.

> Note: Ring of Fire staff cannot edit a vendor's **quote** (quotes belong to the
> vendor), and the RFQ header locks once published. But editing a **costing line**
> after its RFQ was sent **does** flow through to the vendor — see below.

### When YOU (Ring of Fire) revise a sent RFQ

If you edit a costing line that's already been sent to a vendor — its **Tgt DDP /
FOB cost**, **Qty**, **fabric**, **size scale**, **style**, **color**, **fit**,
etc. — the change automatically syncs onto that vendor's RFQ line, and:

- The **vendor is notified** — in-app (🔔 bell) + email: *"An RFQ was revised: …"*.
- When the vendor **opens the RFQ**, a popup tells them *"One of your RFQs has been
  revised,"* the changed line shows an **✎ Revised · <date>** badge, and **each
  changed value is shown in green** so they see exactly what moved.
- Only the fields you actually changed are flagged; re-editing re-notifies with the
  new change set.

See also: [14 — Payment Terms](14-payment-terms.md), [15 — Fabric Codes](15-fabric-codes.md),
[32 — Procurement & Receiving](32-procurement-receiving.md).
