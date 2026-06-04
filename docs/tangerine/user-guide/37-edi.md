# 37. EDI — Electronic Data Interchange (P22 / M14)

**Where:** Tangerine → **Procurement → 🔌 EDI** (`/tangerine?m=edi`)

## What it is

EDI is the standardized electronic exchange of business documents (X12) with
trading partners. Tangerine already ships an EDI **engine** (`api/_lib/edi/` —
parser, builder, mappers, inbound pipeline + 997 acks); this chapter is the
**dashboard** that surfaces it: enable EDI for a vendor and watch the message
flow.

Today the engine covers the **procurement / vendor** side:

| Document | Direction | Meaning |
|---|---|---|
| **850** | out → vendor | Purchase Order (built when a PO is issued) |
| **855** | in ← vendor | PO Acknowledgment |
| **856** | in ← vendor | Advance Ship Notice (ASN) |
| **810** | in ← vendor | Invoice |
| **820** | out → vendor | Payment / Remittance |
| **997** | both | Functional Acknowledgment (auto) |

## 37.1 Partners

An EDI-enabled vendor is an `erp_integrations` row with a **partner ID** (the
partner's ISA/GS sender ID) and `status='active'`. **+ Enable EDI for vendor** →
pick the vendor, enter their **Partner / ISA sender ID**, and choose the
transport (AS2 / SFTP / VAN). The inbound pipeline resolves every incoming X12
envelope by matching its **GS02 sender** against this partner ID — so it must be
exact.

## 37.2 Messages

The **Messages** tab is the live X12 log across all partners — direction,
document type, interchange control number, status (received / processed /
acknowledged / error), and any error message. Filter by direction or document
type. (A per-vendor history also exists at `GET /api/internal/edi/:vendor_id/messages`.)

## What's wired vs. deferred

- **Built:** the X12 parse/build engine, inbound pipeline (855/856/810 → mapped, 997 ack returned), outbound 850 + 820 builders, `edi_messages` store, and now this dashboard. Inbound auth is a shared secret (`EDI_INBOUND_SHARED_SECRET`).
- **Deferred / operator setup (see OPERATOR-TODO):**
  - **Transport** — the actual AS2 / SFTP / VAN delivery + pickup worker isn't built; messages are *prepared and stored*, not yet *transmitted*. This needs your EDI provider / VAN credentials.
  - **Customer / retailer EDI** — receiving **850 POs from retailers** (Macy's, Ross, TJ Maxx…) into Sales Orders and sending them **810 invoices + 856 ASNs** is the other half of EDI and is not built yet.
  - Configure partners + the inbound secret before any real exchange.
