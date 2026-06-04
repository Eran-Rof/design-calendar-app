# 35. Drop-Ship (P20 / M49)

**Where:** Tangerine → **Sales → 📦 Drop-Ship** (`/tangerine?m=drop_ship`)

## What it is

A **drop-ship** order is fulfilled by the **vendor shipping directly to the
customer** — the goods never pass through your warehouse. So unlike a normal
sale, **nothing moves in inventory** (no FIFO layer in or out). The economics
are simply:

> **customer price** (what you bill the customer) − **vendor cost** (what the
> vendor charges you) = **margin**, captured per line.

Use it when a customer orders something you don't stock and the supplier ships
it for you.

## Lifecycle

```
requested ──confirm──► confirmed ──mark shipped──► shipped ──delivered──► delivered ──close──► closed
     └──────────────────────────── cancel ──────────────────────────────────────────────────►  cancelled
```

- **Confirm** assigns the order number (`DS-YYYY-NNNNN`).
- **Mark shipped** records the hand-off to the vendor's carrier (add carrier + tracking on the expanded row).
- **Delivered / Close** finish the order.

## Creating a drop-ship order

**+ New Drop-Ship** → pick the **customer**, the **vendor** (drop-shipper), then add a line per item:

| Field | Meaning |
|---|---|
| **SKU** | optional `STYLE-COLOR-SIZE` (links the line to an item) |
| **Description** | free text |
| **Qty** | units |
| **Cust $** | unit price billed to the customer (revenue) |
| **Cost $** | unit cost the vendor charges you (COGS) |

The customer's ship-to address is snapshotted onto the order automatically. The list shows **revenue** and **margin** per order; margin turns red if a line is underwater.

## Tracking

Expand an order to enter the **carrier** and **tracking number** (and to review the line-level margin). These stay editable until the order is closed/cancelled.

## Accounting — current state

The financial side of drop-ship is **two documents, no inventory**:

- a **customer invoice** (DR Accounts Receivable / CR Revenue) — revenue only, *no* COGS-from-FIFO because nothing left your stock;
- a **vendor bill** (DR COGS / CR Accounts Payable) — the vendor's cost is the COGS.

> **Document generation is not wired yet.** It is **blocked on the Chart of Accounts**: the prod COA does not yet have standard **Accounts Receivable / Revenue / COGS / Accounts Payable** accounts, so neither drop-ship documents nor regular AR/AP can resolve their posting accounts (see OPERATOR-TODO). Once those accounts exist, a "Generate invoice + vendor bill" step will create the two draft documents (linked to the order) for the bookkeeper to post. For now Drop-Ship is the **operational tracking layer** (order → confirm → ship → close, with margin + tracking).
