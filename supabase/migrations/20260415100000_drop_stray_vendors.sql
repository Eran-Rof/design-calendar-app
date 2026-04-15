-- 20260415100000_drop_stray_vendors.sql
--
-- Drops a pre-existing empty `vendors` stub table that was created ad-hoc
-- (not via migration history) and has a schema incompatible with the
-- portal-ready version in 20260415100001_vendors_table_and_fk.sql.
--
-- Verified before this migration:
--   • row count = 0
--   • no references in src/ (grep confirmed)
--   • remote migration list was empty (table not tracked)
--
-- Safe to drop. CASCADE protects against any forgotten dependency by
-- taking it down with the table; given the verification above there
-- should be nothing to cascade into.

DROP TABLE IF EXISTS vendors CASCADE;
