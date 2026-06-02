# 32. Procurement — Receiving & Bookkeeper Approval (P13)

> **Status (2026-06-02):** P13 completion program in flight. **Shipped:** C0 PO reconcile (#799), **C1 Receiving + Bookkeeper Approval (#800)**. **Ahead:** QC (C2), Customs/broker/landed-cost (C3), vendor-invoice 3-way match (C4), reconciliation inbox + close pre-flight (C5). This chapter covers the **💲 Procurement** nav group as it stands after C1.

## What P13 is
P13 moves purchasing **into** Tangerine so Xoro's PO side can eventually be retired. Two PO models coexist during the parallel run:
- **Native POs** (`Procurement → Purchase Orders`) — created in Tangerine. **C1 receiving works against these.**
- **Mirrored POs** (Xoro → PO WIP) — tracked, not yet receivable in Tangerine (a later step).

## 32.1 Purchase Orders (recap)
Create a PO (vendor, dates, lines with style/qty/unit cost), then **Issue** it — issuing assigns the immutable `PO-YYYY-NNNNN` number and records an **open commitment** per line (visible to the future Open-Commitments report). Status flow: draft → issued → in_transit → received → cancelled.

## 32.2 Receiving (`Procurement → 📥 Receiving`)
Records goods arriving against an **issued / in-transit** PO.
1. **+ New receipt** → pick the PO. Its lines load with received = accepted = ordered qty (edit as needed); enter **rejected** qty for anything you won't stock.
2. **Landed-cost rollups** (optional) — add freight / duty / broker / inspection charges: pick the expense GL account, amount, vendor, and whether to **capitalize to inventory** (on = folds into unit cost; off = expense only).
3. **Save draft** (editable), then **Post receipt**. Posting:
   - Creates one **FIFO inventory layer** per accepted line at the **landed unit cost** = PO unit cost + the line's value-weighted share of the capitalized rollups. (e.g. 100 units @ \$10 + \$50 freight → \$10.50/unit.)
   - Sends each rollup to the **Bookkeeper Approval** queue as a draft AP invoice (it does *not* hit the GL until approved).
   - Consumes the PO's open commitments.
   - A posted receipt is locked.

## 32.3 Bookkeeper Approval (`Procurement → 🧾 Bookkeeper Approval`)
Lists the rollup AP invoices (freight / duty / broker) created by receiving, held in `pending_bookkeeper_approval`.
- **Approve** → releases the invoice to the normal **AP Invoices** workflow, where you post it to the GL with the existing (proven) AP posting flow. *(One-click approve-and-post is a planned enhancement.)*
- **Reject** → requires a reason; voids the draft.

## What's NOT yet usable (deferred to later P13 chunks)
- **Receiving against mirrored Xoro POs** — C1 is native-PO only.
- **Inventory-receipt GL entry (GRNI)** and ensuring a matched vendor AP invoice does **not** create a *second* inventory layer for the same goods — settled in **C4** (3-way match). Today native POs = 0, so there is no live double-count; during the parallel run, P9 reconciliation covers variances.
- **QC inspections** (C2), **customs entries / broker invoices / duty revaluation** (C3), **vendor-invoice 3-way match** (C4), **reconciliation inbox + open-commitments report + close pre-flight** (C5).
- **OCR vendor-invoice ingestion** — manual entry first (per D14).
