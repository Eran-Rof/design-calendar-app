-- 20260426000000_bom_status.sql
--
-- Phase 3: UPC BOM auto-build
--
-- Changes:
--   pack_gtin_master      + bom_status, bom_last_built_at, bom_issue_summary
--   pack_gtin_bom_issues  new — one row per build issue per pack GTIN

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. BOM tracking columns on pack_gtin_master
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE pack_gtin_master
  ADD COLUMN IF NOT EXISTS bom_status text NOT NULL DEFAULT 'not_built'
    CHECK (bom_status IN ('not_built', 'complete', 'incomplete', 'error')),
  ADD COLUMN IF NOT EXISTS bom_last_built_at timestamptz,
  ADD COLUMN IF NOT EXISTS bom_issue_summary jsonb;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. BOM build issues table
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pack_gtin_bom_issues (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_gtin   text        NOT NULL,
  issue_type  text        NOT NULL,
  severity    text        NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  message     text        NOT NULL,
  context     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bom_issues_pack_gtin ON pack_gtin_bom_issues (pack_gtin);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. RLS — same permissive anon policy as other GS1 tables
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE pack_gtin_bom_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gs1_anon_all ON pack_gtin_bom_issues;
CREATE POLICY gs1_anon_all ON pack_gtin_bom_issues
  FOR ALL TO anon USING (true) WITH CHECK (true);
