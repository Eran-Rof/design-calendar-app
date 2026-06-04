# HANDOVER — design-calendar-app

_Generated 2026-06-03 by inspecting the repo. Items I could not verify from the
code are marked **`> ⚠️ NEEDS HUMAN INPUT`** or **(inferred)** — please correct._

---

## Project overview

`design-calendar-app` is a React + Vite single-page app that hosts an entire
apparel PLM + ERP suite for Ring of Fire Clothing, backed by Supabase
(Postgres + Auth + RLS) and deployed on Vercel. It bundles ~9 internal apps
behind one launcher — **Design Calendar, PO-WIP/TandA, TechPack, ATS
(availability-to-sell planning), Costing, GS1/GTIN, Inventory Planning, the
Tangerine ERP**, plus an external **Vendor Portal** and **B2B wholesale portal**
(separate Supabase auth pools). It is mid-build of "**Tangerine**," a 25-phase
ERP intended to replace the legacy **Xoro** ERP; POs/inventory/costing/invoices
currently sync nightly from Xoro. Per `docs/tangerine/BUILD-PROGRESS.md` it is
**~64% by phase / ~63% by module**, with the financially-hard half (dual-basis
GL, FIFO inventory, AR backfill, three revenue integrations) done and the
remaining phases lighter but numerous.

---

## Architecture

**Stack:** React 18 + TypeScript + Vite SPA · Zustand (state) · react-router-dom ·
recharts · TipTap (rich text) · `xlsx`/`xlsx-js-style` (Excel) · `@anthropic-ai/sdk`
(in-app AI) · Supabase JS + `pg` · Vercel serverless functions (Node) · `sharp`,
`formidable` (uploads).

**Frontend** — `src/`, organized by app:
- `src/ats/` — ATS planning grid (availability-to-sell, sales comps, PO-WIP sync). One of the largest, densest areas.
- `src/tanda/` — Tangerine ERP internal panels: `Internal*.tsx` (Customer/Vendor/Employee masters, Sales/Purchase Orders, AR/AP, GL/JE, Inventory Matrix, etc.) + `src/Tangerine.tsx` (the ERP shell + nav: `NAV_SECTIONS`/`GroupKey`/`ModuleDef`).
- `src/costing/` — Costing app (standalone at `/costing`): `panels/CostingGrid.tsx`, `views/{ProjectListView,ProjectEditView,RfqListView,RfqEditView,SettingsView}.tsx`, `panels/*PickerCell.tsx`, `store/costingStore.ts`, `services/costingApi.ts`.
- `src/vendor/` — Vendor Portal (`/vendor`): POs, shipments, invoices, payments, compliance, **RFQs** (`rfqs/VendorRfqs.tsx`, `VendorRfqDetail.tsx`), onboarding.
- `src/b2b/` — B2B wholesale portal (`/b2b`).
- `src/inventory-planning/` — wholesale inventory planning.
- `src/shared/` — cross-app primitives: `matrix/` (size matrix incl. `EditableSizeMatrix`), `documents/` (`DocumentAttachmentList`/`uploadDocument`), `ui/warn.tsx` (`notify`/`confirmDialog`/`WarnHost`).
- `src/components/notifications/` — the in-app notification bell/list (`NotificationsShell`, `useAppUnreadCount`, `notificationApps.ts`).
- `src/lib/menuKeys.ts`, `src/PLM.tsx`/`src/main.tsx` — app registry + path routing + per-user app/route gating (RBAC).

**Backend** — `api/` Vercel functions with **dispatch indirection**: the real
handlers live in `api/_handlers/**` (e.g. `api/_handlers/internal/...`), the
top-level `api/*` files are thin dispatchers, and `api/routes.js` is an
**append-only** registry (`hNNN`). Shared logic in `api/_lib/` (auth,
notifications, accounting/posting, inventory FIFO, xoro-mirror, internal-recipients,
autoCode, workflow). `scripts/` holds dev/staging/deploy helpers.

**Backend data** — Supabase Postgres, **258 migrations** in
`supabase/migrations/` (timestamped `YYYYMMDDHHMMSS_*.sql`). RLS-gated; service
role bypasses RLS for crons/admin handlers. `docs/CURRENT-SCHEMA.md` is the
schema reference; `docs/MIGRATIONS.md` documents the apply flow.

