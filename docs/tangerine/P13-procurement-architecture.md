# Tangerine P13 — Procurement Architecture Pass (PO Origination + Receiving + QC + Trade Compliance)

Status: **DRAFT** (2026-05-29). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the standing plan-approval-not-implementation rule.

Implements four roadmap modules as a single coordinated phase:

- **M11 — Purchase Order Origination** (operator creates POs in Tangerine, sends them to vendors, tracks acknowledgment, in-production milestones, ship dates, and remaining-balance via the existing PO WIP / Tanda app pattern — *but as the system of record*, not a Xoro mirror)
- **M38 — Receiving Workflow** (line-by-line + carton-level + GS1 SSCC-aware receiving against an open PO, with putaway location capture, short/over/damage exception handling, and an auto-draft AP bill on three-way-match)
- **M26 — QC / Inspections** (lot-level inspection gating between receiving and putaway: pass/fail/conditional with photo evidence and rework loop)
- **M48 — Trade Compliance** (HTS classification, country-of-origin capture, customs entry / 7501 mirroring, duty + MPF + HMF + Section-301 tariff capitalization into inventory cost, broker invoice reconciliation)

P13 is the **first phase that breaks Xoro's hold on the purchasing side** of the operator's workflow. After P11 (Shopify) + P12 (Marketplaces) cut Xoro out of three revenue channels, P13 cuts it out of the inbound side: PO creation, receiving, QC, and landed-cost. Combined, P11 + P12 + P13 leave Xoro responsible for SO entry, 3PL EDI handling, and the EDI-loop revenue side (which P16 + P21 + P22 unwind).

The strategic frame: today the operator originates POs in Xoro → 3PL receives via EDI 856 → Xoro auto-creates the AP bill → flows to Tangerine via T10 mirror with `source='xoro_mirror'`. That works but: (a) PO entry UX in Xoro is heavy + matrix-unfriendly, (b) receiving exceptions (shortages, overages, damage, wrong SKU) are flattened by EDI translation before they reach the operator's view, (c) QC step is entirely off-system (paper checklists in production), (d) landed cost is operator-typed once-per-PO with no audit trail of duty / freight / broker allocations. **P13 puts all of this on Tangerine rails** — PO origination is the matrix UI primitive's first revenue-grade test, receiving captures exception detail the EDI flattens, QC inspections gate inventory availability, and trade compliance allocates real landed cost into FIFO layers.

---

## 0. Scope guardrails

**In scope — full inbound supply chain on Tangerine rails:**

- **PO origination** — operator creates POs in the existing Tanda / PO WIP UI, but the row is the system of record (not a Xoro mirror). Header: vendor, ship-to entity, ship-from country, requested ship date, requested in-DC date, currency (USD only at launch — D2 in P1), incoterms, payment terms. Lines: matrix-aware (Style × Color × Size × Inseam × Length × Fit) with qty + unit cost + expected ship + HTS code + COO at the line level. Replaces Xoro's PO entry as the source of truth.
- **PO sending / acknowledgment** — operator sends the PO to the vendor through (a) the existing Vendor Portal (`vendor_users` + `tanda_pos` already wired) for vendors on the portal, (b) email PDF for vendors not on the portal. Acknowledgment captures vendor-confirmed ship date, vendor-confirmed unit cost (variance flagged), and vendor-confirmed qty.
- **PO change orders** — operator-initiated amendments tracked as new revisions on the same PO id; existing `tanda_milestone_change_requests` flow is reused. Vendor can request changes through the Vendor Portal which become approval items.
- **PO milestone tracking** — reuse the existing PO WIP phase / milestone primitive (production-start, fabric-cut, sewing, finishing, packing, ship-ready). The data model is already in place under `tanda_milestones`; P13 makes it write-through to GL where applicable (e.g. milestone-based progress invoicing is OUT — but milestone-based commitment accounting is IN).
- **PO commitment GL** — open POs accrue an off-balance-sheet commitment row in a new `po_commitments` table; commitments roll off as receipts land. Reports surface open commitment by vendor + by category + by ship-period.
- **Receiving workflow** — when goods arrive, operator (or scanner via M39) opens a receiving session against the PO. Session captures: receipt date, dock, carrier, BOL/tracking, container/SSCC if GS1-labeled, line-level qty received, exception conditions (short / over / damaged / wrong-SKU / late). Multiple receiving sessions per PO supported (partial receipts).
- **Auto-draft AP bill on three-way-match** — once a receiving session is closed AND a vendor invoice is matched (vendor uploads PDF in Vendor Portal, or operator drops it in AP inbox), Tangerine drafts an AP bill pre-populated from PO + receipt + invoice. Operator reviews variance + posts. Matches the manual-fallback principle: operator can always type the AP bill directly without the three-way handshake.
- **QC inspection step (between receiving and putaway)** — receiving moves goods to a `kind='inspection_hold'` location. QC inspector opens an inspection record per receipt line: pass / fail / conditional-pass. Pass → released to putaway. Fail → goods stay quarantined, RMA-to-vendor or write-off path triggered. Conditional → released with notes (e.g. "shade off but acceptable"). Photo evidence attached via M29 Document Management.
- **Putaway** — released-from-QC goods get a putaway location (warehouse bin code). M37 Inventory Operations primitive (already partial in P3) provides the bin schema; P13 wires the receiving → QC → putaway flow that consumes it.
- **Trade compliance** — every PO line carries HTS (Harmonized Tariff Schedule) code + COO. On entry into the US, customs duties + Merchandise Processing Fee (MPF) + Harbor Maintenance Fee (HMF) + any Section-301 tariffs are captured from the broker's CBP Form 7501 entry summary. These charges capitalize into the receipt's FIFO unit cost, not into expense.
- **Broker invoice reconciliation** — the freight forwarder / customs broker invoices for duty + brokerage + freight after the goods land. Tangerine matches the broker invoice against the customs entry + receipts, allocating duty to per-line landed cost and brokerage/freight to a configurable rule (default: allocate by line value or by line weight depending on operator preference per vendor).
- **Multi-PO consolidation in one shipment** — common in apparel sourcing: vendor combines 3 POs in one container. Receiving + customs entry shapes support N:M PO → shipment → entry.
- **Manual-fallback path** — operator can always (a) type a PO directly in the existing Tanda UI without any vendor integration, (b) close a receiving session manually without scanner / EDI, (c) skip QC if the SKU isn't QC-gated, (d) post landed cost as a single typed adjustment if the broker workflow is bypassed.
- **Source-tagging** — every PO, receipt, QC inspection, and customs entry carries a `source` tag. Tangerine-originated rows are `source='tangerine'`. Xoro-mirrored rows (during parallel run) are `source='xoro_mirror'`. EDI-ingested rows (post-P22) will use `source='edi_850_ack'` / `source='edi_945_recv'`. Per T10 enforcement, NEVER cross sources during a write.

**Explicitly OUT of scope (deferred):**

- **EDI 850 / 855 / 856 / 943 / 945 protocol implementation** — that's M14 EDI / P22. P13 ships the data shapes those EDI flows will populate; the actual EDI translator + AS2/SFTP transport waits. Manual entry + Vendor Portal + email-PDF cover the gap.
- **3PL handoff (M13)** — Tangerine receiving in P13 assumes operator's own warehouse OR the operator stands at the 3PL with a phone. The 3PL EDI 943/944 push lands in M13 / P21. Until then, 3PL receivings are typed in.
- **Multi-currency PO pricing** — locked-decision USD-only (P1 D1). PO lines store `unit_price_cents` in USD; FX accrual is M22 / P25.
- **Vendor RMAs to send goods back** — a vendor-RMA workflow is recorded as a placeholder status on failed-QC receipts; the operational follow-up + credit memo from vendor is M23 (RMA) / P19. P13 just marks the goods as `disposition='vendor_rma_pending'` and reverses the receipt.
- **Tangerine → Vendor Portal PO push for vendors NOT on the portal** — they get a PDF email. Bringing the long-tail vendors onto the portal is M35 Vendor Master enhancement, not in P13.
- **MPF / HMF rate engine** — duty rates change at the SKU × COO × trade-program (USMCA / GSP / CAFTA / etc.) intersection. P13 captures broker-reported duty as the canonical figure; rate-prediction (operator types HTS, system predicts duty) is a v2 feature.
- **Drawback claims (export-then-import duty refund)** — sophisticated apparel-importer flow; not in operator's current playbook. Schema supports recording but no workflow.
- **Section-321 de-minimis tracking** — only relevant for direct-to-consumer cross-border; not the operator's flow.
- **Anti-dumping / countervailing duty cases** — surface in `customs_entries.notes` only.
- **Foreign-Trade Zone (FTZ) inventory** — operator does not use an FTZ.

