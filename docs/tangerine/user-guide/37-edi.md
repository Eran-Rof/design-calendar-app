# 37. EDI — Electronic Data Interchange (P22 / M14)

**Where:** Tangerine → **Master Data → 🔌 EDI** — a sub-menu with three items:
**Vendors** (`/tangerine?m=edi`), **Customers** (`/tangerine?m=edi_customers`),
**Settings** (`/tangerine?m=edi_settings`).

## What it is

EDI is the standardized electronic exchange of business documents (X12) with
trading partners. Tangerine ships an EDI **engine** (`api/_lib/edi/` — parser,
builder, mappers, inbound pipeline + 997 acks). EDI is organised into three
sides:

- **Vendors** — the procurement side (was the original P22 panel).
- **Customers** — the retailer / wholesale side trading-partner config (new).
- **Settings** — the VAN / interchange configuration shared by both (new).

## 37.1 Vendors

**Master Data → EDI → Vendors.** This is the existing vendor X12 dashboard:
enable EDI for a vendor and watch the message flow. The vendor side covers:

| Document | Direction | Meaning |
|---|---|---|
| **850** | out → vendor | Purchase Order (built when a PO is issued) |
| **855** | in ← vendor | PO Acknowledgment |
| **856** | in ← vendor | Advance Ship Notice (ASN) |
| **810** | in ← vendor | Invoice |
| **820** | out → vendor | Payment / Remittance |
| **997** | both | Functional Acknowledgment (auto) |

An EDI-enabled vendor is an `erp_integrations` row with a **partner ID** (the
partner's ISA/GS sender ID) and `status='active'`. **+ Enable EDI for vendor** →
pick the vendor, enter their **Partner / ISA sender ID**, and choose the
transport. The inbound pipeline resolves every incoming X12 envelope by matching
its **GS02 sender** against this partner ID. The **Messages** tab is the live
X12 log across all vendor partners.

## 37.2 Customers

**Master Data → EDI → Customers.** Configure the **customer-side** trading
partners — the retailers / wholesale buyers we exchange EDI with. Each row is
one customer (`edi_customer_partners`):

- **Customer** — picked from the Customer Master (shown by name; the internal id
  is never displayed).
- **Partner ISA qualifier / ID** — the customer's interchange receiver
  identifiers (ISA07 / ISA08).
- **Supported documents** — the X12 sets exchanged with that customer.
- **Active** — toggles the partner without deleting the config.

**Planned customer-side flows** (config only today — see *deferred* below):

| Document | Direction | Meaning |
|---|---|---|
| **850** | in ← customer | Purchase Order from the retailer → a Sales Order |
| **810** | out → customer | Invoice (from the AR invoice) |
| **856** | out → customer | Advance Ship Notice (from the shipment) |

## 37.3 Settings (VAN)

**Master Data → EDI → Settings.** One per-entity configuration row
(`edi_settings`) that drives the outbound interchange envelopes:

- **VAN** — provider (e.g. SPS Commerce, TrueCommerce, Cleo), host, username,
  password. *The password is a placeholder field today — stored as plain text;
  encryption at rest is a follow-up. Do not enter real production credentials
  until that lands.*
- **Our interchange identity** — ISA sender qualifier + ID (ISA05 / ISA06) and
  GS sender ID (GS02), used to build the ISA/GS envelope headers.
- **Environment** — **Test mode** emits the test usage indicator (ISA15 = `T`);
  unchecking it switches to production (`P`). **Active** flag.

Save goes through the standard confirm dialog; switching to production prompts
an extra confirmation.

## What's wired vs. deferred

- **Built:** the X12 parse/build engine, the vendor inbound pipeline (855/856/810
  → mapped, 997 ack returned), outbound 850 + 820 builders, `edi_messages` store,
  the vendor dashboard, and now the **customer trading-partner config** + **VAN
  settings**.
- **Deferred / operator setup (see OPERATOR-TODO):**
  - **Transport** — the actual AS2 / SFTP / VAN delivery + pickup worker isn't
    built; messages are *prepared and stored*, not yet *transmitted*. This needs
    your VAN credentials (entered in **Settings**) plus the transport worker.
  - **Customer / retailer transactions** — receiving **850 POs from retailers**
    into Sales Orders and sending **810 invoices + 856 ASNs** back is configured
    here (partners + supported docs) but the live exchange is a follow-up.
  - **VAN password encryption** — the credential field is plain-text today.
  - Configure partners, VAN settings, and the inbound secret
    (`EDI_INBOUND_SHARED_SECRET`) before any real exchange.

## 3PL warehouse EDI (940 / 945)

Beyond vendor (850/820/997) and customer (850/810/856) EDI, Tangerine also speaks
**warehouse EDI** to your **3PL providers**: **940 (Warehouse Shipping Order)**
outbound when you *wave* a sales order, and **945 (Warehouse Shipping Advice)**
inbound when the 3PL confirms the shipment. These use the same X12 envelope
engine and the `edi_messages` store (`transaction_set` 940/945). The full
workflow, plus the per-provider connection settings the operator must enter, is
documented in **[Chapter 36 — 3PL](36-3pl.md#363-waving-a-sales-order-to-a-3pl-edi-940--945)**.

## 3PL goods-receipt advice (944) → draft PO receipt

When a 3PL **receives your inventory into the warehouse** against one of your
native (Tangerine) purchase orders, it sends back an **EDI 944 (Stock Transfer
Receipt Advice)** telling you exactly what landed. Tangerine turns that advice
into a **draft goods receipt** you confirm and post — it never books inventory
on its own.

**What happens when a 944 arrives:**

1. The advice is parsed to a PO number plus the received quantity per SKU. It
   accepts a **raw X12 944**, a structured **JSON** body (`{ po_number, lines:
   [{ sku, qty_received }] }`), or a tiny **`sku,qty` CSV** — so a 3PL that
   isn't on true X12 can still report receipts.
2. Tangerine finds the matching native PO (it must be **issued** or
   **in transit**) and maps each advice SKU to its PO line (loose SKU match).
3. The raw advice is always logged to the EDI message store
   (`transaction_set '944'`, inbound) — even if the PO can't be found — so
   nothing is lost. **Unmatched SKUs are reported back, not silently dropped.**
4. A **draft goods receipt** is created on the PO (it is *not* posted).

**You finish it in Receiving.** The draft lands in **Inventory → Receiving**
(`m=receiving`), where you review the quantities, then **confirm and post** it —
that is what creates the FIFO inventory layers + the **GR/IR** journal entry and
flips the PO to *received*. Operator confirmation is deliberately required for
an EDI-driven receipt; the 944 never auto-posts.

> **Endpoint:** `POST /api/internal/edi/tpl/:provider_id/receipt-advice`.
> The 944 is the inbound counterpart to the outbound 940 you send when you wave
> an order — see **[Chapter 36 — 3PL](36-3pl.md#363-waving-a-sales-order-to-a-3pl-edi-940--945)**.
