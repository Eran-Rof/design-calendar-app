-- Follow-up to 20260517220000_item_master_pack_size.sql.
-- The original migration used `'PPK(\d+)'` in substring(...) calls
-- which, in the live Supabase Postgres environment, didn't reliably
-- capture digits from the `size` column for rows where the PPK token
-- ONLY appeared in size (e.g. style="ACMB0016PPK", size="PPK24").
-- The sku/style cases worked; the size-fallback path silently
-- returned NULL and the COALESCE fell through to the default 1.
--
-- Re-runs the size-only backfill using POSIX-portable `[0-9]+` to
-- avoid any `\d` flavor ambiguity. Only touches rows that still have
-- pack_size = 1 but have a PPKn token in size — won't disturb any
-- rows the original UPDATE already corrected.

UPDATE ip_item_master
SET pack_size = NULLIF(substring(size FROM 'PPK([0-9]+)'), '')::integer
WHERE pack_size = 1
  AND size ~* 'PPK[0-9]+'
  AND NULLIF(substring(size FROM 'PPK([0-9]+)'), '') IS NOT NULL;