---

## 1. Existing state (one-paragraph map)

After P1-P8 + T10 Shadow Mirror + P9 (parallel-run framework drafted) + P10 (tenancy) + P11 (Shopify in flight) + P12 (Marketplaces in flight): Tangerine has the financial layer, multi-location FIFO inventory (P12-0 shipped `inventory_locations` + `inventory_layers.location_id`), CRM, PIM, Cases, sales reps, and three direct-platform-API integrations on the revenue side. **The PO + receiving side is still Xoro-driven** — POs originate in Xoro, are emailed/EDI'd to vendors, vendors ship, goods arrive at the 3PL or operator WH, 3PL EDI 943/856 lands in Xoro, Xoro auto-creates the AP bill, T10 mirrors that AP bill into Tangerine with `source='xoro_mirror'`. The existing Tangerine UI surfaces show this data (PO WIP / Tanda app reads `tanda_pos` + `po_line_items` + `tanda_milestones`) but every write happens in Xoro. P13 reverses the flow: writes happen in Tangerine, Xoro mirror runs in parallel during the cutover window, and once variance is clean per channel-of-vendor, Xoro's PO module is shut off. The existing `tanda_pos` / `po_line_items` / `receipts` / `receipt_line_items` tables already carry the right shape — P13 extends rather than replaces them.

---

## 2. Decisions (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Reuse existing `tanda_pos` + `po_line_items` vs new `purchase_orders` table | **Reuse** — extend `tanda_pos` with the missing P13 columns (status enum, source tag, commit_je_id, etc.) and treat existing PO WIP UI as the canonical surface | `tanda_pos` already has 5+ years of data, ships with PO WIP UI, vendor-portal acknowledgments wired in, and `entity_id DEFAULT rof_entity_id()` per PR #463. A parallel `purchase_orders` table fractures the data model and breaks the existing UI. The tradeoff: column names retain the `tanda_` prefix even after Tangerine becomes the source of truth. Acceptable per the no-regen rule. | ☐ |
| D2 | PO numbering scheme | **Per-entity monotonic counter with prefix: `RP-2026-00001`** (RoF PO + fiscal year + 5-digit). Stored in `tanda_pos.po_number`. Generated server-side via sequence-per-entity-per-year. | Matches the operator's existing Xoro convention close enough to be readable side-by-side during parallel run. Sequence-based avoids race conditions on concurrent creation. Year-rollover handled by a tiny cron. | ☐ |
| D3 | PO commitment accounting (open POs accrue an off-BS commitment) | **YES — separate `po_commitments` table + budget-style report; NOT a GL accrual** | Posting commitments to GL would force a "Goods on Order" account on the balance sheet, which IFRS/GAAP don't require for fashion inventory. A management-report commitment (off-balance-sheet) gives operator the open-PO-by-vendor view without polluting the financials. | ☐ |
| D4 | Three-way match tolerance | **$5 OR 2% per line, whichever is higher, on unit cost variance; full-qty match on line qty** | Cost variance under $5 is rounding (FX, vendor pricing roundoff). Above tolerance → variance row in AP review queue. Qty variance is always flagged (short / over). | ☐ |
| D5 | QC inspection gating | **Configurable per vendor: vendor.qc_required boolean defaulting to TRUE for new vendors, FALSE for vendors with `qc_passes >= 12` over rolling 12mo (trusted vendor escape valve)** | Operator can't physically inspect every receipt from every vendor; gating to high-risk + new vendors is realistic. Trust ladder rewards good vendor history. | ☐ |
| D6 | QC failure disposition | **4 options per failed line: `vendor_rma`, `vendor_credit_only` (operator keeps goods at discount), `write_off`, `rework_inhouse`** | Covers the practical paths. `vendor_rma` triggers a placeholder return shipment row (M23 wires the actual debit memo in P19). `vendor_credit_only` posts an AP debit memo immediately. `write_off` posts `6420 Inventory Write-off`. `rework_inhouse` moves goods to a `kind='rework'` location and tracks labor against the original receipt. | ☐ |
| D7 | Landed cost allocation method | **Default: allocate duty + brokerage + freight by line `extended_value`. Per-vendor override to `weight` or `cbm` when operator knows that vendor prices differently (e.g. heavy denim by weight).** | Value-weighted is the IRS / IFRS default and is right for >90% of apparel. Weight/CBM override handles the edge cases. Stored in `vendors.landed_cost_allocation_method`. | ☐ |
| D8 | Duty + tariff capitalization | **Capitalize into FIFO unit cost** — `inventory_layers.unit_cost_cents` includes duty + MPF + HMF + Section-301 + allocated freight + allocated brokerage at the moment of layer creation | This is the canonical apparel-importer cost model. IRS Section 263A (UNICAP) requires it for U.S. importers. The alternative — expensing landed cost separately — distorts gross margin and is non-GAAP for inventory-heavy businesses. | ☐ |
| D9 | Customs entry timing | **Lazy capitalization with revaluation JE** — receipt creates the FIFO layer at PO unit cost on the receipt date; when broker invoice + 7501 arrive (typically T+10 to T+30 days), a revaluation JE adjusts remaining layers to actual landed cost. Already-consumed units stay at PO cost (no retroactive COGS) → small permanent margin variance reflects the operator's actual cash-flow timing. | The clean alternative — block receipt until customs lands — kills the warehouse flow. Lazy revaluation matches operator's economic reality and the revaluation amount is rarely material (~2-3% of receipt value spread across remaining inventory). | ☐ |
| D10 | HTS code mastering | **Per `ip_item_master.hts_code` (10-digit) + per-PO-line override** — the SKU's default HTS comes from style master, but operator can override per PO when sourcing changes the classification | Apparel HTS codes are SKU-stable 99% of the time (men's cotton T-shirts, HTS 6109.10.00.04). Edge case: same SKU sourced from a different country sometimes ends up in a different statistical suffix. Override at PO-line level handles it. | ☐ |
| D11 | Country of origin (COO) declaration | **Per PO line, defaults from vendor's `country` + style's `default_coo`; required before customs entry can post** | Already on `vendors.country`; SKUs at `ip_item_master.country_of_origin` (existing column). COO at the line level handles vendor-makes-it-in-multiple-countries (rare but real). | ☐ |
| D12 | Multi-PO-in-one-container | **Many-to-many — `customs_entries` has `entry_line_id`s that reference receipt-line ids, which join back to po-line ids. One entry covers N POs; one PO can split across N entries.** | Operational reality of LCL ocean freight + air consolidations. Schema supports cleanly; UX is "add receipt line → entry" rather than a strict PO 1:1 entry. | ☐ |
| D13 | Receiving session UI grain | **Matrix-aware** — receiving session opens at PO-level and presents the 5-dim matrix (Style × Color × Size × Inseam × Length × Fit) for each line; operator types received qty into matrix cells. For GS1-labeled cartons, scanner posts directly via the M39 scanner REST contract (already shipped P3). | This is the matrix primitive's first real receiving test. Without it, operator types 30+ rows per PO instead of pasting a matrix grid. | ☐ |
| D14 | Vendor invoice ingestion (the AP-bill input to three-way match) | **Three paths: (a) Vendor uploads PDF in Vendor Portal → OCR-extract + operator review, (b) operator drops PDF in AP inbox → OCR-extract, (c) operator types directly bypassing OCR.** OCR via existing vendor-portal infrastructure (the portal already accepts PDF attachments per the M29 doc spec). | OCR-first matches the operator's actual mailroom flow. Manual fallback per the standing principle. | ☐ |
| D15 | Tangerine ⇄ Xoro PO ingestion cutover | **Per vendor, post-8-week parallel run with three-way-match variance < $5/$2% and zero unmatched receipts, flip Xoro's PO module off for THAT vendor.** Other vendors stay parallel until each independently passes. | Parallel-run per channel pattern from P11 D12 + P12 D18, adapted to vendor grain because vendor is the right unit for PO origination (one vendor at a time can be flipped without touching others). 8 weeks because PO lifecycle (creation → ship → land → AP-bill) typically runs 6-12 weeks for ocean freight — needs a full cycle to validate. | ☐ |
| D16 | Period close pre-flight extensions | **Block close if any of: receipt > 30 days old without matching customs entry, customs entry > 60 days old without broker invoice, three-way-match variance unresolved, QC fail without disposition** | Mirrors the P5-7 + P12 D17 pattern. Procurement has its own class of stale-state risks. | ☐ |
| D17 | Source-tag enforcement | **Per T10: every new row carries `source` enum. PO source values: `'tangerine'` (operator-created in Tangerine UI), `'xoro_mirror'` (T10 mirror during parallel run), `'edi_850_ack'` (post-P22, reserved). T10 mirror never overwrites `source='tangerine'`.** | Standing T10 + manual-fallback principle. Allows operator to confirm parallel-run cutover per vendor by inspecting source-tag mix in `tanda_pos`. | ☐ |
| D18 | First vendor for the parallel-run pilot | **Operator picks one — recommended: a vendor with monthly cadence + reliable invoicing (so a full PO cycle completes inside the parallel window). Likely candidates from `vendors` where the operator already trusts the ack flow on the Vendor Portal.** | Parallel-run needs at least one full PO→ship→land→AP cycle to validate. Picking the right pilot vendor compresses validation from 12 weeks to 6-8. | ✓ **Zhejiang Zhuji Newdan Garment Co., Ltd.** |
| D19 | Receipt-time landed-cost rollup workflow with auto-AP-invoice + bookkeeper approval gate | **At receipt close, the receiving user can add N `tanda_po_receipt_rollups` lines — each is (expense GL account, amount, optional vendor, capitalize-to-inventory boolean). Each rollup auto-creates a sibling AP `invoices` row with `is_receipt_rollup=true`, `rollup_parent_receipt_id=<receipt.id>`, and `status='pending_bookkeeper_approval'`. The rollup amount folds into `receipts.landed_cost_cents` so the FIFO layer's `unit_cost_cents` is correct from day one. The auto-created AP invoices' JEs do NOT post until a bookkeeper-role user approves them (status → `approved` → P3 AP posting service runs).** Replaces D9's "lazy revaluation 10-30 days later" gap with a tighter receipt-time pattern for ops who'd rather pay vendors immediately and let the bookkeeper batch-approve at month-end. D9 remains the fallback when broker timing forces it. | Operator's mental model: at receiving, the warehouse already knows about (a) the inbound freight invoice from the freight forwarder, (b) the broker fee, (c) duty pre-paid via the broker, (d) inspection / drayage / per-diem charges. Folding them into the layer *at receipt* matches IRS §263A and gives a correct unit cost from day one. The bookkeeper approval gate prevents warehouse staff from accidentally posting an unverified vendor invoice into the GL. Lands in P13-1 schema + UI wires in P13-3 (receiving session). | ✓ |

