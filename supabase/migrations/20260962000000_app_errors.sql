-- app_errors: platform-wide error capture (the observability layer the
-- 2026-07-07 audit flagged as the #1 gap — prod exceptions were visible only
-- in Vercel logs nobody reads). Written by:
--   • api/dispatch.js catch-all (source='api')      — every dispatched route
--   • /api/internal/client-errors (source='client') — window.onerror / unhandledrejection
--   • cron wrappers (source='cron')                 — opt-in per cron
-- Read by the daily app-errors-digest cron (ONE bell+email grouping by
-- fingerprint), which also prunes rows older than 30 days.
-- Service-role writes only — no anon grants on purpose.
create table if not exists public.app_errors (
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source in ('api','client','cron')),
  route       text,
  method      text,
  message     text not null,
  stack       text,
  fingerprint text not null,
  context     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_app_errors_created on public.app_errors (created_at desc);
create index if not exists idx_app_errors_fingerprint on public.app_errors (fingerprint, created_at desc);

alter table public.app_errors enable row level security;
-- No policies: service-role only (bypasses RLS). Deliberate — error payloads
-- can carry request context that must not be anon-readable.

comment on table public.app_errors is
  'Captured runtime errors (api dispatcher / browser / crons). Grouped by fingerprint in the daily digest; pruned at 30 days.';
