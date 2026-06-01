# Tangerine P11-10 â€” Shopify Product Mirror + Image Unification

Status: **DRAFT** (2026-06-01). Sequel to P11 (Shopify revenue side, shipped 2026-05-29) and P8-7 (PIM image pipeline). Auto-merges on CI green per the standing plan-approval-not-implementation rule.

Implements two intertwined initiatives that the operator approved as a bundle:

1. **Shopify product catalog mirror** â€” the piece P11 Â§0 explicitly deferred. Adds `read_products`-scope sync (catalog only â€” no inventory push, no theme).
2. **Unified polymorphic image system** â€” retire the design-calendar Dropbox path; everything (PIM styles, DC tasks, DC notes / PO attachments, SKUs, Shopify product mirrors) lives in one Supabase Storage bucket behind one table behind one signed-URL API.

These two ship together because they share the same plumbing (the polymorphic image table, the generic upload API, the source-tag convention) and because the only sane way to ingest Shopify product images is via the unified pipeline â€” building a separate Shopify-only image path now and then re-unifying later would be the worst of both worlds.

---

## 1. Goals

Mirror the Shopify product catalog into Tangerine using the existing P11 Shopify client (`api/_lib/shopify/client.js`) on the same 6h backfill + webhook cadence shipped in P11-2/P11-6, so each `shopify_products` row can be linked to a `style_master` row and its image set flows automatically into the unified PIM gallery. Unify all image storage across the four apps (design-calendar PLM, Tangerine ERP, Tanda PO, and the internal admin surface) under one Supabase Storage bucket (`pim-images`, conceptually broadened to "entity images") plus one polymorphic table (`product_images` extended with `owner_type`/`owner_id`) plus one generic upload API (`/api/internal/images`), retiring `/api/dropbox-proxy` and `dbxUploadFileGlobal` after a backfill migration walks every Dropbox URL stored in `tasks.data`, `tanda_notes` `__attachment__` rows, and SKU JSON blobs. End state: one signed-URL access pattern (1h TTL, 3 derivative sizes) for every image in every app.

---

## 2. Decisions

### Carried forward from prior session (operator approved 2026-05-30)

| # | Decision | Recommendation | Why | Confirm? |
|---|---|---|---|---|
| D7 | Single shared bucket for all 4 apps | **`pim-images`** Supabase bucket is the canonical store; existing P8-7 derivative pipeline (Sharp â†’ thumb/web/print) is the only writer | One pipeline, one bucket, one signed-URL TTL policy. P8-7 already proved it on prod PIM styles. | â˜‘ approved |
| D8 | Bucket naming | **Keep `pim-images`** rather than rename to `entity-images`; rename is migration-disruptive and the bucket name is invisible to end users | Avoids a Supabase Storage object copy of 30k+ rows on cutover. Bucket name is just a string. | â˜‘ approved |
| D9 | Image derivative sizes locked | **thumb 200 / web 800 / print 2400** stays â€” applies to every kind, not just style flat shots | Single Sharp invocation regardless of entity. Tasks/notes get derivatives "for free." | â˜‘ approved |
| D10 | Original-byte retention | **Don't store** â€” print 2400px JPEG quality 88 is the de facto archive | P8-7 decided this already; reaffirmed for legacy Dropbox photos at backfill time (re-encode to print derivative, drop original). | â˜‘ approved |
| D11 | Signed-URL TTL | **1h** (existing P8-7 value) | Re-signs on every GET; clients cache the dataURL. Long enough for slow CADs in a tech-pack PDF, short enough to invalidate. | â˜‘ approved |
| D12 | RLS access pattern | **`anon FOR ALL`** like P8-7 (we're behind the dispatcher's auth layer, not RLS) | P1 standing pattern. Don't introduce a second auth model just for images. | â˜‘ approved |
| D13 | Image kind enum | **Keep P8-7's `flat | lifestyle | spec | swatch | other`**; do not introduce per-entity-type kind enums | Image *purpose* is independent of which entity owns it; `other` absorbs the long tail. | â˜‘ approved |
| D14 | One uploader component | **Refactor `src/components/ImageUploader.tsx`** to use the new generic API; do not fork into per-entity uploaders | The Dropbox uploader is already the universal one. Keep the universality, swap the backend. | â˜‘ approved |
| D15 | Existing PIM upload endpoint kept | **Yes â€” preserve `/api/internal/pim/styles/:style_id/images` as a thin shim** that calls the generic handler with `owner_type='style'` pre-set | Zero breakage for the InternalPimStyleDetail.tsx caller; client-side rollout is independent of server-side unification. | â˜‘ approved |