---

## 3. Schema additions

### 3.1 `tanda_pos` extensions (alter only — no new PO table)

```sql
-- Status lifecycle for Tangerine-originated POs
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS status text
  CHECK (status IN ('draft','submitted','acknowledged','partial_ack',
                    'in_production','shipped','received','closed','cancelled'))
  DEFAULT 'draft';

-- Source tag per T10 enforcement
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS source text
  CHECK (source IN ('tangerine','xoro_mirror','edi_850_ack','manual'))
  DEFAULT 'tangerine';

-- Header-level Tangerine-managed fields
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS ship_to_entity_id uuid REFERENCES entities(id);
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS incoterms text
  CHECK (incoterms IN ('EXW','FOB','CIF','CFR','DDP','DAP','DDU') OR incoterms IS NULL);
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS payment_terms_id uuid REFERENCES payment_terms(id);
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS currency char(3) NOT NULL DEFAULT 'USD';
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS requested_ship_date date;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS confirmed_ship_date date;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS requested_in_dc_date date;

-- Commitment posting linkage (D3 — off-BS but tracked)
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS commitment_total_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS commitment_remaining_cents bigint NOT NULL DEFAULT 0;

-- Cancellation audit
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid REFERENCES auth.users(id);
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS cancel_reason text;

-- Tangerine PO numbering counter helper
CREATE TABLE IF NOT EXISTS po_number_sequences (
  entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  fiscal_year int NOT NULL,
  last_seq    int NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, fiscal_year)
);

CREATE INDEX IF NOT EXISTS idx_tanda_pos_status ON tanda_pos (status) WHERE status NOT IN ('closed','cancelled');
CREATE INDEX IF NOT EXISTS idx_tanda_pos_source ON tanda_pos (source) WHERE source = 'tangerine';
```

### 3.2 `po_line_items` extensions

```sql
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS sku_id uuid REFERENCES ip_item_master(id);
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS hts_code text;
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS country_of_origin char(2);
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS confirmed_unit_price_cents bigint;
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS confirmed_qty numeric;
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS confirmed_ship_date date;
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS line_total_cents bigint;
-- existing `unit_price` / `line_total` (numeric, USD scaled) preserved for back-compat; new _cents columns
-- become the canonical Tangerine-source values during cutover, populated by trigger from existing columns.
```

### 3.3 `po_commitments` (new — off-balance-sheet open-PO tracking)

```sql
CREATE TABLE IF NOT EXISTS po_commitments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT DEFAULT rof_entity_id(),
  po_id                    uuid NOT NULL REFERENCES tanda_pos(id) ON DELETE CASCADE,
  po_line_item_id          uuid REFERENCES po_line_items(id) ON DELETE CASCADE,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  expected_account_id      uuid REFERENCES gl_accounts(id),   -- e.g. 1300 Inventory Asset for stocked SKUs
  committed_at             timestamptz NOT NULL DEFAULT now(),
  committed_amount_cents   bigint NOT NULL,
  consumed_amount_cents    bigint NOT NULL DEFAULT 0,
  remaining_amount_cents   bigint GENERATED ALWAYS AS (committed_amount_cents - consumed_amount_cents) STORED,
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','closed','cancelled')),
  expected_in_dc_date      date,
  closed_at                timestamptz
);

CREATE INDEX IF NOT EXISTS idx_po_commitments_open
  ON po_commitments (entity_id, vendor_id) WHERE status IN ('open','partial');
CREATE INDEX IF NOT EXISTS idx_po_commitments_expected_in_dc
  ON po_commitments (expected_in_dc_date) WHERE status IN ('open','partial');
```

### 3.4 `receipts` / `receipt_line_items` extensions

The existing tables already carry the right shape from the Xoro-mirror era. P13 adds the source tag + QC routing fields.

```sql
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS source text
  CHECK (source IN ('tangerine','xoro_mirror','edi_945_recv','manual','scanner'))
  DEFAULT 'tangerine';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receiving_dock text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS carrier_name text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS container_number text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS bol_number text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS gs1_sscc_codes text[] DEFAULT '{}';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qc_required boolean NOT NULL DEFAULT true;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qc_completed_at timestamptz;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS putaway_completed_at timestamptz;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS customs_entry_id uuid;     -- forward FK to customs_entries (3.7)
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS broker_invoice_id uuid;    -- forward FK to broker_invoices (3.8)

ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS sku_id uuid REFERENCES ip_item_master(id);
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS quantity_accepted numeric;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS quantity_rejected numeric;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS qc_disposition text
  CHECK (qc_disposition IN ('pending','pass','conditional_pass','fail') OR qc_disposition IS NULL);
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS putaway_location_id uuid REFERENCES inventory_locations(id);
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS landed_cost_per_unit_cents bigint;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS inventory_layer_id uuid REFERENCES inventory_layers(id);
```

### 3.5 `qc_inspections` (new)

