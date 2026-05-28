# Tangerine P8 — Data + CRM Architecture Pass

Status: **DRAFT** (2026-05-28). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the standing plan-approval-not-implementation rule.

Implements **M25 (Customer Relationship Management)** + **M42 (Product Information Management)** from the roadmap. P7 just shipped Revenue Ops (cards interface + commissions + reports + cases). The next gap is the data layer that operators reach for daily but currently live in spreadsheets / Xoro / memory: a sales pipeline + a single product information hub.

This is also the **last phase before P9 Parallel-Run** (the 2-month "live alongside Xoro" period before P10 Tenancy + the eventual Xoro decom). The two modules in this phase have to be solid enough that operators stop reaching for Xoro for customer history + product specs.

---

## 0. Scope guardrails

**In scope (this phase):**

### M25 — CRM
- **Activity log** per customer (notes, calls, emails-sent, meetings, deals-won — append-only).
- **Opportunities / leads** pipeline: `new → qualified → proposal → won / lost`. Per-opp value (expected_cents), probability, stage_changed_at, owner.
- **Tasks** per (customer | opportunity), with due date + assignee + status.
- **Linkable to existing entities** (ar_invoices, cases, sales_orders [M10 future], bank_transactions). Optional FKs only — CRM stays usable before SO module ships.
- **Outbound email send** via existing Resend (logs into activity log automatically).
- **Inbound email auto-log** via the Resend webhook P7-9 already added (cases@ stays; new contact@ adds to activity log).
- **Reports**: opportunity pipeline by stage, sales-velocity (avg time per stage), customer last-touched, my-tasks-due.

### M42 — PIM
- **Centralized product master** extending the existing `style_master` (P1) + `ip_item_master` (PO WIP / ATS) without duplicating either.
- **Image library** — `product_images` table referencing Supabase Storage; primary image + alternate angles + flat/lifestyle/spec; sort order.
- **Marketing copy** — `product_descriptions` (long, short, bullet1..5, seo_title, seo_description) per style × locale (locale=en-US for now; multi-locale infra ready for future).
- **Attribute schema per category** — `product_attribute_definitions` (category_id, attribute_key, type, options jsonb). Each style gets `product_attributes` (style_id, attribute_key, value jsonb). Examples: fit_type ∈ {slim, regular, relaxed}; rise ∈ {low, mid, high}; care_instructions.
- **Variants** roll up to style via existing matrix model (P1).
- **Print-ready outputs** (line sheets, spec PDFs) — JSONB layout configs + Puppeteer render endpoint.

**Explicitly OUT of scope (deferred):**
- **Email tracking / opens / clicks** — Resend's tracking is enabled per-message but we don't aggregate.
- **Lead scoring** — M46 BI in P24.
- **Marketing automation** (drip campaigns, segments) — separate from CRM; not for this phase.
- **PIM syndication** to Shopify / Amazon / Faire — M12 / M45 in P11+. PIM is just the source-of-truth in P8.
- **Multi-locale marketing copy** — schema supports it (locale column) but UI ships en-US-only.
- **Digital asset management beyond images** (videos, 3D models, swatches) — images only in v1.
- **PIM workflow / approval chains** — copy goes live the moment it saves. Approval can be added later via M27.
- **Color swatch master** — operator currently uses style_master's color attribute; centralizing into a swatch_master is M42 v2.

---

## 1. Existing state (one-paragraph map)

After P7: dual-basis GL + full close + 4 financial statements + bank recon + AR/AP + commissions + cases. `customers` exists from P1 with email/phone/billing/shipping addresses. `customer_users` from P2 maps to auth.users for portal access (M40 future). **No CRM activity log, no opportunities, no tasks** — operator manages prospects on a Google Sheet + Outlook. `style_master` (P1) is the canonical style record; `ip_item_master` extends with variants. **No PIM image library, no marketing copy table, no attribute schema** — product info lives in Xoro descriptions + scattered Drive folders. Supabase Storage bucket already configured (P2-5) and serving Resend attachments, JE attachments, etc.

---