### New decisions (Plan agent draft, autonomous picks per standing "go with your recommendations" instruction)

| # | Decision | Recommendation | Why | Status |
|---|---|---|---|---|
| D16 | Polymorphic: rename `product_images` or extend in place? | **Extend in place.** Add `owner_type` (default `'style'`) + nullable `owner_id`; backfill `owner_id := style_id` for existing rows; keep `style_id` for back-compat. | A rename forces 15+ downstream queries + indexes + `signDerivativeUrls` to change. Extension is a one-line ALTER + a CHECK. | auto-go |
| D17 | `owner_type` enum values v1 | **`style | task | note_attachment | sku | shopify_product`** â€” actual call sites today. NOT a forward-looking buffet. | Each value corresponds to a real existing data source. Locked via CHECK. | auto-go |
| D18 | `owner_id` resolution per type | Widen `product_images.owner_id` to `text` (accepts both uuid styles and text task ids) | One wart vs. two columns of polymorphism. | auto-go |
| D19 | Generic upload API shape | **`POST /api/internal/images?owner_type=â€¦&owner_id=â€¦`** (multipart, same field names as P8-7) | Per-entity routes would mean six handlers maintaining the same Sharp + Storage code. | auto-go |
| D20 | Legacy `/api/internal/pim/styles/:style_id/images` | **Keep as thin wrapper** with `X-Tangerine-Deprecated` header | Zero breakage for the InternalPimStyleDetail.tsx caller. | auto-go |
| D21 | Dropbox backfill strategy | **One-shot eager migration script** (`scripts/backfill-dropbox-to-pim.mjs`) | Lazy-on-read means Dropbox stays a runtime dep forever. **NEEDS OPERATOR SIGN-OFF for the run window before P11-10-10 lands.** | needs op |
| D22 | Backfill failure handling | **Quarantine table** (`dropbox_backfill_failures`) â€” operator triages | 5+ years of CADs means some PSDs are 60MB / non-JPEG / behind revoked share links. | auto-go |
| D23 | Cutover window for `dbxUploadFileGlobal` | **Two-phase**: Phase 1 deprecate (still functional), Phase 2 throw + delete | Hard cutover risks data loss if any caller is missed. | auto-go |
| D24 | Inline-JSON image arrays in `tasks.data` etc. | **Keep inline shape, replace `src` value with new bucket path** | The `product_images` row is the system of record; inline JSON carries `{id, src: <bucket path>, name, type: 'pim'}`. | auto-go |
| D25 | Style â†” Shopify product matching | **Auto-suggest by `style_code == shopify_handle OR shopify_tags contains style_code`**; manual override always available; NO fuzzy title match | Operator's Shopify handles already follow style_code convention for ~80% of catalog. Fuzzy matching creates wrong-link risk. | auto-go |
| D26 | When linked, auto-import images? | **Explicit one-click** "Pull X Shopify images" button | Silent import would mass-create rows the operator didn't authorize. | auto-go |
| D27 | Source enum on `product_images` | **`source âˆˆ {manual, shopify, dropbox_migrated}`** | Captures provenance of every row for filtering + cleanup. | auto-go |
| D28 | Shopify webhook subscriptions | **`products/create`, `products/update`, `products/delete`** via existing P11-2 HMAC pattern | Reuses P11-2 plumbing wholesale. | auto-go |

---

## 3. Schema diff

### 3.1 `product_images` extension (in-place, idempotent)

Migration file: `supabase/migrations/20260712200000_p11_10_chunk1_product_images_polymorphic.sql`

```sql
-- Add polymorphic columns. owner_type defaults to 'style' so existing rows
-- backfill cleanly. owner_id widens to text to accommodate tasks.id (text PK).
ALTER TABLE product_images
  ADD COLUMN IF NOT EXISTS owner_type text NOT NULL DEFAULT 'style'
    CHECK (owner_type IN ('style','task','note_attachment','sku','shopify_product')),
  ADD COLUMN IF NOT EXISTS owner_id   text,
  ADD COLUMN IF NOT EXISTS source      text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','shopify','dropbox_migrated')),
  ADD COLUMN IF NOT EXISTS shopify_image_id bigint,
  ADD COLUMN IF NOT EXISTS original_dropbox_url text;  -- audit trail only

-- Backfill owner_id from existing style_id rows.
UPDATE product_images
   SET owner_id = style_id::text
 WHERE owner_id IS NULL AND style_id IS NOT NULL;

-- Style_id stays for back-compat (the existing handler reads it directly).
-- Make it nullable now so non-style rows can omit it.
ALTER TABLE product_images
  ALTER COLUMN style_id DROP NOT NULL;

-- Replace per-style primary unique with per-entity partial unique index.
ALTER TABLE product_images
  DROP CONSTRAINT IF EXISTS pi_primary_unique_per_style;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_primary_per_entity
  ON product_images (owner_type, owner_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_pi_entity
  ON product_images (owner_type, owner_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pi_source
  ON product_images (source) WHERE source <> 'manual';
CREATE INDEX IF NOT EXISTS idx_pi_shopify_image
  ON product_images (shopify_image_id) WHERE shopify_image_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
```

