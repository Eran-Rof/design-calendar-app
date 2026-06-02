# 32. Procurement — Receiving & Bookkeeper Approval (P13)

> **Status (2026-06-02):** P13 completion program in flight. **Shipped:** C0 PO reconcile (#799), C1 Receiving + Bookkeeper Approval (#801), **Wave C (#804): QC Inspections, Customs Entries, Broker Invoices, 3-Way Match**. C5 Reconciliation inbox + open-commitments report + close pre-flight (#805). P13 build complete; remaining = operator per-vendor cutover. This chapter covers the **💲 Procurement** nav group.

## 32.4 QC Inspections (`Procurement → 🔍 QC Inspections`)
Inspect a **posted** receipt: record pass/partial/fail with an overall pass-rate and per-finding detail (category, severity minor/major/critical, qty affected, description). Optionally adjust the receipt lines' accepted/rejected qty. *(The vendor-RMA / credit / write-off / rework disposition workflow with its GL effects is a later chunk — QC currently records the inspection only.)*

## 32.5 Customs Entries (`Procurement → 🛃 Customs Entries`)
Record a CBP entry (entry #, date, port, broker) with per-line HTS code, country of origin, entered value, duty rate/amount, §301, MPF/HMF. Header money totals are auto-summed from the lines. *(Capitalizing duty into FIFO layers via a revaluation JE is a later chunk — this records the entry.)*

## 32.6 Broker Invoices (`Procurement → 🚢 Broker Invoices`)
Record a broker/freight-forwarder invoice (freight, brokerage, duty advance, other), optionally linked to a customs entry, with an allocation method (value / weight / cbm / manual). *(Landed-cost allocation onto FIFO layers posts in a later chunk.)*

## 32.7 3-Way Match (`Procurement → ⚖️ 3-Way Match`)
Enter a vendor invoice and match it against its PO + posted receipts. The engine compares the invoice total to the **received-and-accepted value** and flags **matched** (within $5 or 2%, whichever is greater), **variance** (outside tolerance), or **exception** (no receipt found). **Approve** creates an unposted AP invoice (you post it via the normal AP flow); **Reject** records a reason.

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
   - Posts the **goods-receipt journal entry (GRNI)**: **DR Inventory** at the landed total (matching the layers), **CR GR/IR Clearing (2050)** for the vendor goods cost, and **CR Accrued Landed (2150)** for the capitalized rollups. The receipt's `je_id` is stamped. Goods are booked into inventory **once** here.
   - Sends each rollup to the **Bookkeeper Approval** queue as a draft AP invoice. **Capitalized** rollups clear **Accrued Landed (2150)** on approval (DR 2150 / CR AP) — they do *not* re-hit an expense account, so freight is never double-counted; **non-capitalized** rollups stay on their chosen expense GL. The matched vendor AP invoice later clears **GR/IR (2050)** (a later chunk) — neither AP invoice re-debits inventory.
   - Consumes the PO's open commitments.
   - A posted receipt is locked.

> **Accounting model.** GR/IR (Goods-Received-Not-Invoiced) is a two-step: the receipt debits inventory and credits clearing liabilities; the vendor + rollup invoices debit those liabilities and credit AP. The inventory asset is therefore recorded exactly once at landed cost, and no AP invoice creates a second inventory layer.

## 32.3 Bookkeeper Approval (`Procurement → 🧾 Bookkeeper Approval`)
Lists the rollup AP invoices (freight / duty / broker) created by receiving, held in `pending_bookkeeper_approval`.
- **Approve** → releases the invoice to the normal **AP Invoices** workflow, where you post it to the GL with the existing (proven) AP posting flow. *(One-click approve-and-post is a planned enhancement.)*
- **Reject** → requires a reason; voids the draft.

## 32.8 Procurement Reconciliation (`Procurement → 🧮 Procurement Recon`)
A read-only dashboard of the procurement states that block a clean period close:
- **Open commitments by vendor** — remaining $ on issued POs not yet fully received (exportable).
- **Unresolved 3-way matches** — vendor invoices in variance/exception.
- **Stale customs entries** — entries >60 days old with no broker invoice (landed cost unsettled).
- **Failed QC inspections.**

The **period-close pre-flight** (Periods → Run checks, and the close itself) now enforces the same: unresolved 3-way matches and stale customs **block** the close; failed QC is a warning. All counts are zero until procurement data exists.

## What's NOT yet usable (deferred to later P13 chunks)
- **Receiving against mirrored Xoro POs** — C1 is native-PO only.
- **GL Chunk 1 (Receipt GRNI JE) ✅ shipped** — receiving now posts the GR/IR journal entry (above). Remaining GL follow-ups:
  - **Matched vendor AP invoice clears GR/IR (2050)** with price-variance to PO Variance (6320), and a guard so the matched invoice does **not** create a *second* inventory layer — **GL Chunk 2**.
  - **QC disposition GL effects** — write-off (6420), vendor credit memo, rework move — **GL Chunk 3**.
  - **Landed-cost revaluation JE** — customs duty / broker freight capitalized onto the *remaining* FIFO layers — **GL Chunk 4**.
  - Today native POs = 0, so there is no live double-count; during the parallel run, P9 reconciliation covers variances.
- **OCR vendor-invoice ingestion** — manual entry first (per D14).