```sql
CREATE TABLE IF NOT EXISTS qc_inspections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT DEFAULT rof_entity_id(),
  receipt_id               uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  receipt_line_item_id     uuid NOT NULL REFERENCES receipt_line_items(id) ON DELETE CASCADE,
  inspector_user_id        uuid REFERENCES auth.users(id),
  inspected_at             timestamptz NOT NULL DEFAULT now(),
  disposition              text NOT NULL CHECK (disposition IN ('pass','conditional_pass','fail')),
  qty_inspected            numeric(18,4) NOT NULL,
  qty_passed               numeric(18,4) NOT NULL,
  qty_conditional          numeric(18,4) NOT NULL DEFAULT 0,
  qty_failed               numeric(18,4) NOT NULL DEFAULT 0,
  failure_disposition      text CHECK (failure_disposition IN
                              ('vendor_rma','vendor_credit_only','write_off','rework_inhouse')
                              OR failure_disposition IS NULL),
  failure_reason           text,
  photo_attachment_ids     uuid[] DEFAULT '{}',     -- M29 documents
  rework_completed_at      timestamptz,
  vendor_credit_invoice_id uuid REFERENCES invoices(id),
  writeoff_je_id           uuid REFERENCES journal_entries(id),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qc_inspections_open
  ON qc_inspections (entity_id, disposition) WHERE disposition = 'fail' AND failure_disposition IS NULL;
```

### 3.6 `vendor_invoice_drafts` (new — three-way-match staging)

The vendor's invoice arrives separately from receipt + PO. We stage it for matching before it becomes an AP `invoices` row.

```sql
CREATE TABLE IF NOT EXISTS vendor_invoice_drafts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT DEFAULT rof_entity_id(),
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  vendor_invoice_number    text NOT NULL,
  invoice_date             date NOT NULL,
  due_date                 date,
  currency                 char(3) NOT NULL DEFAULT 'USD',
  total_cents              bigint NOT NULL,
  source_kind              text NOT NULL CHECK (source_kind IN ('vendor_portal_upload','ap_inbox_pdf','manual','edi_810')),
  source_pdf_document_id   uuid,                              -- M29 Document Management ref
  ocr_extracted_payload    jsonb,
  ocr_confidence_pct       numeric(5,2),
  three_way_match_status   text NOT NULL DEFAULT 'pending'
                           CHECK (three_way_match_status IN ('pending','matched','variance','exception','posted','rejected')),
  matched_po_ids           uuid[] DEFAULT '{}',
  matched_receipt_ids      uuid[] DEFAULT '{}',
  variance_cents           bigint NOT NULL DEFAULT 0,
  variance_reason          text,
  ap_invoice_id            uuid REFERENCES invoices(id),
  approved_by_user_id      uuid REFERENCES auth.users(id),
  approved_at              timestamptz,
  rejected_reason          text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_invoice_drafts_unique UNIQUE (vendor_id, vendor_invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_vendor_invoice_drafts_open
  ON vendor_invoice_drafts (three_way_match_status) WHERE three_way_match_status IN ('pending','variance','exception');
```

### 3.7 `customs_entries` (new)

```sql
CREATE TABLE IF NOT EXISTS customs_entries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT DEFAULT rof_entity_id(),
  entry_number             text NOT NULL,                    -- CBP entry number, 11 digits
  entry_date               date NOT NULL,
  port_of_entry            text,
  importer_of_record       text,
  broker_name              text,
  broker_id                text,
  total_entered_value_cents bigint NOT NULL,
  total_duty_cents         bigint NOT NULL DEFAULT 0,
  total_mpf_cents          bigint NOT NULL DEFAULT 0,
  total_hmf_cents          bigint NOT NULL DEFAULT 0,
  total_section_301_cents  bigint NOT NULL DEFAULT 0,
  total_other_fees_cents   bigint NOT NULL DEFAULT 0,
  form_7501_document_id    uuid,                             -- PDF of CBP Form 7501 via M29
  raw_payload              jsonb DEFAULT '{}'::jsonb,
  revaluation_je_id        uuid REFERENCES journal_entries(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customs_entries_unique UNIQUE (entity_id, entry_number)
);

CREATE TABLE IF NOT EXISTS customs_entry_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customs_entry_id         uuid NOT NULL REFERENCES customs_entries(id) ON DELETE CASCADE,
  receipt_line_item_id     uuid REFERENCES receipt_line_items(id) ON DELETE SET NULL,
  hts_code                 text NOT NULL,
  country_of_origin        char(2) NOT NULL,
  trade_program            text,                             -- 'USMCA','GSP','CAFTA','MFN','S301'
  entered_value_cents      bigint NOT NULL,
  duty_rate_pct            numeric(7,4),
  duty_cents               bigint NOT NULL DEFAULT 0,
  section_301_rate_pct     numeric(7,4),
  section_301_cents        bigint NOT NULL DEFAULT 0,
  mpf_cents                bigint NOT NULL DEFAULT 0,
  hmf_cents                bigint NOT NULL DEFAULT 0,
  CONSTRAINT customs_entry_lines_unique UNIQUE (customs_entry_id, receipt_line_item_id)
);

ALTER TABLE receipts ADD CONSTRAINT IF NOT EXISTS receipts_customs_fk
  FOREIGN KEY (customs_entry_id) REFERENCES customs_entries(id) ON DELETE SET NULL;
```

### 3.8 `broker_invoices` (new)

```sql
CREATE TABLE IF NOT EXISTS broker_invoices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT DEFAULT rof_entity_id(),
  customs_entry_id         uuid REFERENCES customs_entries(id) ON DELETE SET NULL,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,   -- the broker as vendor
  broker_invoice_number    text NOT NULL,
  invoice_date             date NOT NULL,
  freight_cents            bigint NOT NULL DEFAULT 0,
  brokerage_fee_cents      bigint NOT NULL DEFAULT 0,
  duty_advance_cents       bigint NOT NULL DEFAULT 0,
  other_cents              bigint NOT NULL DEFAULT 0,
  total_cents              bigint NOT NULL,
  ap_invoice_id            uuid REFERENCES invoices(id),
  allocation_method        text NOT NULL DEFAULT 'value'
                           CHECK (allocation_method IN ('value','weight','cbm','manual')),
  allocation_je_id         uuid REFERENCES journal_entries(id),
  created_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE receipts ADD CONSTRAINT IF NOT EXISTS receipts_broker_fk
  FOREIGN KEY (broker_invoice_id) REFERENCES broker_invoices(id) ON DELETE SET NULL;
```

### 3.9 `vendors` + `ip_item_master` small extensions

```sql
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qc_required boolean NOT NULL DEFAULT true;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qc_pass_count_12mo int NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS landed_cost_allocation_method text NOT NULL DEFAULT 'value'
  CHECK (landed_cost_allocation_method IN ('value','weight','cbm'));
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parallel_run_complete boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parallel_run_started_at timestamptz;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS pilot_vendor boolean NOT NULL DEFAULT false;

ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS hts_code text;
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS default_coo char(2);
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS unit_weight_grams int;
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS unit_cbm_cm3 int;
```

### 3.10 New GL accounts seeded

| Code | Name | Type | Normal | Notes |
|---|---|---|---|---|
| 1310 | Inventory In-Transit | asset | DEBIT | Shipped from vendor, not yet received — bridge to landed cost |
| 1320 | Inventory On QC Hold | asset | DEBIT | Received but not yet QC-released |
| 5100 | Inbound Freight | expense | DEBIT | Capitalized; surfaces in landed cost workflow but rolls into 1300 |
| 5110 | Customs Duty | expense | DEBIT | Same — capitalized into 1300 via allocation JE |
| 5120 | Brokerage + Clearance | expense | DEBIT | Same |
| 5130 | Section 301 Tariffs | expense | DEBIT | Same |
| 6420 | Inventory Write-off | expense | DEBIT | Already shipped in P12-0 — reused for QC fails |
| 2150 | Accrued Customs / Duty | liability | CREDIT | Receipt without broker invoice → accrue expected duty |
| 6320 | PO Variance Expense | expense | DEBIT | Three-way-match variance > tolerance; net of vendor credits |

### 3.11 `tanda_po_receipts` + `tanda_po_receipt_lines` + `tanda_po_receipt_rollups` (new — D19)

