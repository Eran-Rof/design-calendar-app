# 32. Procurement — Receiving & Bookkeeper Approval (P13)

> **Status (2026-06-02):** P13 completion program in flight. **Shipped:** C0 PO reconcile (#799), C1 Receiving + Bookkeeper Approval (#801), **Wave C (#804): QC Inspections, Customs Entries, Broker Invoices, 3-Way Match**. C5 Reconciliation inbox + open-commitments report + close pre-flight (#805). P13 build complete; remaining = operator per-vendor cutover. This chapter covers the **💲 Procurement** nav group.

## 32.4 QC Inspections (`Procurement → 🔍 QC Inspections`)
Inspect a **posted** receipt: record pass/partial/fail with an overall pass-rate and per-finding detail (category, severity minor/major/critical, qty affected, description). Optionally adjust the receipt lines' accepted/rejected qty.

**Dispositions** (in the inspection editor, **⚖️ Record disposition** — pick the receipt line, qty, and reason):
- **Write-off** → posts **DR Inventory Write-off (6420) / CR Inventory** and draws the units from FIFO stock (via an `inventory_adjustments` write-off row).
- **Vendor credit only** → FIFO-consumes the units, creates a `vendor_credit_memo` AP invoice, and posts **DR AP (vendor) / CR Inventory** at the units' FIFO cost.
- **Vendor RMA** → recorded only (goods returned; the AP credit is settled when the vendor processes the RMA — no GL here).
- **Rework in-house** → recorded only (units move to rework; no GL value change).

Recorded dispositions list under the findings with their GL status.

## 32.5 Customs Entries (`Procurement → 🛃 Customs Entries`)
Record a CBP entry (entry #, date, port, broker) with per-line HTS code, country of origin, entered value, duty rate/amount, §301, MPF/HMF. Header money totals are auto-summed from the lines. Duty is capitalized into FIFO layers when you post the linked **broker invoice** (§32.6) — link the customs entry to the broker invoice so its `revaluation_je_id` is stamped.

## 32.6 Broker Invoices (`Procurement → 🚢 Broker Invoices`)
Record a broker/freight-forwarder invoice (freight, brokerage, duty advance, other), optionally linked to a customs entry, with an allocation method (value / weight / cbm / manual).

**💲 Post landed cost** (per row, until posted) allocates the invoice total onto a chosen **posted receipt's** accepted units **by value** (weight / cbm fall back to value until per-line weight/cbm is captured) and posts the **landed-cost revaluation JE**:
- **DR Inventory** — the share on units **still in stock**; those FIFO layers' unit cost is **revalued up**.
- **DR Landed Cost Variance (5150)** — the share on units **already sold** (consumed units keep their original receipt cost; no retroactive COGS restatement).
- **CR AP** — the broker bill, booked as a payable to the broker vendor.

The broker invoice is then marked **✓ Posted** (its `allocation_je_id` is stamped; a linked customs entry's `revaluation_je_id` too). Idempotent — a posted invoice cannot be re-posted.

## 32.7 3-Way Match (`Procurement → ⚖️ 3-Way Match`)
Enter a vendor invoice and match it against its PO + posted receipts. The engine compares the invoice total to the **received-and-accepted value** and flags **matched** (within $5 or 2%, whichever is greater), **variance** (outside tolerance), or **exception** (no receipt found).

**Approve** behaves by match state:
- **Matched (within tolerance)** → **auto-posts** the GR/IR-clearing journal entry immediately. The goods were already booked into inventory by the receipt GRNI JE, so this only settles the liability — it never re-debits inventory or creates a second layer:
  - **DR GR/IR Clearing (2050)** = received-and-accepted value
  - **DR / CR PO Variance (6320)** = invoice − received (the price difference, either direction)
  - **CR AP (2010)** = invoice total
  The AP invoice is marked **posted** and the draft links to it — no separate bookkeeper step.
- **Variance / exception / pending** → creates an **unposted** AP invoice draft with your chosen expense account; a bookkeeper posts it via the normal AP flow after review.

**Reject** records a reason.

## What P13 is
P13 moves purchasing **into** Tangerine so Xoro's PO side can eventually be retired. Two PO models coexist during the parallel run:
- **Native POs** (`Procurement → Purchase Orders`) — created in Tangerine. **C1 receiving works against these.**
- **Mirrored POs** (Xoro → PO WIP) — tracked, not yet receivable in Tangerine (a later step).

## 32.1 Purchase Orders (recap)
Create a PO (vendor, dates, lines with style/qty/unit cost), then **Issue** it — issuing assigns the immutable `PO-YYYY-NNNNN` number and records an **open commitment** per line (visible to the future Open-Commitments report). Status flow: draft → issued → in_transit → received → cancelled. **A PO reaches `received` only when a goods receipt is posted here in Receiving** (it bumps each line's `qty_received`, flips fully-received lines to `received`, and sets the header to `received` when everything's in, `in_transit` on a partial) — there is no manual "mark received". An issued PO can also be revised in place via the PO modal's **✎ Edit** (which notifies the vendor portal when connected) instead of cancel-and-recreate — see [chapter 28 §28.5](28-purchase-orders-and-size-matrix.md).

## 32.2 Receiving (`Procurement → 📥 Receiving`)
Records goods arriving against an **issued / in-transit** PO.
1. **+ New receipt** → pick the PO. Its lines load with received = accepted = ordered qty (edit as needed); enter **rejected** qty for anything you won't stock.
2. **Landed-cost rollups** (optional) — add freight / duty / broker / inspection charges: pick the expense GL account, amount, vendor, and whether to **capitalize to inventory** (on = folds into unit cost; off = expense only).
3. **Save draft** (editable), then **Post receipt**. Posting:
   - Creates one **FIFO inventory layer** per accepted line at the **landed unit cost** = PO unit cost + the line's value-weighted share of the capitalized rollups. (e.g. 100 units @ \$10 + \$50 freight → \$10.50/unit.)
   - Posts the **goods-receipt journal entry (GRNI)**: **DR Inventory** at the landed total (matching the layers), **CR GR/IR Clearing (2050)** for the vendor goods cost, and **CR Accrued Landed (2150)** for the capitalized rollups. The receipt's `je_id` is stamped. Goods are booked into inventory **once** here.
   - Sends each rollup to the **Bookkeeper Approval** queue as a draft AP invoice. **Capitalized** rollups clear **Accrued Landed (2150)** on approval (DR 2150 / CR AP) — they do *not* re-hit an expense account, so freight is never double-counted; **non-capitalized** rollups stay on their chosen expense GL. The matched vendor AP invoice later clears **GR/IR (2050)** (§32.7) — neither AP invoice re-debits inventory.
   - Consumes the PO's open commitments.
   - **Rolls the native PO:** bumps each line's `qty_received`, flips fully-received lines to `received`, and moves the header to `received` (all in) or `in_transit` (partial). This posted receipt is the **only** thing that makes a PO `received`.
   - **Carries the lot number** from each PO line onto its new FIFO inventory layer, so on-hand stock stays lot-identified (see [chapter 45 — Lot Numbers](45-lot-numbers.md)).
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

## P13 GL posting program — ✅ COMPLETE
All four deferred procurement journal entries now post:
- **C1 (Receipt GRNI JE)** — receiving posts DR Inventory / CR GR/IR-goods (2050) / CR Accrued-Landed (2150) (§32.2).
- **C2 (Matched vendor AP clears GR/IR)** — a within-tolerance 3-way match auto-posts DR GR/IR (2050) / DR-CR PO Variance (6320) / CR AP, with no second inventory layer (§32.7).
- **C4 (Landed-cost revaluation)** — posting a broker invoice revalues the receipt's remaining FIFO layers up + expenses the sold-units' share to Landed Cost Variance (5150), booking the broker AP bill (§32.6).
- **C3 (QC dispositions)** — write-off (6420), vendor credit memo, RMA, rework (§32.4).

Today native POs = 0, so there is no live impact; during the parallel run, P9 reconciliation covers variances.

## What's NOT yet usable (deferred to later P13 chunks)
- **Receiving against mirrored Xoro POs** — C1 is native-PO only.
- **OCR vendor-invoice ingestion** — manual entry first (per D14).
