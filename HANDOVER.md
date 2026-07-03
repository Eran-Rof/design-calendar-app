# HANDOVER — design-calendar-app

_Refreshed **2026-06-29** (original 2026-06-03). Items not verifiable from code are
marked **(inferred)**. **Read the persistent memory first** — see §0._

---

## 0. Read this first — the memory IS the canonical handover

A file-based memory lives at
`~/.claude/projects/<this-project>/memory/`. `MEMORY.md` is the **index** and is
**auto-loaded every session** — read it before doing anything; each linked topic file
is one fact (architecture truth, gotcha, or workflow rule). **After any change, update
the user manual + add/refresh a memory file** (non-negotiable). This document orients a
new contributor; the memory is the living truth.

---

## 1. Project overview

`design-calendar-app` is a React 18 + TypeScript + **Vite** single-page app hosting
RoF Clothing's apparel **PLM + ERP** suite, on **Supabase** (Postgres + Auth + RLS) and
deployed on **Vercel**. One launcher (`src/PLM.tsx`) fronts ~11 apps — **Design
Calendar, PO-WIP/TandA, TechPack, ATS** (availability-to-sell planning), **Costing,
GS1/GTIN, Inventory Planning, the Tangerine ERP**, plus the external **Vendor Portal**
and **B2B** portal. It is mid-build of **Tangerine**, the multi-phase ERP replacing the
legacy **Xoro** ERP; POs/inventory/costing/invoices sync from Xoro while Tangerine grows
native `purchase_orders` / `sales_orders` / GL / AR / AP / inventory. Per
`docs/tangerine/BUILD-PROGRESS.md` the financially-hard half (dual-basis GL, FIFO
inventory, AR backfill, revenue integrations) is done; recent work is operator-driven
feature polish.

## 2. Architecture

**Stack:** React 18 + TS + Vite · Zustand · react-router-dom · recharts · TipTap ·
`xlsx`/`xlsx-js-style` · `@anthropic-ai/sdk` · Supabase JS + `pg` · Vercel serverless
(Node) · `sharp`/`formidable` (uploads) · Resend (email).

**Frontend — `src/`, by app:**
- `src/tanda/` — **Tangerine ERP** panels: `Internal*.tsx` (SalesOrders, PurchaseOrders,
  ARInvoices, InventoryMatrix, InventoryTransfers, InventoryAdjustments, ThreePL,
  MfgBuildOrders, Customer/Vendor/Employee masters, GL/JE, …) + `src/Tangerine.tsx`
  (shell + nav). Shared widgets in `src/tanda/components/` (SearchableSelect,
  ContactList, RowHistory, TablePrefs, DateRangePresets, QuickAdd*Modal,
  EmailSOConfirmationModal…).
- `src/ats/` — ATS planning grid (one of the densest areas). `src/costing/`,
  `src/gs1/`, `src/inventory-planning/`, `src/vendor/`, `src/b2b/`, `src/dc/` (Design
  Calendar). `src/shared/` — cross-app primitives (`matrix/EditableSizeMatrix`,
  `ui/warn` = `notify`/`confirmDialog`/`WarnHost`, `documents/`).
- `src/lib/menuKeys.ts` + `src/PLM.tsx` — app registry, routing, per-user gating.

**Backend — `api/`** with **dispatch indirection**: real handlers in
`api/_handlers/**`; **`api/_handlers/routes.manifest.js`** maps URL→handler;
**`routes.js` is generated** (`npm run gen:routes`) — never hand-edit. Inside a handler
read **`req.query.id`** (not `params.id`). Shared libs in `api/_lib/` (auth, accounting/
posting, inventory FIFO, notifications, documents, `resolveUserNames`, autoCode…).

**DB** — Supabase Postgres; timestamped migrations in `supabase/migrations/`
(latest at refresh: `20260925000000`). RLS-gated; service role bypasses for
crons/admin. Schema ref: **`docs/tangerine/CURRENT-SCHEMA.md`** (read before SQL).

**Deploy** — Vercel (two prod deploys/commit: the app + the Tangerine demo). Migrations
**auto-apply on merge to `main`** via supabase-db-push. CI `test` job = vitest +
typecheck-ratchet + menuKeys registry-sync + migration-filename/COMMENT lints.

## 3. Working in this repo (the loop that works)

1. **Isolated worktree off `origin/main`** — `git fetch origin` **first** (stale local
   `origin/main` bases you off old code — this has bitten us):
   `git worktree add -b feat/x /c/tmp/x origin/main`.
2. **node_modules** — junction to the shared install, don't reinstall per worktree:
   `cmd //c "rmdir C:\tmp\x\node_modules"` then
   `cmd //c "mklink /J C:\tmp\x\node_modules C:\tmp\lot-wt\node_modules"`.
   ⚠️ **NEVER `rm -rf node_modules`** in a worktree — it follows the junction and wipes
   the shared `c:/tmp/lot-wt/node_modules`. Drop junctions with `cmd rmdir`; recover a
   nuked share with `npm ci` in `c:/tmp/lot-wt`.
3. **Verify locally** (CI is the authority, but check):
   - `node scripts/typecheck-ratchet.mjs` → must say **"0 new"** (it's `tsc -b` vs a
     baseline; plain `tsc -p tsconfig.json` is a no-op).
   - `node node_modules/vite/bin/vite.js build` → **catches bad imports + filename
     case-collisions tsc misses.** Green typecheck ≠ green build; run both.
   - Migration lints (when adding SQL): vitest `migrations-naming-lint` +
     `migrations-comment-concat-lint`.
