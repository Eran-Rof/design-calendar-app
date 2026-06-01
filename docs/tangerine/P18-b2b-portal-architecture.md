# Tangerine P18 — B2B Customer-facing (Portal + Wholesale Website)

**Phase:** P18 (after P17 Planning). **Modules:** M40 B2B Customer Portal · M41 B2B Wholesale Website.
**Status:** architecture (this doc) + Chunk A foundation schema. Build proceeds chunk by chunk.

## Goal
An external, authenticated portal where wholesale buyers self-serve: browse the catalog at their wholesale price, place orders (which land as **draft sales orders** in the internal Sales Orders queue for staff review/confirm), and view their account (invoices, AR balance, reorder). Distinct from the internal staff app (MS-OAuth) — buyers are external customers.

## Locked decisions (operator, 2026-06-01)
1. **Auth = magic-link email** (Supabase Auth, passwordless). Staff pre-authorize a buyer's email in `b2b_accounts` (→ customer_id); on first login the Supabase `auth.users.id` binds to that row.
2. **Pricing = customer price-list table** (`b2b_price_list`): resolution most-specific first — customer_id match → customer_tier match → default (customer_id IS NULL). Placeholder until the real M43 Pricing Engine ships.
3. **MVP = full portal** (browse + order + account/invoices + reorder), delivered across the chunks below.

## Surface
A new app route `/b2b` (its own React entry/shell in the same Vite app, like the DC/ATS/GS1/Tangerine/TechPack cards) with **customer** Supabase Auth — NOT the staff MS-OAuth flow. Buyer session → `b2b_current_customer_id()` scopes everything.

## Security model (critical — outward-facing)
- Portal API endpoints (`/api/b2b/*`) ALWAYS derive `customer_id` from the verified buyer session (Supabase JWT → `b2b_accounts.auth_user_id`), **never** from client input.
- RLS (`b2b_current_customer_id()`) is defense-in-depth on `b2b_accounts` / `b2b_price_list`; portal reads of `sales_orders` / `ar_invoices` are filtered server-side by the session's customer_id.
- A buyer can only see/act on their own customer's catalog-prices, orders, and invoices. `can_place_orders` / `role` gate write actions.

## Data reuse
`customers` (+ `customer_tier`, `customer_locations` ship-to), `style_master` (active = catalog; `brand_id`, `gender_code`, group/category/sub), `brand_master`, `sales_orders`/`sales_order_lines` (M10 — portal orders are `origin='b2b_portal'`, `status='draft'`), `ar_invoices` (account view).

## Chunk sequence
- **A — foundation (this PR):** `b2b_accounts`, `b2b_price_list`, `sales_orders.origin`/`placed_by_b2b_account_id`, `b2b_current_customer_id()`, RLS. Applied to prod.
- **B — auth + portal shell:** `/b2b` route + Supabase magic-link login + session→customer resolution + `/api/b2b/session` (resolve b2b_account from JWT) + a server auth helper that returns the session customer_id for all portal endpoints.
- **C — catalog + pricing:** catalog grid (active styles, brand/gender filter) with each style's resolved wholesale price; product detail. `/api/b2b/catalog`.
- **D — cart + place order:** cart → submit creates a draft `sales_orders` (origin='b2b_portal', placed_by_b2b_account_id, customer from session, ship-to from customer_locations) via `/api/b2b/orders`. Appears in the internal Sales Orders queue.
- **E — account: invoices/AR + reorder:** view invoices + open balance; reorder from a past order/invoice. `/api/b2b/account`, `/api/b2b/orders` (list).
- **F — internal admin:** Tangerine panels to authorize buyer emails (`b2b_accounts`) and manage `b2b_price_list` (so staff can onboard buyers + set prices).

## Out of scope (later)
Real pricing engine = **M43** (deferred). Online payment capture (card) — buyers see AR, pay via existing AR receipts. Marketplace/EDI order intake = P12/P22.
