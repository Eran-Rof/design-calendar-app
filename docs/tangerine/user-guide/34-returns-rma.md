# 34. Customer Returns & RMA (P19 / M23)

**Where:** Tangerine → **Sales → ↩️ Returns/RMA** (`/tangerine?m=sales_returns`)

## What it is

The reverse of the sales flow. When a customer sends goods back, you raise an
**RMA** (Return Merchandise Authorization), decide what to do with each item
(put it back in stock, or scrap it), then issue a **credit memo** that reduces
the customer's balance. The credit memo reuses the same accounting engine as
normal AR — returns just run it in reverse.

## Lifecycle

```
requested ──approve──► approved ──receive──► received ──issue credit memo──► credited
     └──────────────────────── cancel ───────────────────────────────────────►  cancelled
```

- **Approve** assigns the RMA number (`RMA-YYYY-NNNNN`).
- **Receive** marks the goods as physically back.
- **Issue credit memo** posts the GL and (for restock lines) returns stock — this is the irreversible step.

You can set dispositions any time before crediting; you don't have to wait for "received."

## Creating a return

**+ New Return** → pick the customer, then add a line per item:

| Field | Notes |
|---|---|
| **SKU** | `STYLE-COLOR-SIZE`. Enter it so a restock can go back to the right item. A line with no resolvable SKU can only be **scrapped** (credit-only). |
| **Description** | free text |
| **Qty** | units returned |
| **Unit $ (orig)** | the original sale price — this is what the customer is credited per unit |

## Dispositions — what happens to the goods

Expand an RMA to set each line's disposition:

- **Restock** — the units go **back into FIFO inventory** (a new layer at the item's latest cost) and the original **COGS is reversed**. Requires a resolved SKU.
- **Scrap** — the customer is still credited, but the goods do **not** go back on the books (they were already expensed as COGS when sold). Use for damaged/unsellable returns.

### ☰ List / ▦ Matrix view

The expanded line area has a **☰ List / ▦ Matrix** toggle (top-right).

- **List** is the default — one row per line with the disposition picker (this is where you set restock/scrap).
- **Matrix** shows the returned quantities as a **color × size grid** (rows = color, columns = size, with row/column totals), so you can see the return's shape at a glance. It's read-only; switch back to **List** to change dispositions.

Lines that have **no resolvable SKU** (or whose item is missing a color/size) can't be placed in the grid — they appear in a small **"Non-matrix lines"** list under the matrix so nothing is hidden.

## Issuing the credit memo

**Issue credit memo** builds a `customer_credit_memo` and posts it:

| Disposition | GL effect |
|---|---|
| Every line | **CR** Accounts Receivable (reduces the customer's balance) · **DR** **Sales Returns & Allowances (4100)** (a contra-revenue account, so returns show separately from gross sales on the P&L) |
| Restock lines (additional) | **DR** Inventory · **CR** COGS, and the units are re-added to FIFO (`source_kind='credit_memo_return'`) |

The credit memo gets number `CM-YYYY-NNNNN`, links back to the RMA, and (if you referenced one) to the original sales order / invoice. The RMA moves to **credited**.

## Notes & current limits

- **Restocking fee** — the field is recorded on the RMA but is **not yet deducted** in the credit memo (a follow-up). For now the credit equals the returned units' value.
- **Refunds** — this issues a **credit memo** (reduces AR). Cash refunds (returning money to a customer who already paid) are a separate flow, deferred.
- A line restocks at the item's **latest layer cost** (falling back to average cost); if neither exists it restocks at $0 (still credits the customer).
- The accounting reuses the existing `ar_credit_memo` posting rule (P4) — returns added no new GL machinery, only the RMA workflow + the 4100 account.
