# Cross-cutter T6 — Global Search Architecture

Status: **PLAN ONLY** (2026-05-28). Operator ask: "global search bar visible on all views searching full app for any string". No implementation yet — this doc plans the design so it can drop in cleanly when implementation kicks off.

This is a **cross-app** feature (Design Calendar, PO WIP, Tech Packs, ATS, GS1, Planning, Vendor Portal, Tangerine). Joins the cross-cutter T-chunk stream alongside T1 (shell), T2 (OAuth), T3 (table export), T4 (personalization), T5 (schema snapshot).

> **Related:** [T4 Personalization](T4-personalization-architecture.md) ships a **menu-item search** (different scope — only nav items, instant filter on the menu_key registry). T6 is the **content search** across actual business records (customers, invoices, vendors, POs, etc.).

---

## 0. Scope

**In scope (v1):**
- Single search bar mounted in the top nav of every app (always visible).
- Searches across the operator's most-asked entities: `customers`, `vendors`, `ar_invoices`, `ap_invoices`, `tanda_pos`, `style_master`, `ip_item_master`, `gl_accounts`, `cases`, `sales_reps`, `bank_transactions`.
- Returns mixed result set grouped by entity type, with click-to-navigate. Each result shows: icon, primary label, secondary detail (e.g. customer name, date, amount), and a small badge for the entity type.
- Keyboard shortcut **⌘K** / **Ctrl-K** opens the search palette (like Linear / Notion / GitHub).
- Debounced 200ms; hits a single `/api/internal/search?q=` endpoint backed by Postgres full-text search.
- Top 5 per entity type; "show more" link opens that entity's list panel pre-filtered by the query.

**Out of scope (v1 — defer to v2 if requested):**
- Search inside attachments / PDFs / blob content.
- Search inside JE memos / line items / detail fields (only header fields in v1; line-level search is expensive).
- Search inside structured-but-untouched modules (RFQs, workflows, anomalies, etc.) — add per entity as operator asks.
- Fuzzy / typo-tolerant matching (Postgres `pg_trgm` could be added in v2).
- Cross-tenant search (single-tenant ROF for now anyway).
- AI-summarized result clusters / semantic search (M46 future).
- Saved searches / recent searches (start simple).
- Per-result permissions check beyond entity-level RLS (entity_id scope is sufficient for v1).

---

## 1. Existing state

- No global search exists anywhere in the suite. ATS, PO WIP, Tech Packs each have **panel-local search bars** (filter the visible rows) but no cross-app discovery.
- The ATS / PO WIP "find this PO" workflow today requires the operator to remember which panel to open.
- Postgres FTS not yet used in the schema. `vendors`, `customers`, `ar_invoices` have plain `text` columns and `LIKE '%foo%'` scans.

---

## 2. Decisions (recommended — operator to confirm at implementation time)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| T6-D1 | Search engine | **Postgres FTS** (`tsvector` + GIN index) per entity | No new dep; supabase-managed; good enough for ~100k row volumes. Pinecone/Algolia is overkill at our scale. |
| T6-D2 | Indexing strategy | **Materialized `tsvector` column** per entity + BEFORE INSERT/UPDATE trigger refreshing it | Avoids hand-maintained tsvector; one trigger per indexed entity (~10 lines each). |
| T6-D3 | Entity-type filter | **Default = all**, with a "type:vendor" prefix mini-syntax to narrow | Power-user feature; otherwise it just works. |
| T6-D4 | UI placement | **Search input in the top nav** (across all apps), always visible — even on mobile (collapses to icon on small screens) | The "always visible" requirement is the operator's literal ask. |
| T6-D5 | Keyboard shortcut | **⌘K / Ctrl-K** opens overlay palette (Linear / GitHub / Notion convention) | Universal muscle memory. |
| T6-D6 | Per-entity result formatter | Lives in a **registry file** `src/lib/searchRegistry.ts` mirroring the T4 menu-key registry | One source of truth for "how to display a search hit"; new entity = new registry entry. |
| T6-D7 | Click behavior | Routes to the panel's detail view via the entity's canonical URL | The panel must have a route per entity; some don't yet (e.g. AR invoice detail) — those need light routing work added during T6-3. |

---

## 3. Schema