## 2. Decisions (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Opp pipeline stages | **`new` / `qualified` / `proposal` / `won` / `lost`** (5 stages, no sub-stages) | Apparel B2B is short-cycle; 5 stages is enough. Operator can add later via D7. | ☐ |
| D2 | Activity log ownership | **Append-only, immutable**, soft "hidden" flag only | Audit trail for accountant + future legal; mirror P5 close audit pattern. | ☐ |
| D3 | Task assignee | **`auth.users.id` only** (internal staff); no external assignee in v1 | Customers don't get tasks in v1; that's a portal future. | ☐ |
| D4 | Email auto-log inbound | **Reuse the Resend inbound webhook from P7-9** (cases@) + add new `contact@<domain>` for general inbound that lands in activity log | Avoids a second webhook. cases@ → cases; contact@ → activity log. | ☐ |
| D5 | PIM image storage | **Supabase Storage bucket** `pim-images` (separate from JE/case attachments). Path: `<entity_id>/<style_id>/<image_id>.{ext}`. Public read via signed URL. | Existing pattern. Separate bucket = independent retention policy + access rules later. | ☐ |
| D6 | PIM image processing | **Operator uploads original; server generates 3 sizes** (thumbnail 200px, web 800px, print 2400px) via Sharp in the upload handler | Server-side for consistency; Sharp already in deps from Tech Packs. | ☐ |
| D7 | PIM attribute schema source | **Per-category, mutable by accountant + design** — `product_attribute_definitions` is just a master table with no migration required to add a new attribute | Avoids schema churn every time apparel ops adds "lining" or "thread count". | ☐ |
| D8 | PIM publish status | **`draft` / `published`** per style × locale, with `published_at` + `published_by_user_id` audit | Lets design iterate without exposing half-written copy via search / future ecom feeds. | ☐ |
| D9 | CRM panel nav location | **New top-nav group `🤝 CRM`** holding Opportunities, Activities, Tasks, Pipeline Report. (Customer Master stays in 📚 Master Data.) | CRM is its own workflow; nesting under Master Data hides it. | ☐ |
| D10 | PIM panel nav location | **Extend the existing 📚 Master Data group** with "Product Catalog" (PIM landing page that drills into per-style detail) | Same target audience (design ops); avoids dropdown count creep. | ☐ |

---

## 3. M25 — CRM schema

### 3.1 `crm_opportunities` (new)

```sql
CREATE TABLE IF NOT EXISTS crm_opportunities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_number   text NOT NULL,                     -- 'OPP-YYYY-NNNNN'
  title                text NOT NULL,
  stage                text NOT NULL DEFAULT 'new'
                       CHECK (stage IN ('new','qualified','proposal','won','lost')),
  stage_changed_at     timestamptz NOT NULL DEFAULT now(),
  expected_cents       bigint CHECK (expected_cents IS NULL OR expected_cents >= 0),
  probability_pct      smallint NOT NULL DEFAULT 50 CHECK (probability_pct BETWEEN 0 AND 100),
  expected_close_date  date,
  actual_close_date    date,
  loss_reason          text,
  owner_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  description          text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT crm_opp_number_per_entity_unique UNIQUE (entity_id, opportunity_number)
);

CREATE INDEX IF NOT EXISTS idx_crm_opp_stage     ON crm_opportunities (stage);
CREATE INDEX IF NOT EXISTS idx_crm_opp_customer  ON crm_opportunities (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_owner     ON crm_opportunities (owner_user_id) WHERE owner_user_id IS NOT NULL;
```

### 3.2 `crm_activities` (new, append-only)

```sql
CREATE TABLE IF NOT EXISTS crm_activities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id       uuid REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  case_id              uuid REFERENCES cases(id) ON DELETE SET NULL,   -- M47 link
  activity_type        text NOT NULL
                       CHECK (activity_type IN ('note','call','email_in','email_out','meeting','task_done','stage_change','system')),
  subject              text NOT NULL,
  body                 text,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  duration_minutes     int,                                -- for calls / meetings
  external_email       text,                               -- inbound sender (Resend webhook)
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb, -- raw Resend payload / stage-change details
  is_hidden            boolean NOT NULL DEFAULT false,     -- soft hide; row stays for audit
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_act_customer   ON crm_activities (customer_id, occurred_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_act_opp        ON crm_activities (opportunity_id, occurred_at DESC) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_act_type_date  ON crm_activities (activity_type, occurred_at DESC);
```

