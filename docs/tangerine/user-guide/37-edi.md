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

## Connecting your 3PL (SFTP transport)

The document *engine* above is always on, but nothing actually **transmits** to
a 3PL until you give Tangerine the warehouse's connection details. Today's live
transport is **SFTP** (AS2/VAN are reserved for later). You configure it once
per 3PL under **EDI → 3PL Connections**, then the platform sends and receives on
a schedule — no manual file handling.

### What you must obtain from the 3PL

Ask your 3PL's EDI/onboarding team for **all** of the following and enter them in
the connection form. Until every required item is set, 940s **generate and
queue** but do not send (the message log shows them as `queued`), which is safe.

| # | You need | Goes in field | Notes |
|---|----------|---------------|-------|
| 1 | **SFTP host** | *SFTP host* | e.g. `sftp.your3pl.com` |
| 2 | **SFTP port** | *Port* | usually `22` |
| 3 | **SFTP username** | *Username* | the login they issue you |
| 4 | **Password *or* SSH private key** | *Password / private key* | write-only; stored **encrypted**. Paste a password, or the full PEM key text. |
| 5 | **Outbound directory** | *Outbound dir* | the folder **they** watch for your **940s** (their "inbound"/"in"/"to_wh") |
| 6 | **Inbound directory** | *Inbound dir* | the folder **they drop** 944/945/846/997 into for you (their "outbound"/"out") |
| 7 | **Archive directory** *(optional)* | *Archive dir* | where processed files are moved after ingest. Leave blank to leave them in place. |
| 8 | **Their ISA qualifier + ID** | *Their ISA qualifier / ID* | the interchange partner ID pair they expect (e.g. `ZZ` + `WAREHOUSE01`) |
| 9 | **Their GS ID** | *Their GS ID* | their application receiver code |
| 10 | **Which documents they support** | *Enabled documents* | tick the ones they exchange: 940 out, 944/945/846 in, 997 acks |
| 11 | **Their 940 spec / mapping guide** | — | any field-level quirks (unit codes, address requirements, SCAC handling). Share it so we can confirm the 940 maps cleanly before go-live. |

> Your **own** ISA/GS sender IDs are set once under **EDI → Settings**
> (`edi_settings`); the connection form only needs the *partner* side, though it
> offers optional per-3PL overrides if a warehouse demands specific sender IDs.

### Testing before go-live

The connection form has a **Test connection** button. It saves your settings,
opens a real SFTP session, and lists the outbound and inbound directories —
reporting a clear success (with file counts) or the exact error (bad host,
auth failure, missing directory). If no credentials are set yet it says so
plainly rather than failing obscurely. Use it before you wave your first live
order.

### How it runs once connected

* **Outbound.** Waving a sales order builds a 940 and queues it. A transport job
  runs **every 15 minutes**, uploads queued 940s over SFTP, and marks each
  `sent`. A failed send is **retried with backoff** (up to 5 attempts); after
  that it stays `failed` and you can **Re-queue** it from the message detail.
* **997 acknowledgment.** When the 3PL returns a 997, Tangerine matches it to
  your 940 by control number and stamps the message **accepted** or **rejected**
  (visible in the *997 Ack* column).
* **Inbound.** The same job polls the inbound directory, downloads new files,
  **de-duplicates** them by interchange control number, parses them, and — for
  safety on an unattended job — **stages** 944/945/846 for review rather than
  mutating anything automatically. You apply them exactly as before (a 944
  becomes a draft receipt you post in Receiving; a 945 marks the shipment
  shipped). **Nothing is ever posted to the GL automatically.**

### Reading the message log

**EDI → Messages** is the live audit trail. Click any row for full detail: the
raw X12 payload, the parsed content, delivery status, attempt count, transport
outcome, and 997 ack status. Failed outbound messages carry a **Re-queue /
retry** action. Everything exports from the table's export button.

## 37.5 Selling to retailers via EDI (856 ASN + 810 invoice)

**Where:** **EDI → Retail Partners** tab. This is the supplier→retailer side —
the documents a big-box retailer requires from you as their vendor. Ring of Fire
generates two OUTBOUND documents per shipment:

| Document | Direction | Meaning |
|---|---|---|
| **856** | out → retailer | Advance Ship Notice (ASN) — what's on the truck, boxed how, with an SSCC carton label per pack |
| **810** | out → retailer | Invoice — the bill for the shipment, per SKU with UPC/GTIN, terms, allowances/charges |
| **997** | in ← retailer | Functional Acknowledgment — the retailer confirms they accepted (or rejected) your 856/810 |

### How it fires

An 810 and (if enabled) an 856 are **generated and queued automatically when you
post an AR invoice** for a customer that is configured as an active retail EDI
partner. Nothing fires on historical invoices — only on a fresh post. The same
transport cron that sends 3PL 940s uploads the queued 856/810 over the partner's
SFTP connection every 15 minutes, retries with backoff, and reconciles the
retailer's 997 by control number. **Until a partner has credentials configured,
messages generate and queue but never transmit** (inert-safe) — so you can build
and inspect the exact X12 before a single byte leaves the building.

**Carton detail:** Tangerine has no WMS pack-out data for customer shipments, so
the ASN is generated as a **single tare** — one SSCC-18 carton label over all
line items. The SSCC is a valid GS1 Mod-10 code built from your GS1 company
prefix (Master Data → GS1 settings). When true carton-level packing becomes
available (a pack-out/WMS feed), the ASN hierarchy expands to one tare per
physical carton. A `single_pack` flag on each 856 marks this.

### Per-retailer configuration (the map)

Every retailer's 856/810 spec differs — which id qualifier they want on a line
(UPC vs GTIN-14 vs vendor part), whether the ASN uses a Tare or Pack level, the
buyer party qualifier, and so on. Rather than hardcode one retailer, each partner
carries a **per-document map** (JSON) that overrides the spec defaults. Common
keys: `"810": {"line_id_qual":"UP","buyer_qual":"92","buyer_id":"…"}` and
`"856": {"hierarchy":["S","O","T","I"],"man_qual":"GM","gs1_prefix":"…"}`.

### Per-retailer onboarding checklist

Before you can certify with a retail partner, collect from **them**:

1. **Interchange identity** — their ISA qualifier + ISA ID (receiver) and GS
   application ID. They also assign or confirm YOUR ISA/GS IDs as their vendor.
2. **Transport** — SFTP host/port + username, and either a password or an SSH
   key (or an AS2/VAN endpoint if that's their channel). The inbound directory
   where they drop 997s, and the outbound directory where you upload 856/810.
3. **Document specs** — their 856 and 810 implementation guides: required
   segments/qualifiers, the HL hierarchy they expect, and label placement rules
   (where the SSCC/UCC-128 carton label goes on the box).
4. **Certification** — the test cycle. Keep **Usage = Test** on the partner until
   their EDI team signs off on your test 856/810; then flip to **Production**.

Enter all of this on **EDI → Retail Partners → Add retail partner**, set the
enabled documents (856/810/997), paste any map overrides, and use **Save & test
connection** to prove the SFTP link. Post a test AR invoice for that customer to
generate the first 856/810 and inspect the raw X12 in **EDI → Messages**.
