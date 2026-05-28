# Xoro Decommissioning Map

Operator's single-source-of-truth answer to: *"can we drop this Xoro function yet?"*

For every function operator currently uses Xoro for, this doc says:
- The Tangerine module that replaces it
- The phase it lands in
- Current readiness state
- What blocks decom

Updated whenever a phase ships.

---

## Readiness legend

- ✅ **Ready** — Tangerine module live in prod, no Xoro dependency
- 🟡 **Partial** — module exists but downstream (e.g. AR ↔ inventory) still needs Xoro data
- 🔴 **Not built** — Xoro is the only source; phase scheduled but not started

---

## Financial / accounting side

| Xoro function | Tangerine module | Phase | State | What blocks decom |
|---|---|---|---|---|
| Chart of accounts | COA panel (P3 Chunk 8a) | P3 | ✅ ready | nothing — bulk-import from Xoro is a one-shot SQL bundle (see §A) |
| GL periods (open / soft_close / closed) | Periods panel (P3 Chunk 8b + P5-1) | P3+P5 | ✅ ready | — |
| Journal entries (manual posts + reversals) | JE panel (P3 Chunk 8c) | P3 | ✅ ready | — |
| Trial balance | TB panel + RPC (P5-2) | P5 | ✅ ready | — |
| Income statement | IS panel + RPC (P5-3) | P5 | ✅ ready | — |
| Balance sheet | BS panel + as-of RPC (P5-4) | P5 | ✅ ready | — |
| Cash flow statement (indirect) | CF panel + RPC (P5-5) | P5 | ✅ ready | — |
| Year-end close | YE Close panel + RPC (P5-6) | P5 | ✅ ready | — |
| AP bill entry | AP Invoices panel (P3) | P3 | ✅ ready | — |
| AP payments + payment ledger | AP Payments panel (P3) | P3 | ✅ ready | — |
| AP aging | AP Aging report (P7-7) | P7 | ✅ ready | — |
| AR invoice creation | AR Invoices panel (P4-4) | P4 | ✅ ready | — |
| AR receipts (cash + check + wire + ACH + card) | AR Receipts (P4-5) | P4 | ✅ ready | — |
| AR aging | AR Aging panel + daily overdue cron (P4-6) | P4 | ✅ ready | — |
| Bank reconciliation | Bank Recon panel + Plaid + match engine (P6) | P6 | ✅ ready | Plaid env vars set + bank linked |
| Sales commissions | Sales Reps + Accruals + Payouts (P7) | P7 | ✅ ready | — |
| Customer service / cases | Cases panel + Resend inbound (P7-9) | P7 | ✅ ready | optional Resend `cases@` routing |

---

## Operational side

| Xoro function | Tangerine module | Phase | State | What blocks decom |
|---|---|---|---|---|
| PO origination (creating purchase orders, vendor + lines + dates + send) | M11 Procurement | **P13** | 🔴 not built | full P13 build |
| PO receiving workflow (line + carton + GS1 + putaway) | M38 Receiving Workflow | **P13** | 🔴 not built | full P13 build |
| Quality control / inspections | M26 QC | **P13** | 🔴 not built | full P13 build |
| Sales order entry | M10 SO | **P16** | 🔴 not built | full P16 build (needs M43 Pricing P15 first) |
| Sales order entry — **matrix grid UI** (Style × Color × Size) | M10 SO | **P16** | 🟡 primitive shipped in P1 | needs SO module + matrix view integration |
| Pricing engine (per-customer / channel / tier) | M43 Pricing | **P15** | 🔴 not built | full P15 build |
| Carrier integration / shipping labels | M44 Carrier | **P16** | 🔴 not built | full P16 build |
| Inventory operations (real-time receive / transfer / adjustment / cycle count) | M37 Inventory Ops | **P21** | 🟡 schema-only in P3 | full P21 build |
| Inventory snapshot / on-hand reporting | M37 + ATS | partial | 🟡 ATS uses Xoro nightly fetch | needs P21 inventory ops |
| Mobile scanner (scan-to-receive / ship / count / transfer) | M39 Mobile Scanner | P3 | 🟡 REST contract shipped P3; native apps not built | mobile apps deferred |
| FIFO cost layers (real consumption on sale) | M5 FIFO | P3 | 🟡 schema shipped P3-3, opening seed populated 2126 layers | needs sales-driven consumption to flow (waits for SO + receiving) |
| COGS auto-calculation on sale | P4 receipt-post path uses FIFO layer consumption | P4 (consumes), P3-3 (schema) | 🟡 path exists | **layers not refreshed from real receiving — see §C** |
| Item master / SKU catalog | M34 Style Master + ip_item_master | P1 | ✅ ready (read-only refresh from Xoro nightly) | — until P13 (then operator originates SKUs in Tangerine) |
| Vendor master | M35 Vendor Master | P1 | ✅ ready | — |
| Customer master | M36 Customer Master | P1 | ✅ ready | — |
| Product information / images / descriptions | M42 PIM | P8 | ✅ ready | — |