Append-only via RLS — service-role can INSERT + UPDATE only `is_hidden` flag; nothing else mutable.

### 3.3 `crm_tasks` (new)

```sql
CREATE TABLE IF NOT EXISTS crm_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id       uuid REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  title                text NOT NULL,
  description          text,
  due_date             date,
  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','done','cancelled')),
  priority             text NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('low','normal','high','urgent')),
  assignee_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at         timestamptz,
  completed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT crm_task_title_nonempty CHECK (char_length(trim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_assignee_open
  ON crm_tasks (assignee_user_id, due_date)
  WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS idx_crm_tasks_customer
  ON crm_tasks (customer_id) WHERE customer_id IS NOT NULL;
```

### 3.4 Activity-log triggers

Auto-log opportunity stage changes (`stage_change` activity row inserted by AFTER UPDATE trigger). Same for task completion. Pattern mirrors P5 close audit log.

---

## 4. M25 — RPCs + handlers

| Endpoint | Purpose |
|---|---|
| `GET /api/internal/crm/opportunities?stage=&owner_id=&q=` | List with filters |
| `POST /api/internal/crm/opportunities` | Create (auto-generates OPP-YYYY-NNNNN) |
| `GET/PATCH/DELETE /api/internal/crm/opportunities/:id` | Single |
| `POST /api/internal/crm/opportunities/:id/stage` body `{stage, reason?}` | Stage change (RPC `crm_opp_change_stage` writes activity log + updates row atomically) |
| `GET /api/internal/crm/activities?customer_id=&opportunity_id=&from=&to=` | List filtered |
| `POST /api/internal/crm/activities` body `{type, subject, body, customer_id?, opportunity_id?, occurred_at?, ...}` | Manual log entry |
| `PATCH /api/internal/crm/activities/:id` body `{is_hidden}` | Soft hide (audit-only mutation) |
| `GET /api/internal/crm/tasks?assignee_user_id=&status=&due_before=` | List filtered |
| `POST /api/internal/crm/tasks` | Create |
| `GET/PATCH/DELETE /api/internal/crm/tasks/:id` | Single |
| `GET /api/internal/crm/pipeline-report` | Aggregate: count + sum(expected_cents × probability_pct/100) per stage |

Plus extend the Resend inbound webhook (P7-9 added) — if `to` matches `contact@<domain>`, log to crm_activities (type=`email_in`) with customer lookup via `from` email.

---

## 5. M42 — PIM schema

### 5.1 `product_categories` (new)

```sql
CREATE TABLE IF NOT EXISTS product_categories (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  parent_category_id   uuid REFERENCES product_categories(id) ON DELETE RESTRICT,
  code                 text NOT NULL,
  name                 text NOT NULL,
  sort_order           int  NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_categories_code_per_entity_unique UNIQUE (entity_id, code)
);
```

Three-level taxonomy (Category > SubCategory > Style-Type) supported via self-FK. Existing ATS / PO WIP category strings get mapped to category_id during the M42 migration.

### 5.2 `product_attribute_definitions` (new)

```sql
CREATE TABLE IF NOT EXISTS product_attribute_definitions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  category_id          uuid REFERENCES product_categories(id) ON DELETE CASCADE,
  attribute_key        text NOT NULL,             -- 'fit_type', 'rise', 'care_instructions'
  label                text NOT NULL,             -- 'Fit'
  value_type           text NOT NULL CHECK (value_type IN ('enum','number','text','boolean','date')),
  options              jsonb,                     -- enum: {"options":["slim","regular","relaxed"]}
  is_required          boolean NOT NULL DEFAULT false,
  sort_order           int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pad_unique_per_category UNIQUE (entity_id, category_id, attribute_key)
);
```

### 5.3 `product_attributes` (new, per-style values)

```sql
CREATE TABLE IF NOT EXISTS product_attributes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id             uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  attribute_key        text NOT NULL,
  value                jsonb NOT NULL,            -- {"value":"slim"} or {"value":42}
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT pa_unique_per_style UNIQUE (style_id, attribute_key)
);

CREATE INDEX IF NOT EXISTS idx_pa_style ON product_attributes (style_id);
```