4. **Ship** (auto-merge culture, no review gate): commit (footer
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`), push,
   `gh pr create` (gh authed in **Bash**), **front-load `#NNN` in the PR title**,
   `gh pr merge <N> --squash --auto`. Always squash. Merges when the **`test`** check
   is green; confirm the **Vercel** build too if a build-only failure is plausible.

**Ship gotchas:**
- An **auto-merge-armed PR is FROZEN** — new commits to it are orphaned on squash; use a
  fresh branch for follow-ups.
- **Two PRs editing the same file** → the second goes `DIRTY` after the first merges.
  Wait for the first to merge then branch off fresh main, or chain off its branch.
  (Tangerine SO/PO panels are huge single files — expect this.)
- **Migrations auto-apply on merge** — idempotent, all-digit unique timestamps (no
  uppercase), **single-string `COMMENT`** (no `||`), version **after** the latest.
- **Prod SQL probe:** `node scripts/run-sql-prod.mjs <file.sql>` (Mgmt API,
  `SUPABASE_PAT` in `.env.local`). Probe before iterating; read `CURRENT-SCHEMA.md`.

## 4. Conventions & gotchas (full set in memory)

- **Admin** = `!!getCachedAuthUserId()` (`src/utils/tangerineAuthUser`). Gate
  add-on-the-fly actions; non-admins get a warning.
- **`notify(text, kind)`** kinds are **`success | error | info`** only — no `"warning"`
  (tsc fails). UI rules: dark dropdowns (app colors), **no decorative emoji**, US
  `MM/DD/YYYY` dates, universal Export button, responsive modals (no raw UUIDs shown),
  date pickers get presets, factored `confirmDialog`/`notify` (no raw `confirm`/`alert`).
- **Routes** are data-driven (`routes.manifest.js` + `gen:routes`, append-only).
  `menuKeys.ts` and `api/_lib/menuKeys.js` key sets must stay identical (sync test).
- **Wording — Warehouse vs Store:** Tangerine has **warehouses + brands (+ channels),
  no ROF "sales stores."** Any ROF inventory/order location = **Warehouse**
  (`inventory_locations` kind=warehouse); only *customer* ship-to and *Shopify* stores
  keep "Store." SO `sale_store` is the order's Warehouse, sourced from the warehouses
  master.
- **PostgREST** ~1000-row silent cap (paginate or RPC). `.in(...)` URL-length → chunk to
  ~100 ids.
- **Gated/inert:** `RBAC_MODE`, `BRAND_SCOPE_MODE` built but OFF in prod.

## 5. State at refresh (2026-06-29)

Recent merged work (operator-driven SO / inventory / manufacturing run, PR #s):

- **Sales Orders** (#1457–#1463, #1471, #1472, #1474): quick-add customer/vendor
  (typeahead, on-the-fly + "complete-the-info" notification), warehouse + multi-status
  filters, payment-terms autofill, editable header on saved orders, prepack
  per-each→pack price + inline "Add prepack matrix", **email SO confirmation**
  (`POST /api/internal/sales-orders/:id/email-confirmation`, Resend + doc attachments),
  cancel<ship guard, always-visible add-style buttons with click warnings, on-the-fly
  customer `customer_code` NOT-NULL fix, SO **Warehouse** field sourced from the
  warehouses master (legacy names reconciled, mig 20260925).
- **Inventory** (#1464/#1465/#1468): adjustment +/- direction selector + confirm,
  reason name-only/required/add-on-the-fly (admin); transfers + adjustments who/when
  columns + user filter; wider transfer matrix.
- **3PL** (#1466): provider edit modal — up to 8 contacts (title+department), notes +
  T11 audit trail on `tpl_providers`.
- **Build Orders** (#1467/#1469/#1470): delete with BOM-attached warning; add-style-on-
  the-fly (admin) → style + buildable SKU via a **size scale** picker.
- **Store→Warehouse sweep** (#1458 Inventory Matrix, #1472/#1474 SO, #1473 ATS).

> ⚠️ **The local checkout usually sits on a stale feature branch** (e.g.
> `fix/normalize-sku-bare-hyphen`) with possible stray WIP, and there are many leftover
> worktrees under `c:/tmp/*` and `.claude/worktrees/*`. **Judge "does X exist" against
> `origin/main`** (`git show origin/main:<path>`), never the local working copy.

## 6. Outstanding / next _(inferred — confirm)_

- Finish remaining Tangerine phases per `docs/tangerine/BUILD-PROGRESS.md` (P13
  procurement receiving→GL/3-way match is the big deferred GL-critical epic; then later
  phases and Xoro decommission).
- Go-live config (operator, not code): tag a Production Manager + link PLM login (RFQ
  award notifications); vendor portal logins; prepack matrices; by-size opening-balance
  replacement at cutover.
- Flag flips when business-ready: `RBAC_MODE`, `BRAND_SCOPE_MODE`.
- See `docs/OPERATOR-TODO.md`.

## 7. Guardrails

- **GL posting, FIFO inventory, allocations, costing/pricing, on-hand quantities are
  financially material** — confirm business rules before changing; flows are dual-basis
  and order-sensitive. **When a symptom has multiple causes, probe (one diagnostic SQL)
  — don't guess.**
- No destructive DB/migration ops on prod/staging without confirmation (prod ref
  `qcvqvxxoperiurauoxmp`); migrations are additive + idempotent.
- Never commit secrets — keys live in Vercel/Supabase env;
  `VENDOR_DATA_ENCRYPTION_KEY` guards PII/bank/ERP fields.
- The user is the **CEO, not a DB admin** — give copyable steps/drafts, not raw admin
  commands. Confirm both CI (`test`) and the Vercel build are green before calling a
  change shipped.
