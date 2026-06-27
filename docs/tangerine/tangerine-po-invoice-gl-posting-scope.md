# Scope — Internal AP/GL posting of Tangerine-PO vendor invoices

**Status:** Scoping (design only — no code in this PR)
**Author:** scoped 2026-06-18 in worktree `/c/tmp/gl-wt`
**Related:** [[project_two_po_data_models]], the deferred receiving→GL→AP epic in [[project_po_edit_revise_and_receiving_epic]]

---

## 1. Context & goal

There are two PO data models (see `project_two_po_data_models`):

- **Xoro POs** → `tanda_pos` (lines `po_line_items`) — legacy sync.
- **Tangerine-native POs** → `purchase_orders` (lines `purchase_order_lines`, which carry `inventory_item_id`, `qty_ordered/received`, `unit_cost_cents`) — the new ERP, created by planning `buy-plan-to-po.js`.

Vendor-facing parity is **done**: vendors can see (#1361), acknowledge (#1364), ship/ASN (#1374) and **submit invoices** (#1401) against Tangerine POs. The remaining gap is the **internal AP/GL posting** of a Tangerine-PO vendor invoice — i.e. turning a `status='submitted'` invoice into a posted journal entry that correctly capitalizes inventory / clears the goods-receipt accrual and books AP.

**Goal:** a Tangerine-PO vendor invoice posts to the GL with the same correctness as today's Xoro/native flows — no double-booked inventory, GR/IR cleared, variance handled, AP credited.

---

## 2. Current state — most of the machinery already exists and is Tangerine-ready

Investigation (read-only, file:line below) found the internal receiving→GL→AP chain is **already `purchase_orders`-native**. The only Xoro-only piece was the vendor *submit*, which #1401 already fixed.

### 2.1 Native-PO receiving → GL  ✅ exists
`api/_handlers/internal/procurement/receipts/post.js`
- Requires `purchase_order_id` (rejects the Xoro path); reads `tanda_po_receipt_lines` + `purchase_order_lines` (→ `inventory_item_id`).
- Allocates landed-cost rollups, creates **FIFO layers** per accepted line.
- Posts `inventory_receipt` JE (rule `inventoryReceipt.js`): **DR 1310 Inventory / CR 2050 GR-IR (goods) / CR 2150 Accrued Landed**.
- Updates `purchase_order_lines.qty_received` + flips PO header to `received`.

### 2.2 3-way match + GR/IR clearing  ✅ exists (native)
`api/_handlers/internal/procurement/vendor-invoice-drafts/index.js` + `[id].js`
- A `vendor_invoice_drafts` row (the staging/match record) with a `purchase_order_id` auto-matches the PO's posted receipts: `received_value = Σ(qty_accepted × unit_cost_cents)`, tolerance `max(500¢, 2%)` → `matched | variance | exception`.
- On approve (within tolerance) it creates an AP `invoices` header (`gl_status='unposted'`) and auto-posts `ap_invoice_grir_match` (rule `apInvoiceGrirMatch.js`): **DR 2050 GR-IR / DR-or-CR 6320 PO-Variance / CR 2010 AP**. This is exactly the entry that *clears* the GR/IR the receipt accrued.
- Out of tolerance → leaves an `unposted` AP draft for the bookkeeper.

### 2.3 AP invoice posting engine  ✅ PO-model-agnostic
`api/_handlers/internal/ap-invoices/post.js` + rule `apInvoiceReceived.js`
- Reads `invoice_line_items`: a line with `inventory_item_id` → **DR 1310 Inventory** (+ optional FIFO layer); without → **DR expense**. **CR 2010 AP** for the total.
- Resolves accounts by code (1310/2010), brand stock pool via `resolveReceivingPartition(brand_id, channel)`, brand-rollup split via `expandApExpenseLines`. None of this depends on the PO source.

### 2.4 Vendor submit  ✅ done (#1401)
`api/_handlers/vendor/invoices.js` now resolves `po_id` against **both** `tanda_pos` and `purchase_orders` with a per-source invoiceable gate. A Tangerine-PO invoice lands in `invoices` as `status='submitted'`, `po_id = purchase_orders.id`, lines `po_line_item_id = purchase_order_lines.id`, `inventory_item_id = NULL`.

### GL accounts in play
`1310` Inventory · `2010` AP · `2050` GR/IR (goods) · `2150` Accrued Landed · `6320` PO Variance.

---

## 3. The gap — the bridge + inventory grain

Two disconnects remain:

### Gap A — vendor-submitted invoice is **disconnected from the 3-way-match pipeline**
The two AP intakes are separate:
1. **Vendor portal** writes directly to `invoices` (`status='submitted'`).
2. **3-way match** operates on `vendor_invoice_drafts` (created **manually**, `source_kind='manual'` — there is **no `source_invoice_id`** column linking a vendor-submitted `invoices` row to a draft).

So a vendor's Tangerine-PO invoice never enters the receipt-matching / GR-IR-clearing flow. If a bookkeeper just posts the submitted invoice via `ap-invoices/post.js`, its lines have `inventory_item_id = NULL` → it books **expense, not inventory**, and **never clears the GR/IR** the receipt accrued → GR/IR balance grows and inventory is mis-stated. **This is the core thing to fix.**

### Gap B — `inventory_item_id` never populated on vendor-invoice lines
`vendor/invoices.js` and the draft→AP approval both leave `invoice_line_items.inventory_item_id = NULL`. For the **no-receipt / direct-capitalization** path (invoice arrives before any receipt), the AP post can't book inventory without it. It is resolvable: `invoice_line_items.po_line_item_id → purchase_order_lines.inventory_item_id`.

---

## 4. Proposed design

**Principle:** reuse the existing native pipeline; do **not** write a second GL path. The accounting truth is: **receipt capitalizes inventory (DR 1310 / CR 2050); the matched invoice clears GR/IR (DR 2050 / CR 2010).** A Tangerine-PO vendor invoice must flow through that, not post inventory a second time.

### Phase 1 — Route the vendor invoice into the 3-way-match pipeline (the bridge)
1. Add `vendor_invoice_drafts.source_invoice_id uuid` (→ `invoices`) + `source_kind='vendor_portal'` (migration).
2. On vendor submit against a **Tangerine PO** (or on an internal "stage for match" action), create a `vendor_invoice_drafts` row from the submitted invoice: `vendor_id`, `vendor_invoice_number`, `total_cents`, `purchase_order_id = invoices.po_id`, `source_invoice_id`. The existing `computeMatchForPo` then runs unchanged.
3. On approve-within-tolerance, the existing `ap_invoice_grir_match` auto-post fires → GR/IR cleared, AP credited. Link the resulting AP invoice back (`ap_invoice_id`) and mark the source vendor invoice consumed.
   - **Decision needed (operator):** auto-create the draft on submit, or keep an explicit internal "send to 3-way match" step? (Recommend explicit, to preserve a human gate before GL.)

### Phase 2 — `inventory_item_id` resolution for the no-receipt / direct path
- When promoting to an AP invoice with no matching receipt, resolve each line's `inventory_item_id` from its `purchase_order_lines` row and set it on `invoice_line_items`, so `apInvoiceReceived` books **DR 1310 Inventory** + a FIFO layer (capitalize on the bill when goods weren't separately received).
- Guard against double-capitalization: only take the direct-inventory path when **no** posted receipt exists for that PO line; otherwise use the GR/IR-clearing path (Phase 1).

