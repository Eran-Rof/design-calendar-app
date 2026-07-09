-- ════════════════════════════════════════════════════════════════════════════
-- Factor Module Phase 1 — Rosenthal Capital Group (apparel gap #1 groundwork).
--
-- Three tables fed by scripts/import-factor-pdfs.mjs from the monthly Rosenthal
-- PDFs ("CLIENT RECAP MM.YYYY.pdf" + "FACTORED- AR DETAILED MM.YYYY.pdf"):
--
--   • factor_statements    — one row per statement month (CLIENT RECAP economics:
--                            net sales, collections, chargebacks, commissions,
--                            interest, fees, advances, OAR rollforward, net due
--                            client, total loans). All money in integer CENTS.
--   • factor_ar_open_items — month-end open-AR detail (FACTORED AR DETAILED):
--                            one row per open invoice / OAP deduction per as-of
--                            date. Σ item_balance_cents per as_of ties to the
--                            report footer Net OAR to the cent.
--   • factor_customers     — Rosenthal customer-number directory, best-effort
--                            linked to our customers table.
--
-- Phase 2 (deferred): monthly factoring-cost JEs (commissions / interest /
-- chargebacks) + per-invoice chargeback dispute tracking (needs the Rosenthal
-- chargeback-detail report).
--
-- Security posture per migration 20260964000000: NO anon policies. RLS enabled
-- with the canonical auth_internal (entity_users) policy only; the /api/internal
-- handlers use the service role (bypasses RLS) and the importer runs with the
-- service key.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.factor_statements (
  id                             uuid primary key default gen_random_uuid(),
  entity_id                      uuid not null references public.entities(id) on delete restrict
                                   default coalesce(current_entity_id(), rof_entity_id()),
  statement_month                date not null unique,        -- first day of month
  factor_name                    text not null default 'Rosenthal',
  net_sales_cents                bigint not null default 0,
  cash_collections_cents         bigint not null default 0,   -- stored positive
  chargebacks_net_cents          bigint not null default 0,   -- CHARGEBACKS(-)/CREDITBACKS/RECOVERIES, as printed
  commissions_cents              bigint not null default 0,   -- stored positive
  interest_cents                 bigint not null default 0,   -- TOTAL INTEREST
  fees_other_cents               bigint not null default 0,   -- ACCRUED FEES/OTHER TRANSFERS (FACILITY)
  advances_cents                 bigint not null default 0,
  beginning_net_oar_cents        bigint not null default 0,
  ending_net_oar_cents           bigint not null default 0,
  net_due_client_beginning_cents bigint not null default 0,
  net_due_client_ending_cents    bigint not null default 0,
  total_loans_cents              bigint not null default 0,
  source_file                    text,
  imported_at                    timestamptz not null default now(),
  raw                            jsonb not null default '{}'::jsonb
);

comment on table public.factor_statements is
  'Rosenthal CLIENT RECAP monthly statement economics (Factor Module Phase 1). One row per statement month; money in integer cents. Fed by scripts/import-factor-pdfs.mjs.';

create table if not exists public.factor_customers (
  factor_customer_no text primary key,                        -- Rosenthal customer number, e.g. 111987
  name               text not null,
  customer_id        uuid references public.customers(id) on delete set null,
  entity_id          uuid not null references public.entities(id) on delete restrict
                       default coalesce(current_entity_id(), rof_entity_id()),
  created_at         timestamptz not null default now()
);

comment on table public.factor_customers is
  'Rosenthal customer-number directory (FACTORED AR DETAILED blocks) with best-effort link to customers. Seeded by the Phase-1 migration; importer inserts new numbers with customer_id NULL.';

create table if not exists public.factor_ar_open_items (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references public.entities(id) on delete restrict
                       default coalesce(current_entity_id(), rof_entity_id()),
  as_of_date         date not null,                           -- report "As Of" date (month-end business day)
  factor_customer_no text not null references public.factor_customers(factor_customer_no),
  customer_name      text not null,
  item_num           text not null,                           -- ROF-I012063 / PT-I013802 / OAP0024700269
  item_type          text not null,                           -- I = invoice, O = open A/P deduction
  po_num             text,
  item_date          date,
  due_date           date,
  terms              text,
  gross_amt_cents    bigint not null default 0,
  item_balance_cents bigint not null default 0,
  customer_id        uuid references public.customers(id) on delete set null,
  imported_at        timestamptz not null default now(),
  unique (as_of_date, item_num)
);

create index if not exists idx_factor_ar_open_items_asof     on public.factor_ar_open_items (as_of_date);
create index if not exists idx_factor_ar_open_items_customer on public.factor_ar_open_items (factor_customer_no, as_of_date);

comment on table public.factor_ar_open_items is
  'Rosenthal FACTORED AR DETAILED open items per month-end as-of date (Factor Module Phase 1). Σ item_balance_cents per as_of ties to the report footer Net OAR.';

-- ── RLS: auth_internal only (NO anon policies — 20260964 security posture) ──
alter table public.factor_statements    enable row level security;
alter table public.factor_customers     enable row level security;
alter table public.factor_ar_open_items enable row level security;

drop policy if exists "auth_internal_factor_statements" on public.factor_statements;
create policy "auth_internal_factor_statements" on public.factor_statements
  for all to authenticated
  using      (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()))
  with check (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()));

drop policy if exists "auth_internal_factor_customers" on public.factor_customers;
create policy "auth_internal_factor_customers" on public.factor_customers
  for all to authenticated
  using      (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()))
  with check (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()));

drop policy if exists "auth_internal_factor_ar_open_items" on public.factor_ar_open_items;
create policy "auth_internal_factor_ar_open_items" on public.factor_ar_open_items
  for all to authenticated
  using      (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()))
  with check (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()));

-- ── Seed the six factored customers (best-effort match by name; probed on prod
--    2026-07-08 — all six resolve; the lookups degrade to NULL where a name is
--    absent, e.g. on staging). Island Leisure has a code-NULL duplicate row →
--    prefer the coded row deterministically. ──────────────────────────────────
insert into public.factor_customers (factor_customer_no, name, customer_id)
values
  ('111987', 'BEALL`S INC.',
    (select id from public.customers where name ilike 'Bealls Inc.' and deleted_at is null
       order by (code is null), code limit 1)),
  ('119432', 'BURLINGTON MERCHANDISING CORPORATION',
    (select id from public.customers where name ilike 'Burlington%' and deleted_at is null
       order by (code is null), code limit 1)),
  ('133867', 'D D`S DISCOUNT',
    (select id from public.customers where name ilike 'DD''S Discounts' and deleted_at is null
       order by (code is null), code limit 1)),
  ('676622', 'ISLAND LEISURE, INC.',
    (select id from public.customers where name ilike 'Island Leisure Inc.' and deleted_at is null
       order by (code is null), code limit 1)),
  ('211832', 'ROSS STORES INC',
    (select id from public.customers where name ilike 'Ross Procurement' and deleted_at is null
       order by (code is null), code limit 1)),
  ('683407', 'MACY`S BACKSTAGE',
    (select id from public.customers where name ilike 'Macy''s Backstage' and deleted_at is null
       order by (code is null), code limit 1))
on conflict (factor_customer_no) do update
  set name = excluded.name,
      customer_id = coalesce(public.factor_customers.customer_id, excluded.customer_id);