```sql
-- Each searchable entity gets a tsvector column + GIN index + maintenance
-- trigger. Pattern repeated per entity (customers, vendors, ar_invoices, ...).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION customers_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.legal_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.email, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.notes, '')), 'D');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS customers_search_doc_refresh_trg ON customers;
CREATE TRIGGER customers_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_customers_search_doc ON customers USING GIN (search_doc);

-- Backfill once after creation:
UPDATE customers SET id = id;  -- triggers BEFORE UPDATE on every row
```

Repeat for each entity in the v1 set (~10 entities). One migration file per entity, or one bundled migration. Bundle is simpler.

### Cross-entity catalog view

```sql
CREATE OR REPLACE VIEW v_global_search AS
SELECT
  'customer'::text AS entity_type,
  id              AS entity_id,
  code            AS primary_label,
  coalesce(name, legal_name) AS secondary_label,
  search_doc,
  entity_id       AS tenant_entity_id
FROM customers
UNION ALL
SELECT 'vendor', id, code, name, search_doc, entity_id FROM vendors
UNION ALL
SELECT 'ar_invoice', id, invoice_number, description, search_doc, entity_id FROM ar_invoices
UNION ALL
SELECT 'ap_invoice', id, invoice_number, description, search_doc, entity_id FROM invoices
UNION ALL
SELECT 'po', id, po_number, vendor_name, search_doc, entity_id FROM tanda_pos
-- ...
;
```

(Real impl uses fewer UNIONs with smarter column aliasing; this is illustrative.)

### Search RPC

```sql
CREATE OR REPLACE FUNCTION global_search(
  p_query     text,
  p_entity_id uuid,
  p_per_type  int  DEFAULT 5,
  p_types     text[] DEFAULT NULL    -- optional filter: ['customer','vendor']
) RETURNS TABLE (
  entity_type      text,
  entity_id        uuid,
  primary_label    text,
  secondary_label  text,
  rank             real
)
LANGUAGE sql STABLE
AS $$
  WITH q AS (
    SELECT plainto_tsquery('simple', p_query) AS tsq
  ),
  ranked AS (
    SELECT v.entity_type, v.entity_id, v.primary_label, v.secondary_label,
           ts_rank(v.search_doc, q.tsq) AS rank,
           row_number() OVER (PARTITION BY v.entity_type ORDER BY ts_rank(v.search_doc, q.tsq) DESC) AS rn
    FROM v_global_search v, q
    WHERE v.tenant_entity_id = p_entity_id
      AND v.search_doc @@ q.tsq
      AND (p_types IS NULL OR v.entity_type = ANY(p_types))
  )
  SELECT entity_type, entity_id, primary_label, secondary_label, rank
  FROM ranked
  WHERE rn <= p_per_type
  ORDER BY rank DESC, entity_type;
$$;
```

---

## 4. API

| Endpoint | Purpose |
|---|---|
| `GET /api/internal/search?q=<query>&types=<csv>&per_type=<n>` | Calls `global_search` RPC. Returns `{results: [...], query, total_count_per_type}`. Debounced 200ms client-side. |
| `GET /api/internal/search/recent` | (v2) Per-user recent searches. Not in v1. |

Auth via standard auth_internal_* RLS. No additional secrets.

---

## 5. UI

### 5.1 Top-nav search input

`src/components/GlobalSearchInput.tsx` — fixed-position input in the existing top nav of every app. ~280px wide on desktop, collapses to ⌕ icon on narrow viewports. Keyboard shortcut `⌘K` / `Ctrl-K` focuses it from anywhere.

Visual treatment matches the dark Tangerine palette but is shared with DC / ATS / etc. (the search component imports nothing app-specific).

### 5.2 Results palette

`src/components/GlobalSearchPalette.tsx` — overlay panel that appears below the input as the user types. Grouped by entity type, top 5 per type, with a small `Showing N of M — show more →` link per group that routes to that entity's list panel pre-filtered by the query.

Keyboard: ↑/↓ to navigate, Enter to open, Esc to close.

### 5.3 Per-entity registry

`src/lib/searchRegistry.ts`:

```ts
export type SearchEntityConfig = {
  type: string;                 // 'customer'
  icon: string;                 // '🤝'
  label: string;                // 'Customer'
  detailRoute: (id: string) => string;   // '/tangerine?view=customer-master&id=<id>'
  listRoute:   (q: string) => string;    // '/tangerine?view=customer-master&q=<q>'
};

export const SEARCH_ENTITIES: SearchEntityConfig[] = [
  { type: 'customer', icon: '🤝', label: 'Customer', detailRoute: (id) => `/tangerine?view=customer-master&id=${id}`, listRoute: (q) => `/tangerine?view=customer-master&q=${encodeURIComponent(q)}` },
  // ...
];
```

Mirrors the T4 menu-key registry pattern.

### 5.4 Mounting

`src/App.tsx` adds `<GlobalSearchInput />` to the top nav. Tangerine, DC, ATS, etc. each render their own nav today — T6-4 chunk includes a small refactor to mount the search input above each app's nav so it appears everywhere.

---

## 6. Performance + scale

- Postgres FTS with GIN indexes scales well into millions of rows.
- `simple` config is used to avoid English-stemming artifacts on technical fields (style codes, UUIDs, etc.). v2 could add a separate English-stemmed `tsvector` for prose fields like notes.
- Result cardinality is bounded by `p_per_type * len(p_types)` (default ≤ 50 rows).
- 200ms client debounce + RPC executes in <100ms for ~100k row tables on Supabase free tier.

---

## 7. Chunk split (when implementation kicks off)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **T6-1** | tsvector schema + triggers for 10 v1 entities | One migration file. ~150 lines SQL. Each entity gets the same pattern. | — |
| **T6-2** | v_global_search view + global_search RPC | View + RPC + handler `/api/internal/search`. ~80 lines SQL + 50 lines JS. | T6-1 |
| **T6-3** | `<GlobalSearchInput>` + `<GlobalSearchPalette>` + searchRegistry.ts | React components + registry. ~300 lines. | T6-2 |
| **T6-4** | Mount across all apps + ⌘K shortcut handler | Top-nav refactor in `src/App.tsx` + per-app nav files. Small, but touches multiple files. | T6-3 |
| **T6-5** | User guide chapter 20 + memory close-out | Doc. | T6-4 |

Estimated **2-3 days** end-to-end. T6-1 + T6-2 can run in parallel with the per-entity formatter registry (T6-3 prep).

---

## 8. Risks

- **Coupling to entity routing.** T6 needs every searchable entity to have a stable "open detail by id" URL. Some Tangerine panels (AR Invoice, AP Invoice) lack that today — they need a small routing addition before T6 results can click-through. Treat as part of T6-3 scope.
- **`search_doc` migration backfill.** Adding the column doesn't populate it; the trigger fires on UPDATE. Initial backfill via `UPDATE customers SET id = id` works but is one-shot. Cleaner: an explicit `UPDATE ... SET search_doc = ...` per entity in the migration's seed section.
- **Cross-app navigation.** When the operator is in ATS and clicks a search result for a customer, they need to land in the Tangerine Customer Master panel. The detailRoute callback must be absolute, not app-relative.
- **Empty-state UX.** When a query returns zero results across all types, show a single "No results — search the full customer history?" hint that opens a fuller-scope search (line items, JE memos) — v2 feature.

---

## 9. Pairs with

- [[T4 Personalization]] — shares the menu_key registry pattern. Menu-item search lives in T4 (instant filter on the registry); content search lives here.
- [[T3 Universal table export]] — search-narrowed list views still get the ⬇ Export button.
- [[T5 Schema snapshot]] — the per-entity tsvector + trigger pattern reuses the same column reference style the snapshot uses.

---

## 10. T4 menu-item search (related but separate)

The operator's first ask — "search bar to search menu items on any string" — is part of T4. Adding it here as a planning cross-reference so it's not lost:

In T4-3 (the favorites side drawer chunk), the drawer header already includes an input field. Expanding it to also search the **full menu_key registry** (not just current favorites) is a single-component extension:

```tsx
const matches = useMemo(() =>
  MENU_ITEMS.filter(m =>
    !m.hidden &&
    (m.label.toLowerCase().includes(q.toLowerCase()) ||
     m.group?.toLowerCase().includes(q.toLowerCase()))
  ),
[q]);
```

No additional schema or API needed — registry is client-side. ~30 minutes of work, slotted into T4-3.