### 3.2 `shopify_products` (new)

Migration file: `supabase/migrations/20260712210000_p11_10_chunk1_shopify_products.sql`

```sql
CREATE TABLE IF NOT EXISTS shopify_products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id       uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_product_id     bigint NOT NULL,
  shopify_handle         text NOT NULL,
  title                  text NOT NULL,
  product_type           text,
  vendor                 text,
  tags                   text[] NOT NULL DEFAULT '{}',
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','draft')),
  published_at           timestamptz,
  updated_at_shopify     timestamptz NOT NULL,
  raw_payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_style_id      uuid REFERENCES style_master(id) ON DELETE SET NULL,
  match_method           text CHECK (match_method IN ('handle','tag','manual',null)),
  last_synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_products_unique UNIQUE (shopify_store_id, shopify_product_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_products_handle ON shopify_products (shopify_store_id, shopify_handle);
CREATE INDEX IF NOT EXISTS idx_shopify_products_style  ON shopify_products (resolved_style_id) WHERE resolved_style_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopify_products_unmatched ON shopify_products (last_synced_at) WHERE resolved_style_id IS NULL;

ALTER TABLE shopify_products ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_shopify_products' AND tablename = 'shopify_products') THEN
    CREATE POLICY anon_all_shopify_products ON shopify_products FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
```

### 3.3 `style_master.shopify_product_id` back-link

Migration file: `supabase/migrations/20260712220000_p11_10_chunk1_style_master_shopify_link.sql`

```sql
ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS shopify_product_id uuid REFERENCES shopify_products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_style_master_shopify ON style_master (shopify_product_id)
  WHERE shopify_product_id IS NOT NULL;
```

### 3.4 `dropbox_backfill_failures` quarantine

Migration file: `supabase/migrations/20260712230000_p11_10_chunk1_dropbox_backfill_quarantine.sql`

```sql
CREATE TABLE IF NOT EXISTS dropbox_backfill_failures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  original_url    text NOT NULL,
  source_owner_type text NOT NULL,
  source_owner_id   text NOT NULL,
  source_json_path   text,
  error_class     text NOT NULL,
  error_detail    text,
  bytes           bigint,
  mime_type       text,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  resolution      text CHECK (resolution IN (null,'reuploaded','skipped','lost')),
  resolved_at     timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_dbf_unresolved ON dropbox_backfill_failures (attempted_at) WHERE resolution IS NULL;
```

---

## 4. API surface

### 4.1 New

| Endpoint | Method | Body / Query | Notes |
|---|---|---|---|
| `/api/internal/images` | `POST` | multipart: `file` (req), `owner_type` (req), `owner_id` (req), `alt_text?`, `image_kind?`, `sort_order?`, `is_primary?`, `uploaded_by_user_id?`, `source?` | Generic uploader. Reuses `validateUploadFile` + `processImage` from `api/_lib/pim-images.js`. Returns `{ row, signed_urls: {thumb,web,print} }`. |
| `/api/internal/images` | `GET` | query: `owner_type`, `owner_id` | Returns ordered list with signed URLs. Same shape as existing PIM GET. |
| `/api/internal/images/:id` | `PATCH` | `{sort_order?, is_primary?, alt_text?, image_kind?}` | Same `validatePatch` rules. |
| `/api/internal/images/:id` | `DELETE` | â€” | Hard-deletes the row + the 3 storage objects. |
| `/api/internal/shopify/products` | `GET` | query: `store_id?`, `status?`, `unmatched?` | Lists mirrored Shopify products. |
| `/api/internal/shopify/products/:id/link-style` | `POST` | `{ style_id, match_method }` | Sets `resolved_style_id` + back-fills `style_master.shopify_product_id`. |
| `/api/internal/shopify/products/:id/pull-images` | `POST` | â€” | Iterates `raw_payload.images[]`, downloads via `client.js`, uploads via generic image pipeline with `source='shopify'`. Idempotent on `shopify_image_id`. |
| `/api/webhooks/shopify/products/:store_id` | `POST` | Shopify HMAC | Upserts `shopify_products` from `products/create` / `products/update`. |
| `/api/webhooks/shopify/products-delete/:store_id` | `POST` | Shopify HMAC | Soft-archives the `shopify_products` row. |
| `/api/cron/shopify-products-backfill` | (Vercel cron, 6h) | â€” | Walks `client.listProducts({updated_at_min})` paginated. |

