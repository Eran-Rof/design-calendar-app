-- season_master: add an informational From/To date range.
-- Purely informational (reporting + AI context); does NOT drive any
-- filtering, sorting, or other logic. Nullable; idempotent.

alter table season_master add column if not exists start_date date;
alter table season_master add column if not exists end_date date;

comment on column season_master.start_date is 'Informational season window start; reporting/AI only, drives no logic.';
comment on column season_master.end_date is 'Informational season window end; reporting/AI only, drives no logic.';