The existing `receipts` / `receipt_line_items` tables (3.4) carry the legacy Xoro-mirrored receipt shape. P13 introduces a parallel **Tangerine-native** receipt table set that wires the D19 landed-cost-rollup workflow + bookkeeper approval gate cleanly into a fresh schema. The two table sets coexist during the parallel run; once a vendor flips to Tangerine-source-of-truth, future receipts for that vendor write to `tanda_po_receipts` only.

```sql
CREATE TABLE IF NOT EXISTS tanda_po_receipts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  tanda_po_id              uuid NOT NULL REFERENCES tanda_pos(id) ON DELETE RESTRICT,
  receipt_date             date NOT NULL,
  received_by_employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','pending_approval','approved','posted')),
  landed_cost_cents        bigint NOT NULL DEFAULT 0,    -- sum of rollups (D19)
  notes                    text,
  je_id                    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tanda_po_receipt_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id               uuid NOT NULL REFERENCES tanda_po_receipts(id) ON DELETE CASCADE,
  po_line_item_id          uuid NOT NULL REFERENCES po_line_items(id) ON DELETE RESTRICT,
  qty_received             int NOT NULL CHECK (qty_received > 0),
  qty_accepted             int NOT NULL CHECK (qty_accepted >= 0),
  qty_rejected             int NOT NULL DEFAULT 0,
  unit_cost_cents          bigint NOT NULL CHECK (unit_cost_cents >= 0),  -- pre-rollup PO cost
  landed_unit_cost_cents   bigint,                                       -- computed post-rollup
  inventory_location_id    uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  inventory_layer_id       uuid REFERENCES inventory_layers(id) ON DELETE SET NULL,
  raw_payload              jsonb,
  UNIQUE (receipt_id, po_line_item_id)
);

-- D19 — landed-cost rollups + auto-AP-invoice generation
CREATE TABLE IF NOT EXISTS tanda_po_receipt_rollups (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                                 REFERENCES entities(id) ON DELETE RESTRICT,
  receipt_id                  uuid NOT NULL REFERENCES tanda_po_receipts(id) ON DELETE CASCADE,
  expense_gl_account_id       uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  amount_cents                bigint NOT NULL CHECK (amount_cents > 0),
  vendor_id                   uuid REFERENCES vendors(id) ON DELETE SET NULL,   -- often != PO vendor
  description                 text NOT NULL,
  capitalized_to_inventory    boolean NOT NULL DEFAULT true,                    -- if false, posts to expense
  auto_invoice_id             uuid REFERENCES invoices(id) ON DELETE SET NULL,  -- the generated AP bill
  created_at                  timestamptz NOT NULL DEFAULT now()
);
```

### 3.12 `invoices` extensions (D19 — auto-AP from receipt rollup + bookkeeper gate)

```sql
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_receipt_rollup boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rollup_parent_receipt_id uuid
  REFERENCES tanda_po_receipts(id) ON DELETE SET NULL;

-- Extend invoices.status CHECK to add 'pending_bookkeeper_approval' for D19 auto-created rollup invoices
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('submitted','under_review','approved','paid','rejected','disputed',
                    'pending_bookkeeper_approval'));
```

### 3.13 QC tables (M26) — `tanda_po_qc_inspections` + `tanda_po_qc_findings`

Lighter-weight QC shape than §3.5 (which mirrors the Xoro-era `qc_inspections` for legacy receipts). New Tangerine-native receipts use these and skip the legacy table.

```sql
CREATE TABLE IF NOT EXISTS tanda_po_qc_inspections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  receipt_id               uuid NOT NULL REFERENCES tanda_po_receipts(id) ON DELETE CASCADE,
  inspection_date          date NOT NULL,
  inspector_employee_id    uuid REFERENCES employees(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','passed','failed','partial')),
  overall_pass_rate        numeric(5,4),
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tanda_po_qc_findings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id            uuid NOT NULL REFERENCES tanda_po_qc_inspections(id) ON DELETE CASCADE,
  category                 text NOT NULL,
  severity                 text NOT NULL CHECK (severity IN ('minor','major','critical')),
  qty_affected             int NOT NULL DEFAULT 0,
  description              text NOT NULL,
  photo_urls               text[],
  resolution               text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
```

### 3.14 Trade compliance (M48) — `vendor_compliance_certifications` + `import_documentation`

```sql
CREATE TABLE IF NOT EXISTS vendor_compliance_certifications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  certification_type       text NOT NULL,                          -- 'OEKO-TEX' | 'GOTS' | 'BSCI' | 'WRAP' | 'ISO9001' | 'custom'
  cert_number              text,
  issued_at                date,
  expires_at               date,
  document_url             text,
  status                   text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','expired','revoked','pending')),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_documentation (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  tanda_po_id              uuid NOT NULL REFERENCES tanda_pos(id) ON DELETE CASCADE,
  document_type            text NOT NULL,                          -- 'commercial_invoice' | 'packing_list' | 'bill_of_lading' | 'certificate_of_origin' | 'customs_declaration'
  document_url             text,
  hs_code                  text,
  country_of_origin        text,
  declared_value_cents     bigint,
  duty_rate_pct            numeric(8,4),
  status                   text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','received','verified','filed')),
  created_at               timestamptz NOT NULL DEFAULT now()
);
```

### 3.15 `tanda_pos` D18 pilot-vendor + procurement status extensions

Reuse-not-new per D1: P13-1 adds five further columns to `tanda_pos` for procurement-phase tracking + the D18 pilot marker.

```sql
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS originated_by_employee_id uuid
  REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS procurement_status text;        -- new procurement lifecycle states (orthogonal to legacy status)
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS expected_landed_cost_cents bigint;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS actual_landed_cost_cents bigint;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS pilot_vendor_flag boolean NOT NULL DEFAULT false;  -- D18 marker
```

---

## 4. API surface

All under `api/_handlers/internal/procurement/*` and dispatched via the standard `req.query.id` route per [[feedback-dispatcher-query-not-params]]. Public surface examples:

- `POST /api/procurement/pos` — create draft PO (header + lines)
- `PATCH /api/procurement/pos/:id/lines` — bulk-edit PO lines via matrix grid
- `POST /api/procurement/pos/:id/submit` — move `status: draft → submitted`, persist `po_commitments`, send via vendor portal / email PDF
- `POST /api/procurement/pos/:id/acknowledge` — vendor acks (called from Vendor Portal or operator-on-behalf)
- `POST /api/procurement/pos/:id/cancel` — cancel (closes commitments, reverses any draft state)
- `POST /api/procurement/receipts` — open a receiving session against a PO
- `POST /api/procurement/receipts/:id/scan` — scanner posts a line via the M39 REST contract (already shipped)
- `POST /api/procurement/receipts/:id/close` — close session, trigger QC routing or direct putaway
- `POST /api/procurement/qc-inspections` — record inspection result
- `POST /api/procurement/qc-inspections/:id/disposition` — choose `vendor_rma` / `vendor_credit_only` / `write_off` / `rework_inhouse`
- `POST /api/procurement/customs-entries` — create entry (typically broker-driven, but operator-typeable)
- `POST /api/procurement/broker-invoices` — record broker invoice + trigger landed-cost allocation JE
- `POST /api/procurement/vendor-invoice-drafts` — ingest vendor invoice (OCR or manual)
- `POST /api/procurement/vendor-invoice-drafts/:id/match` — run three-way match against staged PO + receipts
- `POST /api/procurement/vendor-invoice-drafts/:id/approve` — convert matched draft → `invoices` AP bill (calls into existing P3 AP posting service)
- `GET /api/procurement/open-commitments` — open-PO-by-vendor report
- `GET /api/procurement/three-way-match-queue` — variance + exception inbox
- `GET /api/procurement/qc-queue` — QC fail + disposition pending
- `GET /api/procurement/landed-cost-report` — receipts pending landed-cost finalization

OCR ingest worker: `POST /api/procurement/_cron/ocr-vendor-invoices` (15-min cron) — walks the AP inbox storage bucket and Vendor Portal upload queue, fires OCR jobs via the existing PDF→JSON helper used elsewhere in M29.

---

## 5. UI panels