### Phase 3 — edges & polish
- Variance routing (6320) already exists; confirm tolerance for Tangerine.
- Brand stock pool / receiving partition already resolved from the invoice header — confirm `brand_id`/`receiving_channel` get set for Tangerine-PO invoices.
- Reporting: ensure AP aging / GR-IR reconciliation include Tangerine-PO invoices (they're plain `invoices` rows, so likely free).

---

## 5. Open decisions for the operator
1. **Auto vs. manual bridge** — auto-create the match draft on vendor submit, or require an internal "stage for 3-way match" click? (Recommend manual gate before any GL.)
2. **Invoice-before-receipt** — is capitalizing inventory directly off the bill (Phase 2) wanted, or should an invoice with no receipt be **blocked** until goods are received? (Cleaner GR/IR if blocked.)
3. **Match tolerance** for Tangerine POs — keep `max(500¢, 2%)`?

---

## 6. Risks & verification
- **GL-critical.** Every change posts to the ledger. Build behind the existing posting rules (`postEvent`) — never hand-write journal lines. Reuse `apInvoiceGrirMatch` / `inventoryReceipt` / `apInvoiceReceived`.
- **Double-booking inventory** is the top risk (Gap B vs. Gap A). The receipt-exists guard in Phase 2 is mandatory.
- **Verification:** in a test entity, run the full path — native PO → receipt (DR 1310/CR 2050) → vendor invoice → 3-way match approve → assert `ap_invoice_grir_match` cleared 2050 to 0 and credited 2010; then the no-receipt path asserts DR 1310 + FIFO layer once. Check GR/IR aging nets to zero. Do it in an **isolated worktree** (GL-sensitive).

---

## 7. Effort estimate
Smaller than first feared — the heavy GL machinery is built and Tangerine-native.
- **Phase 1 (bridge):** ~1 migration + the draft-from-invoice creation + back-link. **M.**
- **Phase 2 (inventory_item_id + direct path):** resolution + double-book guard. **S–M.**
- **Phase 3 (edges/reporting):** **S.**

---

## 8. File:line map (current state — for the implementer)
- Vendor submit (done): `api/_handlers/vendor/invoices.js` (dual-source after #1401).
- Native receipt → GL: `api/_handlers/internal/procurement/receipts/post.js`; rule `api/_lib/accounting/posting/rules/inventoryReceipt.js`.
- 3-way match + GR/IR clear: `api/_handlers/internal/procurement/vendor-invoice-drafts/{index,[id]}.js`; rule `…/rules/apInvoiceGrirMatch.js`.
- AP post engine: `api/_handlers/internal/ap-invoices/post.js`; rule `…/rules/apInvoiceReceived.js`.
- `vendor_invoice_drafts` columns: id, entity_id, vendor_id, vendor_invoice_number, invoice_date, due_date, currency, total_cents, source_kind, source_pdf_document_id, ocr_*, three_way_match_status, matched_po_ids, matched_receipt_ids, variance_cents, variance_reason, ap_invoice_id, approved_by_user_id, approved_at, rejected_reason, created_at, updated_at — **no source_invoice_id (the Phase-1 add)**.