---

## Sales channels

| Xoro function | Tangerine module | Phase | State |
|---|---|---|---|
| Shopify ecom feed | M12 Shopify | **P11** | 🔴 not built |
| Faire / Amazon / Walmart marketplaces | M45 Marketplaces | **P12** | 🔴 not built |
| 3PL integration | M13 3PL | **P21** | 🔴 not built |
| EDI (810 / 850 / 856 / 940) | M14 EDI | **P22** | 🔴 not built |

---

## Reporting + BI

| Xoro function | Tangerine module | Phase | State |
|---|---|---|---|
| AR / AP aging | (P4-6, P7-7) | ✅ ready | shipped |
| Trial balance / IS / BS / CF | (P5) | ✅ ready | shipped |
| Sales by rep / customer / category | (P7-7 subset + ATS for category cuts) | ✅ ready for rep/customer | category cuts live in ATS via Xoro nightly |
| GL detail by account | (P7-7) | ✅ ready | shipped |
| Custom BI dashboards | M46 BI | **P24** | 🔴 not built |
| Aged inventory | ATS (Xoro-fed) | — | 🟡 lives in ATS, Xoro-sourced |

---

## Realistic decom sequence

```
Today
  ↓
P9 Parallel-run (2-3 mo) — validate financial side
  ↓
PARTIAL DECOM #1: AR + AP + GL + Cash + Bank Rec to Tangerine-truth
  Xoro stays for: PO / receiving / SO / inventory ops / pricing / shipping / EDI / ecom
  Pay reduced Xoro tier if available
  ↓
P10 Tenancy (RLS flip)
  ↓
P11 + P12 Ecom (Shopify + marketplaces) ← decom Xoro's web side
  ↓
P13 Procurement (PO + receiving + QC) ← decom Xoro's purchasing side
  ↓
P14 PLM ext + P15 Pricing
  ↓
P16 Sales (SO entry + matrix UI + carrier) ← decom Xoro's order entry
  ↓
P17 Planning + P18 B2B + P19 Returns + P20 Drop-ship
  ↓
P21 3PL (full inventory ops) ← decom Xoro's warehouse side
  ↓
P22 EDI ← decom Xoro's EDI side
  ↓
P23 FULL XORO DECOM (~24-30 months from today)
  ↓
P24 Reporting (full BI) + P25 Finance (Fixed Assets / Budgets / 1099 / Sales Tax / API)
```

---

## §A. Bulk-importing your Xoro chart of accounts

Today the Tangerine COA is seeded with the accounts each P-phase needs (1100 Bank, 1200 AR Control, 1300 Inventory, 2100 AP Control, 2300 Commissions Payable, 4000 Revenue, 5000 COGS, 6210 Sales Commissions Expense, 6310 Bank Service Charge, 6510 Merchant Fees, 6610 Chargeback Expense, plus a handful of others — ~12-15 accounts).

Your Xoro likely has 50-100+ accounts (operating expense detail, equity sub-accounts, tax accounts, etc.). To bring them all over:

**Operator action:** export Xoro COA to CSV. Columns we need:
- `code` (text, e.g. `4100`)
- `name` (text)
- `account_type` (one of: `asset` / `liability` / `equity` / `revenue` / `expense`)
- `normal_balance` (`DEBIT` or `CREDIT`) — auto-derivable from `account_type` if missing
- `is_postable` (boolean — roll-up parents are `false`)
- `parent_code` (optional, text — for hierarchy)