All new panels under `src/procurement/` extending the existing Tanda app surface where possible.

- **PO Drafts panel** — extends existing PO WIP UI; new "Create PO" wizard with matrix grid line entry (D13). Lives at `src/procurement/PoDraftPanel.tsx`.
- **PO Open Commitments** — open-PO-by-vendor view; expected-in-DC date column drives the date-range preset T7 filter. `src/procurement/OpenCommitmentsPanel.tsx`.
- **Receiving Session panel** — opens against a selected PO, presents matrix grid of expected qty, accepts scanner posts via M39 REST. `src/procurement/ReceivingSessionPanel.tsx`.
- **QC Inspections queue** — open inspections + dispositioning UI. `src/procurement/QcInspectionsPanel.tsx`.
- **Customs Entries panel** — operator-typed customs entries OR broker-portal-ingested. `src/procurement/CustomsEntriesPanel.tsx`.
- **Broker Invoices + Landed Cost** — broker invoice ingestion + landed-cost allocation preview before posting. `src/procurement/BrokerInvoicesPanel.tsx`.
- **Three-Way Match Inbox** — variance queue; operator approves or rejects each draft. `src/procurement/ThreeWayMatchPanel.tsx`.
- **Procurement Reconciliation Inbox** — cross-cutter surface that aggregates: open commitments past expected date, receipts without customs, customs without broker invoice, QC fails without disposition, three-way variance unresolved. `src/procurement/ReconciliationInboxPanel.tsx`.

Universal table export (`<ExportButton>`) ships on every list view per [[feedback-universal-table-export]]. xlsx-only per [[feedback-xlsx-only-no-csv]].

---

## 6. JE patterns

### 6.1 PO commitment (D3 — off-BS)

POs that move to `status='submitted'` create `po_commitments` rows. **No GL post.** The commitment shows up in the open-commitments management report only.

### 6.2 Receipt — initial layer at PO unit cost (D9 lazy capitalization)

```
Receipt R-1234 (Vendor V, PO RP-2026-00050, 600 units @ $4.50 each, expected duty 7.5%):

DR 1320 Inventory On QC Hold              270000    -- 600 × $4.50, awaiting QC
CR 2100 AP Control                        270000    -- placeholder AP; resolved by three-way match
   OR
CR 2150 Accrued Customs / Duty             20250    -- estimated duty placeholder if PO had duty estimate
```

If QC is gated, balance stays in 1320 until release.

### 6.3 QC release → putaway → final FIFO layer

```
QC pass on R-1234 (600/600 units pass):

DR 1300 Inventory Asset                   270000
CR 1320 Inventory On QC Hold              270000
-- FIFO layer created in inventory_layers at unit_cost_cents = 4500 / unit, location = WH-MAIN
```

### 6.4 QC fail — write-off disposition

```
QC fail on R-5678 (50 units fail, write_off disposition):

DR 6420 Inventory Write-off                22500    -- 50 × $4.50
CR 1320 Inventory On QC Hold               22500
-- failed units do not become inventory_layers; receipt_line_items.quantity_rejected = 50
```

### 6.5 QC fail — vendor credit disposition

```
QC fail on R-5678 (50 units fail, vendor_credit_only @ 50% credit):

DR 1300 Inventory Asset                    11250    -- 50 × $2.25 (depreciated)
DR 2100 AP Control                         11250    -- vendor credit memo against open AP
CR 1320 Inventory On QC Hold               22500
-- 50 units become a separate FIFO layer at $2.25 unit cost, marked source_kind='qc_credit_layer'
```

### 6.6 Customs entry posting — accrual to actuals

When the broker delivers Form 7501:

```
Customs entry CE-789 for receipt R-1234 ($18,200 actual duty + $580 MPF + $410 HMF + $0 Section 301):

DR 5110 Customs Duty                       18200    -- temporary; flows into 1300 via allocation
DR 5110 Customs Duty                          580
DR 5110 Customs Duty                          410
CR 2150 Accrued Customs / Duty            19190    -- accrual booked at receipt is settled here
-- gap to placeholder accrual surfaces as variance row in Reconciliation Inbox
```

### 6.7 Broker invoice + landed-cost allocation JE (D8 capitalization)

When the broker invoice arrives:

```
Broker BR-456 invoice ($19,190 duty pass-through + $1,250 freight + $475 brokerage):

DR 5110 Customs Duty                       19190
DR 5100 Inbound Freight                     1250
DR 5120 Brokerage + Clearance                475
CR 2100 AP Control (broker)                20915

Then allocation JE (allocates 5100/5110/5120 into receipt R-1234's remaining FIFO layers):

DR 1300 Inventory Asset (R-1234 layer)     20915
CR 5100 Inbound Freight                     1250
CR 5110 Customs Duty                       19190
CR 5120 Brokerage + Clearance                475
-- inventory_layers.unit_cost_cents updated for remaining_qty of layer
-- already-consumed qty NOT updated (D9 — small permanent margin variance accepted)
```

### 6.8 Three-way match approved → AP bill

```
Vendor invoice draft VID-100 matched to PO RP-2026-00050 + R-1234 ($27,000 invoice, $0 variance):

(standard P3 AP posting service called — produces:)
DR 2100 AP Control (placeholder release from receipt JE)   27000
CR 2100 AP Control (vendor V — actual AP balance)          27000
-- the receipt-side placeholder AP is offset by the real AP bill; net effect: AP Control by vendor = 27000
```

If variance > tolerance, post the variance to `6320 PO Variance Expense` and surface the line in the inbox.

### 6.9 D19 — Receipt-time landed-cost rollup with auto-AP-invoice + bookkeeper gate

The receiving user closes receipt `TPR-1234` (PO `RP-2026-00050`, 600 units @ $4.50 = $270,000 pre-rollup) and adds three rollup lines on the receiving panel:

| Rollup | Expense GL | Amount | Vendor | Capitalize? |
|---|---|---|---|---|
| Inbound freight | 5100 Inbound Freight | $1,250 | Forward Air (freight forwarder, NOT the PO vendor) | YES |
| Brokerage fee | 5120 Brokerage + Clearance | $475 | Expeditors (broker) | YES |
| Inspection charge | 5160 Inspection / Third-party QC | $400 | SGS (inspection vendor) | NO (operator expensing this one) |

For each rollup row, the system auto-creates an AP `invoices` row:

```
invoices INSERT — auto-AP for the Forward Air freight rollup:
  id                       = <new uuid>
  vendor_id                = <Forward Air vendor_id>
  invoice_number           = 'AUTO-TPR-1234-1'
  invoice_kind             = 'vendor_bill'
  status                   = 'pending_bookkeeper_approval'   -- D19 GATE
  gl_status                = 'unposted'
  is_receipt_rollup        = true
  rollup_parent_receipt_id = TPR-1234
  total_amount_cents       = 125000
  source                   = 'manual'                        -- (T10 source; ops-typed-equivalent)
```

Auto-AP for the Expeditors brokerage rollup + SGS inspection rollup repeats with their own invoice rows.

`tanda_po_receipts.landed_cost_cents` is set to `$1,250 + $475 = $1,725` (only capitalize=true rollups roll into landed_cost; the SGS inspection charge of $400 stays as a flat expense and does NOT inflate inventory cost).

`tanda_po_receipt_lines.landed_unit_cost_cents` for each line is recomputed:

```
landed_unit_cost_cents = unit_cost_cents
                       + (capitalized_rollups_total_cents × line_extended_value / receipt_extended_value)
```

Per D7 (value-weighted allocation default), for a uniform $4.50 receipt:

```
$1,725 capitalized / 600 units = $2.875 per unit
landed_unit_cost_cents = 450 + 287.5 ≈ 738 (rounded to integer cents per line)
```

At this stage the JE has NOT yet posted — `tanda_po_receipts.status='pending_approval'`, each auto-AP `invoices.status='pending_bookkeeper_approval'`. The bookkeeper opens the **Receipt Rollup Approval Queue** (a new panel) and reviews each auto-AP row.

Bookkeeper approves all three auto-AP rows. For each, status flips to `'approved'`, the standard P3 AP posting service runs, and the rollup's capitalized portion posts as:

