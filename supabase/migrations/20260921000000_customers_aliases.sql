-- Customer name aliases — mirror of vendors.aliases.
-- Lets a customer match alternate names (e.g. a Xoro CustomerName variant) so
-- imports/lookups resolve to the existing record instead of creating a dup.
-- Used by scripts/import-xoro-orders.mjs (customer byName index) — e.g. roll
-- "RING OF FIRE, LLC." onto the existing "Ring of Fire" (CUST-00114) account.
alter table customers add column if not exists aliases text[] not null default '{}';
