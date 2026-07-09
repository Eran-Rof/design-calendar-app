-- ════════════════════════════════════════════════════════════════════════════
-- Factor Module Phase 2 — Rosenthal chargeback detail + dispute tracking, and
-- the CLIENT RECAP cost decomposition needed for the monthly factoring-cost
-- JEs.
--
-- 1) factor_statements gains the cost-decomposition columns: the recap's
--    ACCRUED FEES/OTHER TRANSFERS (FACILITY) is NOT pure fee cost — per
--    facility block it is ACCRUED INTEREST (the PRIOR month's TOTAL INTEREST
--    now charged to the loan) + FEES + OTHER. The factoring-cost JE takes
--    FEES+OTHER only; interest is expensed in its accrual month as
--    TOTAL INTEREST + PRIOR MONTH INT. ADJ.
--
-- 2) factor_chargebacks: item-grain rows from the monthly "Chargeback Report"
--    ("Charge Back Analysis" section). Sign as printed: positive = charge
--    back (deduction taken by the customer), negative = credit back /
--    recovery. Σ amount_cents per report_month ties to the report's
--    TradeStyle Total, which equals −(recap CHARGEBACKS(-)/CREDITBACKS/
--    RECOVERIES). Reasons are best-effort attached from the report's
--    CHARGEBACK/CREDITBACK SUMMARY section (merged at date grain by
--    Rosenthal, so not every item resolves to a reason).
--
--    Dispute workflow columns (status / notes / status_history / updated_*)
--    are OPERATOR-owned: the importer never writes them, PATCH
--    /api/internal/factor/chargebacks/:id appends every status change to
--    status_history (updated_by trail).
--
-- RLS posture identical to Phase 1 (20260965): auth_internal only, NO anon.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.factor_statements
  add column if not exists prior_month_interest_adj_cents  bigint not null default 0,
  add column if not exists facility_accrued_interest_cents bigint not null default 0,
  add column if not exists facility_fees_cents             bigint not null default 0,
  add column if not exists facility_other_cents            bigint not null default 0;

comment on column public.factor_statements.prior_month_interest_adj_cents is
  'PRIOR MONTH INT. ADJ. from the recap — correction to last month''s interest, expensed with this month''s interest.';
comment on column public.factor_statements.facility_fees_cents is
  'Σ FEES across the facility blocks — part of the monthly factoring cost (fees/other JE line).';
comment on column public.factor_statements.facility_other_cents is
  'Σ OTHER across the facility blocks — part of the monthly factoring cost (fees/other JE line).';
comment on column public.factor_statements.facility_accrued_interest_cents is
  'Σ ACCRUED INTEREST across the facility blocks = prior month''s TOTAL INTEREST charged to the loan this month. Excluded from the cost JE (already expensed in its accrual month).';

create table if not exists public.factor_chargebacks (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references public.entities(id) on delete restrict
                       default coalesce(current_entity_id(), rof_entity_id()),
  report_month       date not null,                       -- Accounting Period, first of month
  factor_customer_no text not null references public.factor_customers(factor_customer_no),
  customer_name      text not null,
  client_customer    text,                                -- report "Client Customer #" free text
  item_num           text not null,                       -- invoice / deduction ref as printed
  item_date          date,
  cb_date            date not null,                       -- C/B Date
  batch              text not null default '',            -- Rosenthal batch (blank on some 2026 rows)
  amount_cents       bigint not null,                     -- sign as printed: + chargeback / − creditback
  item_type          text not null default 'chargeback' check (item_type in ('chargeback','creditback')),
  reason             text,                                -- best-effort from the summary section
  reason_code        text,                                -- Rosenthal 3-digit reason code
  reference          text,
  -- dispute workflow (operator-owned; importer never touches these)
  status             text not null default 'new' check (status in ('new','under_review','disputed','accepted','recovered')),
  notes              text,
  status_history     jsonb not null default '[]'::jsonb,  -- [{at, by, from, to, note}]
  updated_by         text,
  updated_at         timestamptz,
  customer_id        uuid references public.customers(id) on delete set null,
  raw                jsonb not null default '{}'::jsonb,
  imported_at        timestamptz not null default now(),
  -- dup_seq disambiguates genuinely repeated (item, amount, batch, date) rows
  -- inside one report, assigned deterministically in file order.
  dup_seq            smallint not null default 1,
  unique (report_month, item_num, cb_date, batch, amount_cents, dup_seq)
);

create index if not exists idx_factor_chargebacks_month    on public.factor_chargebacks (report_month);
create index if not exists idx_factor_chargebacks_customer on public.factor_chargebacks (factor_customer_no, report_month);
create index if not exists idx_factor_chargebacks_status   on public.factor_chargebacks (status) where status <> 'new';

comment on table public.factor_chargebacks is
  'Rosenthal Charge Back Analysis item detail per accounting month (Factor Phase 2). Σ amount_cents per month ties to the report TradeStyle Total = −(recap chargebacks net). Dispute columns are operator-owned.';

alter table public.factor_chargebacks enable row level security;

drop policy if exists "auth_internal_factor_chargebacks" on public.factor_chargebacks;
create policy "auth_internal_factor_chargebacks" on public.factor_chargebacks
  for all to authenticated
  using      (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()))
  with check (entity_id in (select eu.entity_id from entity_users eu where eu.auth_id = auth.uid()));