```
For the Forward Air freight rollup ($1,250, capitalized=true):
DR 1300 Inventory Asset (allocated across TPR-1234 layers)        125000
CR 2100 AP Control (Forward Air vendor)                           125000

For the Expeditors brokerage rollup ($475, capitalized=true):
DR 1300 Inventory Asset (allocated across TPR-1234 layers)         47500
CR 2100 AP Control (Expeditors vendor)                             47500

For the SGS inspection rollup ($400, capitalized=false):
DR 5160 Inspection / Third-party QC                                40000
CR 2100 AP Control (SGS vendor)                                    40000
```

And the receipt itself, once all rollups are approved AND QC passes, posts the inventory layer:

```
DR 1300 Inventory Asset                                          271725    -- 600 × $4.50 + $1,725 capitalized rollups
CR 2100 AP Control (PO vendor — Zhejiang Zhuji Newdan)           270000    -- PO unit cost portion
CR <rollup capitalized portion already DR'd above; net zero ON 1300>
-- inventory_layers row created with unit_cost_cents=453 (rounded from 4528.75¢/unit at 600 units)
-- source_kind='po_receipt' on the layer
```

This replaces D9's "FIFO layer posts at PO cost, lazy revaluation 10-30 days later" with **correct landed cost from day one** for vendors whose freight/broker/inspection invoices arrive at or near receipt. D9's lazy-revaluation path stays available as a fallback when broker docs trail receipt by weeks.

**Key control point:** auto-created AP invoices land in `status='pending_bookkeeper_approval'` with `gl_status='unposted'`. The warehouse user who closed the receipt can't accidentally post unverified vendor invoices into the GL — a bookkeeper must review each one before it hits the books.

---

## 7. Implementation chunks

