# Tangerine M39 Mobile Scanner — REST Contract

OpenAPI-style spec for the mobile scanner back-end. The mobile teams
(iOS / Android / React Native — TBD) consume these 5 endpoints. The native
app shell is a separate work stream from P3-8.

**Base URL:** `https://design-calendar-app.vercel.app/api/internal/scanner`
**Auth:** Supabase Auth (Bearer token, one auth user per device). RLS clamps
each device to its own sessions via the `auth_own_scanner_sessions` policy.
Admin paths use the service-role key server-side; they bypass RLS.
**Content-Type:** `application/json` for all request and response bodies.

---

## 1. POST `/sessions`

Create a new scanner session.

**Request body**

```json
{
  "mode": "receive | pick | transfer | count",
  "target_kind": "po | so | cycle_count | adhoc",
  "target_id": "<uuid | null>",
  "device_user_id": "<uuid of auth.users>",
  "client_meta": { "app_ver": "1.0.0", "device_id": "...", "network": "wifi" }
}
```

- `target_id` is required for `po`/`so`/`cycle_count`; must be `null` for `adhoc`.
- `client_meta` is free-form jsonb; document new keys as the app evolves.

**Responses**

- `201` body = full `scanner_sessions` row (status = `open`, id assigned)
- `400` `{ "error": "..." }` validation failure
- `404` referenced FK row not present

---

## 2. GET `/sessions`

List sessions visible to the caller. Devices see only their own (RLS);
admins see everything in the entity (service-role).

**Query params**

| Param | Type | Notes |
|---|---|---|
| `device_user_id` | uuid | Filter (admin path) |
| `status` | string | `open` / `submitted` / `cancelled` |
| `mode` | string | `receive` / `pick` / `transfer` / `count` |
| `target_kind` | string | `po` / `so` / `cycle_count` / `adhoc` |
| `limit` | int | Default 100, max 500 |

**Response** — `200` array of `scanner_sessions` rows.

---

## 3. GET `/sessions/{id}`

Fetch a single session with its embedded events log.

**Response**

```json
{
  "id": "...",
  "entity_id": "...",
  "mode": "receive",
  "status": "open",
  "events": [
    {
      "id": "...",
      "client_event_id": "...",
      "scanned_barcode": "1234567890",
      "resolved_item_id": "...",
      "qty": 1,
      "client_timestamp": "...",
      "server_received_at": "..."
    }
  ]
}
```

- `404` if no session with that id.

---

## 4. POST `/events/batch`

Bulk-insert scan events. Idempotent via `(session_id, client_event_id)`.
This is the offline-replay endpoint: an app POSTs the same batch twice
after recovering from a flaky network and the second call is a no-op.

**Request body**

```json
{
  "session_id": "<uuid>",
  "events": [
    {
      "client_event_id": "<uuid generated on device at scan time>",
      "scanned_barcode": "1234567890",
      "resolved_item_id": "<uuid | null>",
      "qty": 1,
      "client_timestamp": "2026-05-27T10:00:00Z",
      "notes": "optional"
    }
  ]
}
```

- Max 500 events per batch.
- `qty` defaults to 1; negative qty allowed (returns / adjustments).

**Response**

```json
{
  "session_id": "...",
  "results": [
    { "client_event_id": "...", "inserted": true },
    { "client_event_id": "...", "inserted": false }
  ]
}
```

- `inserted: true` → row went in.
- `inserted: false` (no `error`) → duplicate; idempotent replay, treat as success.
- `inserted: false` with `error` → real failure; retry / surface to user.
- `409` if session is not `open` (already submitted/cancelled).

The mobile app SHOULD drop local-queue rows where `inserted: false` AND no
`error`, since the DB already has them. The local-queue cleanup is the only
state the app needs to manage across reconnects.

---

## 5. POST `/sessions/{id}/submit`

Submit the session. Aggregates events into a mode-appropriate output and
marks `status='submitted'`.

**Response**

```json
{
  "session": { /* updated scanner_sessions row */ },
  "aggregation": [
    { "resolved_item_id": "<uuid>", "qty": 12 },
    { "resolved_item_id": null, "scanned_barcode": "BAD1", "qty": 1 }
  ],
  "write_results": { /* mode-specific */ }
}
```

**Mode-specific `write_results` shape:**

| Mode | `write_results` |
|---|---|
| `receive` | `{ "posted_to_ap": false, "note": "AP integration ships in P3-2" }` |
| `pick` | `{ "posted_to_so": false, "note": "SO-ship integration ships later" }` |
| `transfer` | `{ "posted_to_transfers": false, "note": "Deferred — both P3-7 and P3-8 must be merged then operator manually creates the transfer" }` |
| `count` | `{ "wrote_count_lines": <n>, "unresolved_skipped": <n>, "errors": [] }` — only when `inventory_cycle_count_lines` exists; otherwise `{ "wrote_count_lines": 0, "skipped": "table not present" }` |

- `409` if session is not `open`.

---

## 6. POST `/sessions/{id}/cancel`

Cancel an open session. Sets `status='cancelled'`. Events are preserved
for troubleshooting.

**Response** — `200` updated row.
**Errors** — `409` if session is not `open`.

---

## Error envelope

All non-2xx responses share a single shape:

```json
{ "error": "human-readable explanation" }
```

---

## Idempotency model (mobile app contract)

1. App generates `client_event_id` (uuid v4) at scan time and persists it
   to local SQLite alongside the scan row BEFORE any network call.
2. On reconnect, app POSTs the entire local queue to `/events/batch`.
3. Server INSERTs with `ON CONFLICT (session_id, client_event_id) DO NOTHING`.
4. Server returns per-event `inserted: true|false`.
5. App deletes local-queue rows where `inserted: false && !error` (already in DB)
   AND where `inserted: true` (just landed).
6. App retries `inserted: false && error` rows on the next batch cycle.

The single rule the app MUST follow: **never regenerate `client_event_id`
on retry.** A scan's uuid is fixed forever the moment the device records it.

---

## Future endpoints (out of P3-8 scope)

- `GET /barcodes/resolve?code=<value>` — server-side fallback for offline
  resolution misses (P3-X).
- `POST /sessions/{id}/append-photo` — attach a photo of the scanned
  carton via M29 documents (deferred until mobile-app chunk lands).
