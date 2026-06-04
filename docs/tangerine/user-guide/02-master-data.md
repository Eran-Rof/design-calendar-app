# 2. Master data — Style, Vendor, Customer

The three master-data panels share the same skeleton: **list + search + add + edit + soft-delete**. Once you've learned one, the others read the same way. This document walks Style Master in detail, then calls out only what differs in Vendor and Customer.

## 🎨 Style Master

### What a "style" is

A **style** is the design-level identity of a garment, independent of its variants. `RY1234` is a style. `RY1234 / RED / M / 30 / REGULAR / SLIM` is a SKU (an instance of that style with the 5 matrix dimensions — see [04-concepts.md § matrix dimensions](04-concepts.md#matrix-dimensions)).

The Style Master holds **one row per style per entity**: style code, description, category, gender, season, design year, lifecycle status, planning class, base fabric, and an `is_apparel` flag that drives whether the linked SKUs must carry the full 5-dim matrix.

### List view

Columns shown: **Code, Description, Gender, Season, Year, Lifecycle, Apparel**.

- **Search** by style code or description (case-insensitive substring).
- **Show deleted** toggle — soft-deleted rows are hidden by default; toggle to see them grayed out.
- Click **Edit** on any row to change mutable fields.
- Click **Delete** to soft-delete (the row stays in the database with `deleted_at` set, so historical JEs and POs that reference it remain valid).

![Style Master list view](screenshots/02-style-master-list.png)
<!-- screenshot needed: Style Master list with several rows + search box + show-deleted toggle -->

### Add modal

Click **+ Add style** to open. Fields:

| Field | Required? | Notes |
|---|---|---|
| Style code | yes | Auto-uppercased on save. Unique per entity. |
| Description | yes | Free text |
| Gender | no | One of `M`, `WMS`, `B`, `C`, `G`, `U`. Matches the rof_xoro daily conformance set. |
| Season | no | Free text (e.g. `FW26`) |
| Design year | no | 1990–2100 |
| Lifecycle | required, defaults `active` | `active` / `phased_out` / `discontinued` / `core` |
| Planning class | no | `core` / `seasonal` / `fashion` |
| Base fabric | no | Free text |
| Apparel? | checkbox, defaults true | When true, linked item-master rows must carry all 5 matrix dims (CHECK enforces). |

The form rejects empty style code, missing description, invalid enum values, and out-of-range design year (1990–2100) with a clear error message at the bottom of the modal.

![Style Master Add modal](screenshots/02-style-master-add-modal.png)
<!-- screenshot needed: the Add modal with all fields visible -->

### Edit modal

Same shape as Add, with **one difference**: `Style code` is locked. Codes are intentionally immutable — they're the human-readable identifier that historical references depend on. To change a style code, soft-delete and re-create.

The **Season** field is a searchable dropdown sourced from the Season Master (below). Pick an existing season, or — as an admin — type a new one and choose **"+ Add new season"** to add it to the master inline. The chosen season name is stored on the style as plain text, so older free-text seasons that predate the master still display correctly.

## 🍂 Season Master

Find it under **Master Data → Seasons** (`/tangerine?m=season_master`). A season is a named merchandising window — `FW26`, `SS27`, `HOLIDAY26` — that styles are tagged with.

### What a season row is

| Field | Notes |
|-------|-------|
| **Code** | Server-generated, read-only (`SEASON-00001`, `SEASON-00002`, …). Allocated on save; you never type it. |
| **Name** | The label that appears on styles and in the Season dropdown, e.g. `FW26`. Required. |
| **Sort order** | Controls list ordering (ascending); ties break by code. |
| **Active** | Inactive seasons drop out of the Style Master picker but stay in the table (toggle **Show inactive** to see them). |

### How it relates to Style Master

The master simply **curates the picklist**. `style_master.season` remains a free-text column storing the chosen season **name** — there is no foreign key. This keeps the change backward-compatible: existing styles keep their season text whether or not it's in the master, and the dropdown surfaces the style's current season even if it was later deactivated or never added.

### Delete protection

Deleting a season is a hard delete, but it is **rejected (409)** if any style is still tagged with that season name — reassign those styles first, or just toggle **Active** off to retire it without losing history. Standard panel features apply: server-side search, `<ExportButton>` (xlsx), column show/hide, and row-click-to-edit.

## 🏭 Vendor Master

### What differs from Style Master

| Aspect | Vendor Master |
|---|---|
| **List columns** | Code, Name (with `legal_name` underneath if different), Country, Status, 1099?, Payment Terms |
| **Search matches** | name OR code OR legal_name (ilike) |
| **Soft-delete toggle** | "Show inactive" — vendor deactivation sets `status='inactive'` AND `deleted_at` (so the row both falls out of `status=active` filters AND becomes excluded by `deleted_at IS NOT NULL` queries). |
| **Status** | active / on_hold / inactive |
| **PII fields** | `tax_id` and `bank_account_encrypted` are **never** shown in the UI. The Add modal has no field for them. A small "Tax ID and banking handled via dedicated PII workflow" note appears in the modal. |
| **Default GL accounts** | `default_gl_ap_account_id` and `default_gl_expense_account_id` are visible in the Edit modal but only after your Chart of Accounts is seeded. Without accounts, the dropdowns are empty. |

![Vendor Master list view](screenshots/02-vendor-master-list.png)
<!-- screenshot needed: Vendor Master list with several rows -->

### PII handling

The schema stores `tax_id` (EIN/VAT) and `bank_account_encrypted` (AES-256 ciphertext) on the `vendors` row, but the admin handler explicitly excludes them from every SELECT. The Add and PATCH endpoints reject any attempt to set them.

When you need to capture a vendor's tax ID or bank account, that flows through a separate (planned) PII-aware endpoint — never the admin UI. This matches the CLAUDE.md security mandate "never log PII, never return in API responses."

### Supporting documents (M29 / P2-6)

The Vendor Edit modal renders the reusable `<DocumentAttachmentList>` widget below the form fields. Seeded document kinds: `contract`, `w9`, `coa`, `insurance`, `other`. Upload a file, the system stores it in the `tangerine-documents` Supabase Storage bucket and renders a row with kind + filename + uploader + timestamp; click Download for a short-lived signed URL, or Archive to soft-delete (the row stays for audit but disappears from the default list).

For the widget to work, an operator with admin access to Supabase must have created the `tangerine-documents` bucket once. See [09-documents.md](09-documents.md) for the full workflow + setup.

## 🤝 Customer Master

### What differs from Style Master

| Aspect | Customer Master |
|---|---|
| **List columns** | Code, Name, Customer type, Country, Status, Credit limit, Payment terms |
| **Search matches** | name OR code OR customer_code (ilike) |
| **Customer type filter** | Dropdown above the table: all / wholesale / ecom / showroom / employee / other |
| **Status** | active / on_hold / inactive (parallels Vendor) |
| **`customer_type`** | New ERP field (Chunk 6). Drives default revenue-account selection and reporting buckets. Backfilled from your existing `channel_id` heuristic: wholesale channel → `wholesale`; ecom channel → `ecom`; retail → `showroom`; everything else → `wholesale`. |
| **Legacy `customer_tier`** | Still present in the DB (text). The new `customer_type` is the authoritative field for ERP behavior. |
| **PII** | `tax_exempt_certificate` text is never shown in the list; only in the Edit modal it appears as a placeholder note "handled via dedicated PII workflow." |
| **Credit limit** | Numeric (14,2). When set, the AR module (planned) will block new orders past this limit. For now it's metadata. |

![Customer Master list view](screenshots/02-customer-master-list.png)
<!-- screenshot needed: Customer Master list with type filter visible -->

### Supporting documents (M29 / P2-6)

The Customer Edit modal renders the same `<DocumentAttachmentList>` widget as Vendor Master. Seeded document kinds: `contract`, `tax_exempt`, `credit_app`, `other`. The widget appears below the form fields once the customer is in `mode='edit'`. Use it to attach signed contracts, tax-exempt certificates, credit applications — see [09-documents.md](09-documents.md).

## Common patterns

These hold for all three master panels:

- **Soft-deletes preserve history.** Deleting (or inactivating) a master record never removes the row. Foreign keys from `journal_entries`, `tanda_pos`, `invoices` etc. stay valid.
- **Codes are case-insensitive and uppercased on save.** `ry1234` and `RY1234` produce the same record. Internally everything is stored upper-case.
- **Search is server-side ilike.** The query string `pant` matches `pants`, `PANTHER`, `expant`. Whitespace-trim happens before the query.
- **API error toasts.** Errors return JSON `{ error: "human message" }` and appear in the modal's error banner. 409 (conflict) usually means a uniqueness violation; 400 means a validation failure; 500 means the server hit an unexpected problem.

## Going further

- Concept explanations behind these panels: [04-concepts.md](04-concepts.md)
- A vendor-onboarding workflow that uses Vendor Master end-to-end: [05-workflows.md § new vendor onboarding](05-workflows.md#new-vendor-onboarding)
- When delete/edit fails: [06-troubleshooting.md](06-troubleshooting.md)