Drop the CSV at `~/iCloudDrive/Producton Orders/sql/xoro-coa-export.csv` and ping me. I'll generate a one-shot SQL bundle (`xoro-coa-bulk-import.sql`) that:
- Maps every row to a `gl_accounts` INSERT
- Idempotent: `ON CONFLICT (entity_id, code) DO UPDATE SET name = EXCLUDED.name, account_type = EXCLUDED.account_type, ...`
- Resolves parent_code → parent_account_id in a second pass
- Skips accounts that conflict with existing seeded accounts (the ~12-15 P1-P8 seeds)

You paste the bundle, your COA matches Xoro within 1 paste cycle.

---

## §B. Data flow when AR / AP move to Tangerine

**Today's flow:**

```
Xoro (source-of-truth)
   ↓ nightly CSV fetch (21:00 local)
Supabase tables (read-only):
  ip_sales_history_wholesale   ← AR transactions
  tanda_pos                    ← POs
  ip_inventory_snapshot        ← on-hand
  ip_item_master               ← SKU catalog
   ↓
Tangerine panels + ATS show this data
   ↓
Operator types accounting entries into Xoro
```

**After partial decom (AR / AP / GL / Cash flip to Tangerine-truth):**

```
Operator creates AR invoices in Tangerine UI (P4)
Operator creates AP bills in Tangerine UI (P3)
Bank Rec auto-syncs via Plaid (P6)
GL auto-derives via posting service
   ↓
Tangerine = source-of-truth for the financial side
   ↓
Xoro nightly fetch CONTINUES for operational data:
  PO origination still in Xoro
  SO entry still in Xoro
  Inventory ops still in Xoro
  EDI still in Xoro
   ↓
ip_sales_history_wholesale becomes read-only reference
ip_inventory_snapshot still feeds ATS
tanda_pos still drives PO WIP
   ↓
Bridge logic: where does a Xoro PO become a Tangerine AP invoice?
  → Manual: operator types the bill into Tangerine AP when the vendor invoice arrives
  → Or: small "convert tanda_pos receipt → AP bill draft" tool (§C)
```

**The hard part — COGS and inventory consumption:**

- When you post an AR invoice with an inventory line in Tangerine, the P4-2 receipt-post path tries to consume from `inventory_layers` (FIFO).
- `inventory_layers` was seeded in P3-3 from an opening-balance snapshot (2,126 layers) — but nothing has been refreshing it since real receivings still happen in Xoro.
- So: posting an AR invoice in Tangerine *today* would either (a) consume from the stale opening seed (wrong COGS), or (b) fail if the SKU doesn't have a matching layer.

**Three options for the COGS bridge:**

1. **Manual COGS journal** — operator gets monthly COGS number from Xoro and posts a single summary JE in Tangerine. Simplest; AR invoice lines mark `cogs_pending` and the monthly close JE settles them. Risk: COGS is monthly-grained, not per-invoice.
2. **Nightly refresh inventory_layers from Xoro** — small bridge script that walks `ip_inventory_snapshot` + `item_costing` and rebuilds `inventory_layers` each night. Tangerine FIFO works mostly-correctly; per-invoice COGS is right within ~24 hrs of accuracy.
3. **Defer AR invoice posting until P21** — only invoice non-inventory items in Tangerine (service lines, ad-hoc charges). Inventory-line invoices stay in Xoro until P21 ships. Most conservative; least friction.

My recommendation: **option 2** for partial decom (good enough COGS) + **option 3 as a fallback** (operator can still create non-inventory invoices in Tangerine immediately).

---

## §C. Optional bridge tools (build when partial decom approaches)

- **`tanda_pos` → AP bill draft** — when a Xoro PO is fully received, optionally create a Tangerine AP bill draft pre-populated from the PO data. Operator reviews + posts. ~1 day of work.
- **`ip_sales_history_wholesale` → AR invoice draft** — for legacy Xoro SOs that hit Tangerine *after* AR decom, similar pre-populate logic. ~1 day.
- **Nightly `inventory_layers` refresh** — see §B option 2. ~1-2 days.

None of these are in the roadmap as scheduled chunks — they're "bridge" tools that exist only because we're partially decomming. They get deleted in P21+ when the underlying Xoro feed is decom'd.

---

## Updating this doc

When a new phase ships, the matrix gets updated. The doc is intentionally not auto-generated — it's a human-reviewed map. Update timestamps:

- **2026-05-28** — created after P8 Data + CRM shipped + P9 arch drafted
