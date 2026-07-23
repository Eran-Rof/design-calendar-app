-- 20266100000000_beta_data_module_and_cleanup_cols.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Beta guardrails — Chunk C: Beta Data admin screen support.
--
-- 1. beta_created_docs gains the cleanup bookkeeping columns the Beta Data
--    screen's cleanup engine writes: cleaned_at (when the tagged row was
--    deleted / found already gone) + cleanup_note (who/when, human-readable).
--    The table itself is created by the sibling chunk-A migration; the ALTER
--    is wrapped in a to_regclass() guard so THIS migration parses and applies
--    cleanly even when it lands before chunk A (defensive ordering — the
--    chunks are built in parallel worktrees).
--
-- 2. Register the `beta_data` module_key (Admin group) so the RBAC layer can
--    gate the screen. NO role_permissions rows are inserted on purpose: the
--    admin role derives its grants from the LIVE module_keys registry (see
--    20262340000000_rbac_admin_grant_sweep.sql), so registering the key makes
--    the screen admin-only automatically — exactly the intent. The `beta`
--    role (chunk B) is deliberately NOT granted beta_data: beta users must
--    never see or drive their own cleanup.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) — safe under
-- supabase-db-push re-apply.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Cleanup bookkeeping columns on the beta registry ─────────────────────
DO $$
BEGIN
  IF to_regclass('public.beta_created_docs') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE beta_created_docs
               ADD COLUMN IF NOT EXISTS cleaned_at   timestamptz,
               ADD COLUMN IF NOT EXISTS cleanup_note text';
    EXECUTE 'COMMENT ON COLUMN beta_created_docs.cleaned_at IS
               ''Set when the tagged row was deleted by the Beta Data cleanup engine (or found already gone). NULL = still outstanding.''';
    EXECUTE 'COMMENT ON COLUMN beta_created_docs.cleanup_note IS
               ''Human-readable cleanup provenance, e.g. "deleted by <user> <ts>". Written only by the cleanup engine.''';
  END IF;
END $$;

-- ─── 2. beta_data module_key (Admin group; read/write/export) ────────────────
-- Mirrors the P14 seed insert pattern (20260707000000_p14_chunk1_rbac_schema.sql).
INSERT INTO module_keys (key, display_name, group_name, sort_order, available_actions) VALUES
  ('beta_data', 'Beta Data', 'Admin', 340, ARRAY['read','write','export']::text[])
ON CONFLICT (key) DO NOTHING;

-- ─── 3. beta_cleanup_delete() — ATOMIC doc delete for the cleanup engine ─────
-- The engine's delete must be lines+header in ONE transaction: deleting lines
-- via PostgREST and then having the header delete refuse on an EXTERNAL FK
-- would leave a corrupted header-without-lines document. A plpgsql function
-- runs in a single transaction, so any FK violation rolls BOTH deletes back.
-- Table names are validated against a hardcoded allowlist (never caller-driven
-- dynamic SQL beyond it). SECURITY DEFINER + EXECUTE revoked from anon/
-- authenticated: only the service role (the beta-data handler) may call it.
CREATE OR REPLACE FUNCTION beta_cleanup_delete(p_table text, p_row_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_line_table text;
  v_line_fk    text;
  v_found      integer;
BEGIN
  IF p_table NOT IN (
    'ar_invoices','invoices','sales_orders','purchase_orders','rfqs',
    'ar_receipts','invoice_payments','journal_entries','cases',
    'customers','vendors','style_master','ip_item_master',
    'inventory_adjustments','inventory_transfers'
  ) THEN
    RAISE EXCEPTION 'beta_cleanup_delete: table % is not in the cleanup allowlist', p_table;
  END IF;

  SELECT m.lt, m.fk INTO v_line_table, v_line_fk FROM (VALUES
    ('ar_invoices',     'ar_invoice_lines',     'ar_invoice_id'),
    ('invoices',        'invoice_line_items',   'invoice_id'),
    ('sales_orders',    'sales_order_lines',    'sales_order_id'),
    ('purchase_orders', 'purchase_order_lines', 'purchase_order_id'),
    ('rfqs',            'rfq_line_items',       'rfq_id')
  ) AS m(tbl, lt, fk) WHERE m.tbl = p_table;

  IF v_line_table IS NOT NULL THEN
    EXECUTE format('DELETE FROM public.%I WHERE %I = $1', v_line_table, v_line_fk) USING p_row_id;
  END IF;

  EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_table) USING p_row_id;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN CASE WHEN v_found > 0 THEN 'deleted' ELSE 'not_found' END;
END;
$fn$;

REVOKE ALL ON FUNCTION beta_cleanup_delete(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION beta_cleanup_delete(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION beta_cleanup_delete(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION beta_cleanup_delete(text, uuid) TO service_role;

COMMENT ON FUNCTION beta_cleanup_delete(text, uuid) IS
  'Beta guardrails (chunk C): atomic lines+header delete for the Beta Data cleanup engine. Allowlisted tables only; FK violations roll back both deletes; service-role execute only.';

NOTIFY pgrst, 'reload schema';