### 5.4 `product_descriptions` (new)

```sql
CREATE TABLE IF NOT EXISTS product_descriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id             uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  locale               text NOT NULL DEFAULT 'en-US',
  short_description    text,
  long_description     text,
  bullet_1             text,
  bullet_2             text,
  bullet_3             text,
  bullet_4             text,
  bullet_5             text,
  seo_title            text,
  seo_description      text,
  publish_status       text NOT NULL DEFAULT 'draft' CHECK (publish_status IN ('draft','published')),
  published_at         timestamptz,
  published_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT pd_unique_per_style_locale UNIQUE (style_id, locale)
);
```

### 5.5 `product_images` (new)

```sql
CREATE TABLE IF NOT EXISTS product_images (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id             uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  image_kind           text NOT NULL DEFAULT 'flat' CHECK (image_kind IN ('flat','lifestyle','spec','swatch','other')),
  storage_path         text NOT NULL,             -- pim-images/<entity>/<style>/<id>.jpg
  storage_path_thumb   text,                      -- 200px
  storage_path_web     text,                      -- 800px
  storage_path_print   text,                      -- 2400px
  alt_text             text,
  sort_order           int NOT NULL DEFAULT 0,
  is_primary           boolean NOT NULL DEFAULT false,
  mime_type            text,
  bytes                bigint,
  width                int,
  height               int,
  uploaded_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pi_primary_unique_per_style EXCLUDE (style_id WITH =) WHERE (is_primary = true)
);

CREATE INDEX IF NOT EXISTS idx_pi_style ON product_images (style_id, sort_order);
```

`EXCLUDE` constraint ensures only one `is_primary=true` per style.

---

## 6. M42 — RPCs + handlers

| Endpoint | Purpose |
|---|---|
| `GET /api/internal/pim/categories` | Tree (parent_id-self join, depth-limited) |
| `POST/PATCH /api/internal/pim/categories[/:id]` | CRUD |
| `GET /api/internal/pim/attribute-defs?category_id=` | List attribute definitions for a category |
| `POST/PATCH /api/internal/pim/attribute-defs[/:id]` | CRUD |
| `GET /api/internal/pim/styles/:style_id` | One style with all PIM data merged: attributes + descriptions + images |
| `PATCH /api/internal/pim/styles/:style_id/attributes` body `{attribute_key, value}` | Upsert one attribute |
| `PATCH /api/internal/pim/styles/:style_id/description?locale=en-US` | Upsert description (saves as draft; separate publish action) |
| `POST /api/internal/pim/styles/:style_id/description/publish` | Flip publish_status to published + stamp published_at |
| `GET /api/internal/pim/styles/:style_id/images` | List |
| `POST /api/internal/pim/styles/:style_id/images` (multipart) | Upload + Sharp processing → 3 sizes + thumbnails saved to pim-images bucket; row inserted |
| `PATCH /api/internal/pim/images/:id` | Update sort_order / is_primary / alt_text / image_kind |
| `DELETE /api/internal/pim/images/:id` | Soft delete (set is_primary=false, mark row, remove from storage async) |

---

## 7. Cross-cutter hooks (M27 / M28 / M29 recap)

- **M27 Approvals**: optional opp won → approval required (per-entity policy). PIM published changes can require approval per-category. Reuses P3 approval gate pattern.
- **M28 Notifications**: task assigned to user / task due tomorrow / opp stage change to lost / opp expected close date overdue.
- **M29 Documents**: nothing new — PIM images live in Supabase Storage natively; CRM doc attachments go through the existing `documents` cross-cutter from P2.

---

## 8. RLS

Standard P1 template applied to all 9 new tables (3 CRM + 5 PIM + 1 categories):
- `anon_all` SELECT-only (filtered through service-role API for sensitive cols like email).
- `auth_internal_*` SELECT+INSERT+UPDATE for `entity_users` whose `auth_id = auth.uid()`.
- `crm_activities` adds an INSERT-only policy (no UPDATE except `is_hidden`, no DELETE).
- `crm_tasks` adds an "assignee + creator can edit" policy so a user can manage their own queue.

---

