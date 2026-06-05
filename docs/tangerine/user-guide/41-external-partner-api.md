# 41. External / Partner API (M15)

Tangerine exposes a small, **read-only** REST API so authorized partners and
your own integrations (3PLs, BI tools, marketplaces) can pull core data without
a login. Access is gated by an **API key** that you issue and revoke from the
admin panel. No write endpoints are exposed in this release.

- **Base URL:** `/api/external/v1`
- **Auth:** `Authorization: Bearer <api-key>` on every request
- **Format:** JSON
- **Scope:** read-only, and scoped to the single entity the key belongs to
- **Pagination:** `?limit=` (default 50, **max 200**) and `?offset=`

---

## Managing keys — Admin → 🔑 API Keys

Open **Tangerine → Admin → 🔑 API Keys** (`/tangerine?m=api_keys`).

- **Create key** — give the integration a label (e.g. "Acme 3PL"). Tangerine
  generates the key and shows the **full key exactly once** in a modal with a
  **Copy** button and a warning. Copy it then — it is **never shown again**. Only
  a one-way hash and the public prefix are stored, so even Tangerine staff
  cannot recover a lost key.
- **List** — shows each key's label, public prefix (e.g. `rofk_ab12cd34…`),
  scopes, last-used time, and active/revoked status. The secret is never listed.
- **Revoke** — flips a key to inactive. Any integration using it stops working
  immediately. This cannot be undone; issue a new key if needed.

A key looks like `prefix.secret` — for example
`rofk_ab12cd34.W8f...`. The part before the dot is the public prefix; the part
after the dot is the secret you must keep safe.

### How keys are stored (security)

- The full key is hashed with **SHA-256**; only the hash and the public prefix
  are persisted. The plaintext secret is never logged or returned after creation.
- Every request re-hashes the presented key and timing-safe compares it.
- Keys are **entity-scoped**: a key only ever returns its own entity's data.
- Scope is **read** only — there are no write endpoints in this release.

---

## Authentication

Send the key as a Bearer token. A request without a valid, active key returns
`401 Unauthorized`.

```bash
curl -H "Authorization: Bearer rofk_ab12cd34.YOUR_SECRET_HERE" \
  https://app.example.com/api/external/v1/ping
```

Successful responses are JSON. List endpoints wrap rows in a paging envelope:

```json
{
  "data": [ /* ... rows ... */ ],
  "paging": { "limit": 50, "offset": 0, "count": 50 }
}
```

---

## Endpoints

### `GET /api/external/v1/ping`
Health + auth check. Confirms your key works and echoes the entity and scopes.

```bash
curl -H "Authorization: Bearer $KEY" \
  https://app.example.com/api/external/v1/ping
# { "ok": true, "entity_id": "...", "scopes": ["read"], "read_only": true }
```

### `GET /api/external/v1/styles`
Styles from the Style Master, with human labels (no internal IDs).
Query: `limit`, `offset`.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://app.example.com/api/external/v1/styles?limit=100"
```
Fields: `style_code`, `style_name`, `group`, `category`, `sub_category`,
`gender`, `status`.

### `GET /api/external/v1/inventory`
On-hand quantity by SKU (latest snapshot per SKU/warehouse).
Query: `limit`, `offset`, `warehouse`.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://app.example.com/api/external/v1/inventory?warehouse=MAIN&limit=200"
```
Fields: `sku_code`, `style_code`, `color`, `size`, `warehouse`, `qty_on_hand`,
`as_of`.

### `GET /api/external/v1/orders`
Sales orders. Customer is resolved to its code/name.
Query: `limit`, `offset`, `status`.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://app.example.com/api/external/v1/orders?status=confirmed"
```
Fields: `so_number`, `customer_code`, `customer_name`, `order_date`,
`requested_ship_date`, `cancel_date`, `status`, `currency`, `subtotal`, `total`,
`total_cents`.

### `GET /api/external/v1/invoices`
AR (customer) invoices. Void invoices are excluded unless `include_void=1`.
Query: `limit`, `offset`, `status`, `include_void`.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://app.example.com/api/external/v1/invoices?limit=50"
```
Fields: `invoice_number`, `invoice_kind`, `status`, `customer_code`,
`customer_name`, `invoice_date`, `due_date`, `currency`, `total`, `paid`,
`balance`, `total_cents`.

---

## Notes & limits

- **Read-only.** There are no create/update/delete endpoints in this release.
- **Pagination cap.** `limit` is capped at 200; page with `offset`.
- **Money.** Decimal fields (`total`, `balance`, …) are in the entity currency;
  `*_cents` companions are integers in cents to avoid float rounding.
- **Rate / fair use.** Keep page sizes reasonable and poll on a sensible
  interval. Revoke and reissue keys if one is ever exposed.
- **No raw IDs.** Payloads use human codes/names (sku_code, style_code,
  customer_code) rather than internal UUIDs.
