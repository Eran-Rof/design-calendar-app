-- Schema introspection function for the Ask AI panel.
--
-- Returns the column metadata for every public-schema table EXCEPT
-- those that contain sensitive data (banking, encrypted card fields,
-- AES-encrypted credentials, raw EDI payloads). Internal Supabase
-- schemas (auth, storage, pgsodium, vault, supabase_*, etc.) are
-- implicitly excluded by filtering on table_schema = 'public'.
--
-- The handler (api/_handlers/ai/ask-grid.js) calls this via
-- supabase.rpc('get_ai_readable_schema') on cold start and caches the
-- result in module scope. Combined with column-name PII pattern
-- filtering, this gives Claude visibility into the entire app
-- database (~100+ tables) without manual registry maintenance.
--
-- Tables added later are auto-included as soon as they land in
-- public. Add to the table_denylist literal here to remove one.

CREATE OR REPLACE FUNCTION get_ai_readable_schema()
RETURNS TABLE(
  table_name       text,
  column_name      text,
  data_type        text,
  is_nullable      text,
  ordinal_position int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH table_denylist AS (
    SELECT unnest(ARRAY[
      'banking_details',
      'payments',
      'virtual_cards',
      'erp_integrations',
      'edi_messages',
      -- Supabase / framework tables that landed in public for any reason:
      'schema_migrations',
      'spatial_ref_sys'
    ]) AS t
  )
  SELECT
    c.table_name::text,
    c.column_name::text,
    c.data_type::text,
    c.is_nullable::text,
    c.ordinal_position::int
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name NOT IN (SELECT t FROM table_denylist)
    AND c.table_name NOT LIKE 'pg_%'
    AND c.table_name NOT LIKE 'sql_%'
  ORDER BY c.table_name, c.ordinal_position;
$$;

REVOKE ALL ON FUNCTION get_ai_readable_schema() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_ai_readable_schema() TO service_role;

COMMENT ON FUNCTION get_ai_readable_schema() IS
  'Used by the Ask AI panel (api/_handlers/ai/ask-grid.js) for live schema discovery. Excludes tables with encrypted/sensitive content. Returns one row per (table, column).';