### 4.2 Modified

| Endpoint | Change |
|---|---|
| `/api/internal/pim/styles/:style_id/images` (POST + GET) | Thin shim: pre-fills `owner_type='style'`, `owner_id=:style_id`, delegates. Adds `X-Tangerine-Deprecated` header. |
| `/api/_lib/shopify/client.js` | Add `listProducts({since, until, page_info, limit})` + `getProduct(id)`. |

### 4.3 Deprecated

| Endpoint | Phase 1 | Phase 2 |
|---|---|---|
| `/api/dropbox-proxy` | Works, logs warning to stderr | Removed |
| `src/utils/helpers.ts â†’ dbxUploadFileGlobal` | Works, logs deprecation | Throws `new Error('use /api/internal/images')` |

---

## 5. Chunks

| Chunk | Title | Depends on | Wave |
|---|---|---|---|
| **P11-10-1** | Schema migrations (4 SQL files in Â§3) | â€” | A |
| **P11-10-2** | `products-client.js` extension | â€” (parallel with -1) | A |
| **P11-10-3** | Generic image API | P11-10-1 | B |
| **P11-10-4** | Legacy PIM shim | P11-10-3 | C |
| **P11-10-5** | Shopify products webhooks + backfill cron | P11-10-1, P11-10-2 | B (parallel -3) |
| **P11-10-6** | Link-style + pull-images API | P11-10-3, P11-10-5 | C |
| **P11-10-7** | UI: Style Master Shopify picker + Pull button | P11-10-6 | D |
| **P11-10-8** | UI: Shopify Products admin panel | P11-10-5 | D (parallel -7) |
| **P11-10-9** | Refactor `ImageUploader.tsx` + `useNotesOps` | P11-10-3 | C (parallel -4) |
| **P11-10-10** | Dropbox backfill script | P11-10-3, P11-10-9 | E |
| **P11-10-11** | Kill switch + cleanup | P11-10-10 | F |
| **P11-10-12** | Docs + memory close-out | All above | F |

Parallel groups: `{-1, -2}`, `{-3, -5}`, `{-4, -6, -9}`, `{-7, -8}`. Sequential tail: `-10 â†’ -11 â†’ -12`.

---

## 6. Rollout sequence + risk callouts

1. **Wave A** parallel: schema + Shopify client. ~1 day.
2. **Wave B** parallel: generic API + Shopify webhooks/cron. ~2 days.
3. **Wave C** parallel: PIM shim + link/pull + uploader refactor. ~2 days.
4. **Wave D** parallel: Style Master UI + Shopify admin panel. ~2 days.
5. **Wave E** sequential, operator-paced: backfill script. ~1 day script + triage time.
6. **Wave F** sequential: kill switch + docs. ~1 day.

Total: **~7-8 working days** plus 1-2 day operator gap for backfill triage.

### Risks
- **Backfill is the only truly risky chunk.** Mutates production task/note/SKU JSON blobs in place. Mitigations: full Supabase backup before run (operator action), dry-run mode, `product_images.original_dropbox_url` audit column, idempotent on the inline `id`.
- **Shopify rate limits during first products backfill** â€” client.js 429 path handles it; first run may take 30+ min.
- **`tasks.id` is text not uuid** â€” widening `product_images.owner_id` to text accepts both (D18).
- **Primary-unique replacement** â€” pre-flight check in migration: `SELECT owner_type, owner_id, COUNT(*) FROM product_images WHERE is_primary GROUP BY 1,2 HAVING COUNT(*) > 1;` should return 0 before the new index is created.

---

## 7. Open questions blocking later chunks

These need operator input before the corresponding chunk lands.

1. **D21 backfill window** â€” when can operator block out 2-4h low-traffic window? Blocks P11-10-10.
2. **Dropbox token read scope** â€” confirm existing proxy token can fetch the legacy folder. Blocks P11-10-10.
3. **Cases attachments** (D17 follow-up) â€” include `case` in v1 owner_type, or defer? Blocks P11-10-1 final list lock.
4. **Multi-store Shopify product matching** â€” one style_master row could be linked from two `shopify_products` rows (DTC + Wholesale stores). Confirm intentional. Affects P11-10-6 UI.
5. **Backup retention for legacy Dropbox folder** â€” how long after kill-switch before operator archives Dropbox folder? 90 days recommended.