## 9. Chunk split (implementation — DO NOT start until operator confirms §2 decisions)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **P8-1** | M25 schema | 3 tables (opportunities + activities + tasks) + triggers + RLS. | — |
| **P8-2** | M25 handlers + RPC (opp stage-change writes activity log) | ~12 handlers; one RPC; tests. | P8-1 |
| **P8-3** | M25 UI — Opportunities + Activities + Tasks panels + Pipeline Report | 4 new InternalCRM*.tsx panels under new 🤝 CRM nav group. Each gets ExportButton. | P8-2 |
| **P8-4** | M25 Resend `contact@` extension | Extend the P7-9 webhook to also route contact@ → crm_activities. | P8-1 |
| **P8-5** | M42 schema | 5 tables (categories + attr defs + attr values + descriptions + images) + RLS + the pim-images storage bucket. | — (parallel-safe to P8-1) |
| **P8-6** | M42 handlers — categories + attr defs + attr values + descriptions | ~10 handlers; tests. | P8-5 |
| **P8-7** | M42 image upload handler + Sharp processing pipeline | Multipart upload → Sharp resize × 3 → Storage write → row insert. | P8-5 |
| **P8-8** | M42 UI — Product Catalog panel (list) + per-style detail editor (tabs: Attributes / Description / Images) | New panels under 📚 Master Data. | P8-6, P8-7 |
| **P8-9** | User guide chapter 19 (CRM) + chapter 20 (PIM) + memory close-out | Doc + cross-cutter wiring (M28 task-due-tomorrow cron, opportunity-stage-change notify). | All above |

Parallel waves:
- **Wave A (after operator confirms §2):** P8-1 + P8-5 simultaneously.
- **Wave B:** P8-2 + P8-6 + P8-7 simultaneously.
- **Wave C:** P8-3 + P8-4 + P8-8 simultaneously.
- **Wave D:** P8-9.

---

## 10. Risks

- **Activity log immutability.** Append-only is hard to enforce via RLS alone if the service-role bypasses it. Mitigation: explicit trigger that rejects UPDATEs touching any column except `is_hidden`. Pattern reused from P5 close audit.
- **PIM image upload size.** Operator may upload 20MB Photoshop exports; need to cap at ~10MB pre-Sharp and reject 4K+ resolutions to keep storage costs sane. Sharp can resize-down on the fly but the original is preserved at the "print" size (2400px).
- **Category remapping on M42 ship.** Existing styles have category strings (ATS / PO WIP); P8-5 must map them to product_categories.id. A best-effort migration script + an "unmapped" inbox for design-ops to clean up.
- **PIM published → ecom feed timing (future).** M12 Shopify ingest will read PIM. We need a "published_at since" filter. Index ready.
- **CRM and M47 cases overlap.** A case is a customer-service ticket; a CRM activity is a touchpoint log. They CAN reference each other (`crm_activities.case_id`) but the operator workflow needs clear separation. UI guideline: case detail shows "Open in CRM" link; CRM activity shows "Linked case" badge.
- **No SO module yet.** P8 CRM references `sales_orders` via a column reserved for M10 (P16). The handler treats null SO references as "fine, render as N/A" — no enforcement until M10 ships.

---

## 11. Tests

- CRM stage-change RPC: write race-condition (two stage changes within 1s emit two activity rows; idempotency key prevents duplicates if same payload).
- Activity log immutability: UPDATE attempts on non-`is_hidden` columns fail; DELETE fails.
- Task auto-complete trigger: setting `status='done'` populates `completed_at` + `completed_by_user_id`.
- PIM attribute value validation: enum-type with value not in `options.options` is rejected at handler.
- PIM image upload: Sharp resizing produces 3 sizes; primary flag uniqueness enforced.
- Inbound email auto-log: contact@ vs cases@ routes to correct table; bad signature rejected.

---

## 12. Operator confirm before chunks ship

Please mark §2 D1–D10 with answers (or push back). Once those are confirmed I'll kick off P8-1 + P8-5 in parallel.

**No env vars needed.** Resend secret + Supabase Storage already configured.

**Estimated lift:** ~4-5 days end-to-end. Wave A + Wave B can each finish in ~half a day with parallel agents. Wave C is the heaviest (3 UI panels with image upload UX). Wave D is doc-only.
