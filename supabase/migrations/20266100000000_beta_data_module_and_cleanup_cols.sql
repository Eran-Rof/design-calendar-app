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

NOTIFY pgrst, 'reload schema';
