# Documents (M29)

**Shipped in P2 Chunks 5 + 6** (2026-05-27).

Attach files (contracts, W-9s, certificates of insurance, packing lists, tax-exempt forms, etc.) to any record. Files live in Supabase Storage bucket `tangerine-documents`; the panel shows metadata and lets you download via short-lived signed URLs.

## Where it lives

Embedded inside record detail/edit modals — not its own top-nav panel. Currently wired into:

| Panel | Suggested kinds |
|---|---|
| **Vendor Master** edit modal | `contract`, `w9`, `coa`, `insurance`, `other` |
| **Customer Master** edit modal | `contract`, `tax_exempt`, `credit_app`, `other` |

The pattern is the same: open a record → scroll to the **📎 Documents** section at the bottom → upload, download, archive.

## How it works

```mermaid
flowchart LR
  A[Operator clicks Edit on a vendor row] --> B[Vendor edit modal opens]
  B --> C[DocumentAttachmentList renders<br/>scoped to (vendors, this.id)]
  C --> D[+ Upload button]
  D --> E[Choose file + kind + title]
  E --> F[POST /api/internal/documents<br/>(base64-encoded body)]
  F --> G[Bytes → Supabase Storage<br/>+ documents row + v1]
  G --> C
```

### Upload limits

- **Max size:** 25 MB per file (MVP cap)
- **Encoding:** files are base64-encoded into a JSON body. Multipart upload is a future enhancement when uploads exceed the cap.

### Download

Click **⬇ Download** on any row. The handler returns a signed URL valid for 5 minutes; the browser opens it in a new tab. Re-clicking generates a fresh URL.

The file downloads under its **original filename** (e.g. `Q3-costing.xlsx`), not the internal storage name. Each uploaded version records the filename it was uploaded with (`document_versions.original_filename`), and the signed URL carries it as the download (Content-Disposition) name. Documents uploaded before this feature (mig `20260835000000`) have no recorded name and fall back to the storage basename (`v1.xlsx`).

### Versioning

Future PR: a "Replace" action to upload a new version (`v2`, `v3`, …) of an existing document. The current version is always what downloads return unless `?version_id=` is passed. Version history is in the DB but not yet surfaced in the UI.

### Archive (soft delete)

**Archive** flips `is_archived=true`. The file stays in Storage; the row stays in `documents`. Listing hides archived by default. Recovery is a future admin action.

## Operator one-time setup

**Critical:** The Supabase Storage bucket `tangerine-documents` is NOT created by SQL. Create it once via the dashboard before the first upload — see [`../MIGRATIONS.md` § P2 Chunk 5 — one-time Supabase Storage bucket setup](../MIGRATIONS.md).

Until the bucket exists, uploads fail with `storage_upload_failed`. The schema migration applies fine independently; listing, archiving, signed-URL all keep working — only `attach()` / `uploadVersion()` need the bucket.

## What's dormant vs live

- ✅ **Live:** schema, library, handlers, reusable component, drop-ins in Vendor + Customer Master edit modals.
- ⏭ **Deferred follow-up:** drop-in into Journal Entry detail (needs a JE-detail modal first), structured version-replace UI, multipart upload for files > 25 MB, archive recovery.

## Related architecture

- [`../P2-cross-cutters-architecture.md` §6](../P2-cross-cutters-architecture.md) — full M29 spec