10 chunks, ordered for parallelizable waves where the dependency graph allows.

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **P13-1** | Procurement schema migration (this chunk) — Tangerine-native `tanda_po_receipts` + `tanda_po_receipt_lines` + `tanda_po_receipt_rollups` (D19) + `tanda_po_qc_inspections` + `tanda_po_qc_findings` + `vendor_compliance_certifications` + `import_documentation` + `tanda_pos` extensions (5 cols incl. D18 `pilot_vendor_flag`) + `invoices` extensions (`is_receipt_rollup`, `rollup_parent_receipt_id`, `status` CHECK extended with `pending_bookkeeper_approval`) + RLS template (anon_all + auth_internal) + NOTIFY pgrst. One migration, atomic, idempotent. | — |
| **P13-2** | Legacy-side schema (deferred): the existing-`receipts`/`receipt_line_items` ALTERs (3.4), `po_commitments` (3.3), `vendor_invoice_drafts` (3.6), `customs_entries` (3.7), `broker_invoices` (3.8), legacy `qc_inspections` (3.5), `vendors` + `ip_item_master` (3.9), GL seeds (3.10). Lives in a second migration to keep P13-1 reviewable. | P13-1 |
| **P13-3** | PO origination + receiving session UI — extend PO WIP / Tanda UI with Create-PO wizard + matrix-grid line entry + submit-to-vendor + receiving session against PO + **receipt rollup entry panel (D19)** + auto-AP-invoice generation on rollup save | P13-1, P13-2 |
| **P13-4** | Bookkeeper approval queue — new panel listing `invoices` WHERE `status='pending_bookkeeper_approval'`. Bookkeeper-role gating per T4. Approve/reject flips status + triggers P3 AP posting service for approved rows. | P13-3 |
| **P13-5** | QC inspections — inspection queue + pass/fail/conditional + 4-disposition handling (vendor_rma, vendor_credit_only, write_off, rework_inhouse) + photo-attachment via M29 (writes to new `tanda_po_qc_inspections` + `tanda_po_qc_findings`) | P13-3 |
| **P13-6** | Customs entries — operator-typed entry + per-line HTS + duty rate + 7501 PDF link + accrual settlement JE | P13-3 |
| **P13-7** | Broker invoices + landed-cost allocation — broker-as-vendor AP path + allocation method (value/weight/cbm) + revaluation JE on remaining FIFO layers (fallback path for vendors whose freight/broker invoices don't arrive at receipt time per D19) | P13-6 |
| **P13-8** | Vendor invoice three-way match — OCR ingest from Vendor Portal + AP inbox + match-to-PO+receipt + variance queue + approve-to-AP path | P13-3 |
| **P13-9** | Procurement Reconciliation Inbox + Open Commitments report + period-close pre-flight extensions (D16) + M28 notification rules for stale entries (incl. auto-AP rollup invoices stuck in `pending_bookkeeper_approval` > 7 days) | P13-1..8 |
| **P13-10** | User guide chapter 25 Procurement (sub-chapters PO / Receiving / QC / Trade Compliance / Rollup + Bookkeeper Approval) + memory close-out + cutover-per-vendor checklist | P13-1..9 |

**Parallel waves:**

- **Wave A:** P13-1 (gate, Tangerine-native atomic schema incl. D19 rollup tables)
- **Wave A':** P13-2 (legacy-side schema deltas) — can run in parallel with P13-3 since the two schemas are disjoint
- **Wave B:** P13-3 (PO origination + receiving + rollup entry UI) + P13-4 (bookkeeper approval queue) — receiving panel and approval queue are independent given the schema
- **Wave C:** P13-5 + P13-6 + P13-8 simultaneously (QC + customs + 3-way match all branch off Wave B)
- **Wave D:** P13-7 (depends on P13-6 customs)
- **Wave E:** P13-9 (depends on all of B-D)
- **Wave F:** P13-10 (docs close-out)

**Total: 10 chunks.** ~8-10 weeks waved in parallel with multiple agents (matches P12's 6-8 week shape for a smaller scope). Sequential would be ~14-16 weeks.

---

## 8. Operator surface

**Nav additions** (under existing Tanda app, new "Procurement" hub):

- Procurement / PO Drafts
- Procurement / Open Commitments
- Procurement / Receiving Sessions
- Procurement / QC Inspections
- Procurement / Customs Entries
- Procurement / Broker Invoices + Landed Cost
- Procurement / Three-Way Match Inbox
- Procurement / Reconciliation Inbox

**Status surface:**

- Pinned widget on the Tangerine landing card: open commitments $, receipts past expected date, QC queue size, three-way variance count.
- M28 notification rules per D16 + D17 — operator gets a notification when (a) a receipt is > 30d without customs, (b) a customs entry > 60d without broker invoice, (c) a QC fail sits without disposition for > 5 business days, (d) three-way variance > $1000 lands.

**Ops controls:**

- Per-vendor `parallel_run_started_at` + `parallel_run_complete` toggle on the Vendor Master panel — operator flips when ready.
- Per-vendor `qc_required` and trusted-vendor escape (D5) on the Vendor Master panel.
- Manual-entry fallback on every panel:
  - Type a PO without sending → status stays draft, no commitment posted until submit
  - Open a receiving session against a manually-entered PO → no GS1 scanner required
  - Skip QC by toggling `receipts.qc_required = false` on a per-receipt basis (if vendor allows)
  - Type a customs entry directly without a broker portal feed
  - Type a broker invoice manually
  - Reject the three-way-match auto-draft and type the AP bill directly

---

## 9. Source-tagging notes

Per [[feedback-source-tagging-enforcement]]:

- `tanda_pos.source` — `'tangerine'` for Tangerine-created, `'xoro_mirror'` for nightly mirror during parallel run, `'edi_850_ack'` reserved for P22, `'manual'` for ops-typed-in-the-rare-case
- `receipts.source` — `'tangerine'` (UI), `'scanner'` (M39 REST), `'xoro_mirror'`, `'edi_945_recv'` reserved, `'manual'`
- `vendor_invoice_drafts.source_kind` — `'vendor_portal_upload'`, `'ap_inbox_pdf'`, `'manual'`, `'edi_810'` reserved
- `customs_entries` — no explicit source enum because all entries are operator/broker-typed in v1; raw_payload preserves origin metadata
- `inventory_layers.source_kind` extends with `'po_receipt'` (Tangerine), `'qc_credit_layer'` (vendor_credit_only disposition), `'rework_layer'` (rework_inhouse exit) — existing `source_kind` CHECK constraint will be widened in P13-0

T10 mirror is configured to **skip rows where source='tangerine'** on every P13 table. Cutover is per-vendor (D15) — once `vendors.parallel_run_complete=true`, T10 also skips the mirror for that vendor's POs regardless of which side wrote them.

UI badges per the standing rule: every panel that lists PO / receipt / customs / broker rows shows a source pill (`Tangerine` / `Xoro mirror` / `Manual` / `EDI`).

---

## 10. Risks + mitigations

- **`tanda_pos` is the most touched table in the codebase.** Existing PO WIP code reads + writes it heavily; the column-add migration is straightforward, but downstream readers may not expect `source!='xoro'` rows. Mitigation: P13-0 only ADDs columns (no NOT NULL constraints on new fields where existing code reads); P13-1 adds source filter on PO WIP UI queries; backfill script populates `source='xoro_mirror'` on every existing row first.
- **Three-way match variance noise during parallel run.** Vendor invoices today come through Xoro's AP flow; during parallel run they come through both. Risk: double-counting. Mitigation: source-tag enforcement (P13 vendor invoices are `source_kind='vendor_portal_upload'` or `'ap_inbox_pdf'`; Xoro-side invoices are mirrored with `source='xoro_mirror'` and the three-way-match queue ignores those).
- **OCR accuracy on apparel vendor invoices.** Asia-based vendors send PDFs with varying templates + occasional handwriting. Mitigation: confidence_pct on the OCR output + operator review queue gate before three-way match runs. Below 80% confidence → goes straight to manual-review queue.
- **Broker invoice timing — landed cost revaluation arrives weeks after receipt.** D9's lazy revaluation accepts the margin slop; if the gap is consistently > 5% on remaining inventory, operator may want to switch to accrual-tighter. Mitigation: report shows accrual-vs-actual gap by vendor + by month; if operator wants to tighten, switch to estimating duty at receipt using vendor's HTS-default-rate.
- **HTS code accuracy** — wrong classification = wrong duty = customs audit risk. Mitigation: HTS comes from `ip_item_master.hts_code` (vetted once + reused), per-PO override allowed but flagged; quarterly HTS audit report compares actual duties to expected via HTS lookup.
- **Multi-PO consolidation timing edge** — vendor combines 3 POs in a single container; receipt arrives before vendor's combined invoice. Three-way match must handle 1-receipt-N-POs and 1-invoice-N-receipts. Mitigation: `vendor_invoice_drafts.matched_po_ids[]` + `matched_receipt_ids[]` are array-typed, the match engine walks N:M.
- **PO numbering races at fiscal year rollover.** `po_number_sequences` row per (entity, year) prevents within-year races; new-year first PO has a race between concurrent operators. Mitigation: row-level lock on `po_number_sequences` SELECT FOR UPDATE during number generation.
- **Inventory location migration carryover.** P12-0 added `inventory_layers.location_id` and required NOT NULL after backfill. P13 layers always include location — but the QC-hold layer (in `1320`) is a fictitious location; mitigation: seed `inventory_locations` with a virtual `'QC-HOLD'` location per entity, kind='virtual'.
- **Section 301 tariff changes** — U.S.-China tariff schedule changes frequently. Mitigation: `customs_entries.raw_payload` preserves the broker's reported rate; we don't re-derive Section 301 from internal tables. Trust the broker's number.
- **Vendor Portal load** — the portal already handles PO viewing + acknowledgment; adding PDF upload for vendor invoices adds storage + OCR queue load. Mitigation: existing portal storage bucket gets a new `vendor-invoices/` prefix; OCR cron rate-limits to 20/run.

---

## 11. References

- [P11 Shopify Architecture](P11-shopify-architecture.md) — first direct integration template
- [P12 Marketplaces Architecture](P12-marketplaces-architecture.md) — per-channel cutover model; D15 here adopts per-vendor cutover variant; landed-cost capitalization (D8) parallels P12 D8 facilitator-tax memo handling
- [P3 Acc Core Architecture](P3-acc-core-architecture.md) — AP posting service that three-way-match feeds into; FIFO layer creation primitives
- [P5 Close Core Financials Architecture](P5-close-core-financials-architecture.md) — period close pre-flight extended per D16
- [T10 Shadow Mirror Architecture](T10-shadow-mirror-architecture.md) — source tagging + per-row cutover model adopted at vendor grain
- [P9 Parallel-Run Architecture](P9-parallel-run-architecture.md) — variance framework that D15's $5/2% threshold plugs into
- [XORO Decom Map](XORO-DECOM-MAP.md) — flags M11 + M26 + M38 + M48 as the P13 procurement scope; this doc satisfies all four
- [CURRENT-SCHEMA](CURRENT-SCHEMA.md) — `tanda_pos`, `po_line_items`, `receipts`, `receipt_line_items`, `inventory_layers`, `inventory_locations`, `vendors`, `ip_item_master`, `invoices` shapes being extended

---

## 12. ETA

**Sub-phase / wave-parallel:** 8-10 weeks build (Wave A = 1 day schema, Wave B = 2-3 weeks PO + receiving in parallel, Wave C = 3-4 weeks four parallel threads, Wave D = 1 week landed cost, Wave E = 1 week reconciliation inbox, Wave F = 3-4 days docs).

**Sequential:** 14-16 weeks.

**Plus 8 weeks parallel run per pilot vendor** before that vendor's Xoro PO connector is shut. After the pilot vendor cuts over cleanly, second/third vendors cut over on 4-6 week parallel run (faster because the pattern is proven).

**Overall calendar (recommendation):** kick off ~2026-08 (after P12 closes out and operator's bandwidth opens) → all chunks shipped + parallel-running by ~2026-10 → first vendor cutover ~2026-12 → most vendors cut over ~2027-Q1.

This is the next major chunk of Xoro decom after the revenue side (P11 + P12) — and unlocks the matrix-aware PO + receiving workflow the operator has been waiting on since P1.

---

## 13. Operator confirm before chunks ship

**Status update (2026-05-29):** Operator has confirmed **D14 = 80% OCR confidence**, **D18 = Zhejiang Zhuji Newdan Garment Co., Ltd. pilot vendor**, **D9 strict landed cost capture at receipt** plus new **D19 receipt-time rollup workflow + auto-AP-invoice + bookkeeper approval gate**. D19 is part of **P13-1 (this chunk)** — the schema lands first, the UI wires in P13-3 + P13-4. Remaining D1-D8, D10-D17 await confirmation (low-risk reasonable defaults assumed for the migration).

**Vercel env vars to add before P13-0 ships:** none required — this phase is entirely internal-to-Tangerine. (OCR helpers reuse the existing PDF→JSON service from M29.)

**Operator-side actions:**

- Pick the **pilot vendor** for the first parallel-run cycle (D18). Recommended: a vendor with monthly cadence and reliable email + portal participation.
- Decide on **HTS code source** for existing SKUs (D10): operator-typed bulk import, or a one-shot Xoro export.
- Confirm **landed-cost allocation default** (D7) — value-weighted is the recommendation; weight or CBM override per vendor if needed.
- Confirm the operator's **freight forwarder / customs broker** is willing to provide 7501 PDFs in a parseable form (most brokers do via their portal export).

**Realistic timeline after operator confirms §2:** 8-10 weeks of build (waved parallel) + 8 weeks parallel run with pilot vendor + 4-6 weeks per subsequent vendor cutover. Full Xoro PO decom achieved ~2027-Q1 with rolling vendor cutovers. Aligns with the XORO Decom Map's "P13 cuts purchasing side" milestone.

Three open operator questions to bring to the kickoff call:

1. **D6 pilot vendor selection** — which vendor has the right combination of cadence + invoicing reliability + portal participation for the 8-week pilot?
2. **D9 landed cost gap tolerance** — is the "remaining-layers-only revaluation" margin slop acceptable, or do you want a tighter accrual on receipt (estimate duty + freight at receipt, true-up later)?
3. **D14 OCR vs manual** — what's the realistic % of vendor invoices that arrive as machine-readable PDFs vs scans-of-scans? Determines whether the OCR confidence threshold should be 80% (lots of manual review) or 60% (less manual but more variance noise).