**Deployment** — Vercel. Two prod deploys per commit: **`Vercel – design-calendar-app`**
(the app) and **`Vercel – tangerine-app-demo`**. Migrations auto-apply on merge to
`main` via the **supabase-db-push** automation. CI runs a `test` job (vitest +
type-check + a menuKeys registry-sync test + migration-filename lint).

---

## Data model

The schema is large (apparel + full ERP). Authoritative reference:
**`docs/CURRENT-SCHEMA.md`** (read it before writing SQL). Central tables/relationships:

- **Tenancy/GL:** `entities` (multi-entity; `rof_entity_id()`), `gl_accounts` (chart of accounts, incl. per-brand child accounts `{code}-{BRAND}`), `journal_entries`/`_lines` (dual-basis ACCRUAL+CASH).
- **Items/inventory:** `ip_item_master` (SKUs; `style_id`, `color`, `size`, `attributes` jsonb from ATS), `style_master` (+`size_scale_id`), `size_scales`, `inventory_layers` (FIFO; `source_kind` ∈ opening_balance | xoro_mirror_snapshot | adjustment | **xoro_rest_size** | …), `ip_inventory_snapshot` (planning on-hand), `v_inventory_available`.
- **Xoro PO mirror:** `tanda_pos` (PK `uuid_id`; legacy bigint `id`), `po_line_items`.
- **Sales/AR/AP:** `sales_orders`/`_lines` (M10/M18 allocation), `ar_invoices`/`ap_invoices`/payments, factoring, commissions.
- **Costing→RFQ:** `costing_projects` → `costing_lines` (`selected_vendor_quote_id`) → `costing_line_vendors`; **`rfqs`** → `rfq_invitations` (vendor) / `rfq_line_items` (now carry `costing_line_id`, style/color mirrors) → **`rfq_quotes`**/`rfq_quote_lines`. `rfqs.source_costing_project_id` back-links to costing.
- **Masters:** `customers`, `vendors` (+`vendor_users` portal logins), `employees` (+`apps text[]` for in-app notification routing, `metadata.plm_user_id` link), `brand_master`, `fabric_codes`, `payment_terms`, gender/country/classification masters, **`prepack_matrices`/`prepack_matrix_sizes`** (PPK explode driver).
- **Notifications:** two coexisting schemas — older `notifications` (recipient by `recipient_internal_id` app_data-user slug / `recipient_auth_id` / email) and Tangerine `notification_events`/`notification_dispatches`/`notification_preferences`.

> ⚠️ NEEDS HUMAN INPUT: confirm `docs/CURRENT-SCHEMA.md` is current vs the 258 migrations (it's hand-maintained).

---

## Integrations

**Xoro ERP (legacy, being replaced):**
- App-side: `api/xoro-proxy.js` proxies the Xoro REST API using `VITE_XORO_API_KEY` + `VITE_XORO_API_SECRET`. (Proxy sets `no-store` to dodge a 304-cache bug.)
- **The nightly ingestion pipeline lives in a SEPARATE project**, not this repo:
  `C:\Users\Eran.RINGOFFIRE\code\rof_xoro_project` (Python; 21:00 nightly via Mac launchd + Windows Task Scheduler, login `ebitton`). It pulls Xoro REST **inventory / master / item-costing / invoices** → CSVs in `.launchd-logs/` and Dropbox → into the app via sync handlers.
- Data flow into this app: `rof_xoro_project` REST pull → `rest_to_ats_inventory.py` (collapses per-**size** REST data to **color** grain to match the legacy ATS contract) → ATS upload + `/api/master/sync`, `/api/sales/sync-invoices`, and `api/_lib/planning-sync.js` write `ip_item_master` / `ip_inventory_snapshot` (color grain). The Tangerine Inventory Matrix's on-hand sits in `inventory_layers`.
- **Key nuance:** the REST feed HAS per-size on-hand; it is deliberately collapsed to color for the other apps. A Tangerine-only "by-size" path (`tangerine_size_onhand` + `xoro_rest_size` layers, `scripts/ingest-size-onhand.mjs`) was added so the Inventory Matrix shows real per-size quantities, warehouse-segmented (ROF Main / ECOM / Psycho Tuna).

**Excel ingestion:** `xlsx`/`xlsx-js-style` throughout — ATS upload (gzipped combined CSVs to dodge Vercel 413), the browser **Item Master uploader** (`buildItemRow`, the only writer that sets `ip_item_master.size`), the universal `ExportButton`, and the Costing **prepack matrix** Excel template download + upload.

**Other:** Resend (email), MS Graph (Teams/Outlook, TandA), SeaRates (containers), OpenExchangeRates/ECB (FX), Shopify/marketplaces (demand + COGS), Dropbox (doc mirror), EDI webhooks, APNS/FCM (push). All feature-gated by env vars (see README §3).

---

## Build, test & deploy

| Command | What |
|---|---|
| `npm run dev` | Vite dev server (frontend). |
| `npm run dev:api` | local API server (`scripts/dev-api-server.mjs`). |
| `npm run build` | `vite build` (this is what Vercel runs). |
| `npm test` | `vitest run` — **the CI authority** (see gotcha). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run deploy` | build + `scripts/setup-vercel.mjs` + `vercel --prod --prebuilt`. |
| `npm run staging:*` | staging setup/smoke/reset (`scripts/staging-*.mjs`). |

**Workarounds / why they exist:**
- **CI `test` is the type-check authority.** Local `tsc`/`vitest` frequently can't run because work happens in **git worktrees with junctioned `node_modules`** that lack a resolvable `typescript` binary. Rely on the CI `test` check.
- **A green `test` does NOT guarantee a green build.** `test`/tsc miss certain bad named imports; **vite/rollup catches them at build time**, so a PR can pass `test` and still fail the `Vercel – design-calendar-app` deploy. **Always confirm BOTH checks green.** On Vercel failure: `npx vercel inspect <dpl_id> --logs`.
- **Case-collision footgun:** extensionless imports can resolve differently on Windows (case-insensitive, picks `.ts`) vs Vercel/Linux (case-sensitive). This broke local builds for `DateRangePresets.tsx` vs `dateRangePresets.ts` — fixed in HEAD commit `af9ee750`; prefer explicit extensions.
- **Migrations auto-apply on merge** (supabase-db-push). Keep DDL **idempotent**; use unique all-digit timestamps; **no uppercase letters in timestamps**; **no `||` concat inside COMMENT** (CI lint). Apply ad-hoc to prod with `supabase db query --linked --file <f>` from the main checkout.

---

## Known issues & gotchas

- **The local checkout is usually on a stale branch.** Right now it is on `feat/plm-unsaved-changes-warning` with **3 uncommitted migrations** in the worktree (`20260716110000_p13_c1_inventory_layer_po_receipt.sql`, `..120000_prepack_inner_pack_qty.sql`, `..130000_v_prepack_ppk_needed.sql`). **Never judge "does X exist" from local — check `origin/main`** (`git show origin/main:<path>` or a worktree off `origin/main`).
- **Runtime bugs aren't caught by CI** (type-check only). Recent examples burned us: dropdowns that opened but were **clipped by `overflow:hidden`** grid cells (fix: portal the popover), and a notification addressed to a non-existent recipient id that **silently never delivered**. Test interactive paths in the real app.
- **PostgREST limits:** ~1000-row silent cap on selects (paginate); `.in(...)` lists can blow the URL length → 400 (chunk to ~100 ids).
- **Two notification schemas + fragmented recipient identity** (`recipient_internal_id` app_data slug vs `recipient_auth_id` vs `employees`). In-app delivery to an employee requires linking them to a PLM login (`employees.metadata.plm_user_id`).
- **Gated/inert features:** `BRAND_SCOPE_MODE` (per-brand inventory/GL split) and `RBAC_MODE` are **built but OFF in prod** — code ships without changing behavior until flipped.
- **By-size inventory cutover is live but the `opening_balance` layers are SEED data** ("not final, redone at go-live"); the cutover is reversible via a saved manifest (`rof_xoro_project/.launchd-logs/by-size-batch-reversal-*.json`). It moved real on-hand, so treat re-runs carefully.
- **No `.env.example`** in the repo; env vars are documented in `README.md` §3 (and `docs/vendor-portal-auth-setup.md`).
- Auto-merge culture: PRs squash-merge on CI green with no review gate; `routes.js` is append-only (never regenerate); `menuKeys.ts` and `api/_lib/menuKeys.js` key sets must stay identical (registry-sync test).

---

## Recent work (from `git log`)

Most recent first (origin/main + local HEAD):
- **Build/PLM fixes:** `af9ee750` dateRangePresets case-collision build fix; `a43027e0` warn on unsaved User-Management changes; `#800` refresh session permissions on launcher mount; `#796/#798` per-user app card+route blocking.
- **P13 Procurement (in flight):** `#799` reconcile PO systems (dual receipt/commitment FK + native PO commitments) + the 3 uncommitted P13-C1 migrations.
- **M43 Pricing Engine:** `#792–#795` schema + unified engine + Price Lists/Promotions admin + SO/AR line price auto-fill + B2B repoint.
- **Costing overhaul (this session):** `#774` harden MasterPickerCell; `#776/#777` grid batch (multi-fabric, scale/fit/comment masters, comp presets, payment-terms + DDP, dark modal); RFQ Target-Cost/label/steppers; per-row document attachments; **dropdown portal fix**; RFQ backfilled-fields read-only; **the full costing↔vendor RFQ round-trip** (Send-to-Vendor publish, vendor nav, award→costing write-back, Award button + Production-Manager notify/email, employee `apps` in-app notification routing).
- **Inventory size-matrix:** `#786` prepack matrix driver + Explode-PPK; the by-size on-hand cutover (924 styles); `#787/#778/#775` universal column show/hide sweep.
- **Sales/HR:** `#785` unify Sales Reps into Employees (sales_reps now a derived shadow of sales-role employees); `#788/#789` Allocations Workbench + fill modes.

---

## Outstanding work / next steps _(inferred — please confirm)_

- **(inferred)** **Commit & push the 3 uncommitted P13 migrations** (or discard if superseded) — they're untracked locally and P13 is mid-build.
- **(inferred)** **Finish P13 Procurement** (receiving, customs/broker, 3-way match, recon inbox — partly landed in #799–#805); then **P17 Planning, P19 RMA, P20 Drop-ship, P21 3PL, P22 EDI, P23 Xoro decom, P24 Reporting, P25 Finance+API** per `docs/tangerine/BUILD-PROGRESS.md`.
- **(inferred)** **By-size go-live:** replace the placeholder `opening_balance` seed with the real opening balance at cutover; keep ATS color-grain untouched.
- **(inferred) Go-live config (operator, not code):** tag a **Production Manager** employee + link their PLM login + pick apps (for RFQ-award notifications); create **vendor portal logins** so vendors receive RFQs; populate **prepack matrices** (Excel) before Explode-PPK; configure dilution/commission GL + rates.
- **(inferred) Flag flips when business-ready:** `RBAC_MODE` (needs per-user JWT phase) and `BRAND_SCOPE_MODE`.
- See **`docs/OPERATOR-TODO.md`** for the maintained operator checklist.

> ⚠️ NEEDS HUMAN INPUT: the single highest-priority next task.

---

## Guardrails

- **High-impact ERP logic.** GL posting, FIFO inventory, allocations, costing/RFQ pricing, and on-hand quantities are financially material. **Confirm business rules before changing them**; many flows are dual-basis (accrual+cash) and order-of-operations sensitive.
- **Don't run destructive DB/migration commands against shared (prod/staging) environments without confirmation.** Migrations auto-apply on merge — keep them idempotent and additive; never drop/replace data on assumption. Prod ref: `qcvqvxxoperiurauoxmp`.
- **Never commit secrets.** All keys live in Vercel env / Supabase; the repo has no `.env`. `VENDOR_DATA_ENCRYPTION_KEY` guards bank/PAN/ERP-credential fields.
- **Confirm both CI checks (`test` + `Vercel – design-calendar-app`) are green** before considering a change shipped; runtime bugs slip past type-check.
- **Verify against `origin/main`, not the local branch.**

---

> ⚠️ NEEDS HUMAN INPUT: **Why is this handover happening?** (team transition, pause, new contributor?) — it shapes what the next agent should prioritize.
>
> ⚠️ NEEDS HUMAN INPUT: **Business-logic intent** for the gated flags — when should `RBAC_MODE` / `BRAND_SCOPE_MODE` be enforced, and what's the next Xoro-retirement area to cut over?
