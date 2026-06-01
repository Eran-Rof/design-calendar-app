-- 20260713030000_gl_inventory_brand_accounts.sql
-- ════════════════════════════════════════════════════════════════════════════
-- GL chart accounts: Inventory + Inventory Adjustments parents with a postable
-- per-brand child for each of the 11 brands. Operator decision: BOTH parents
-- live on the BALANCE SHEET (account_type='asset', normal_balance='DEBIT') —
-- Inventory Adjustments is an asset contra/holding account, NOT a P&L line.
--
-- Convention reuses the M50 brand-allocation child shape verbatim (see
-- api/_handlers/internal/gl-accounts/[id]/brand-allocation.js → childAccountRows):
--   • child code  = {parent.code}-{brand.code}      e.g. 1300-ROF
--   • child name  = {parent.name} — {brand.name}    e.g. Inventory — Ring of Fire
--   • child inherits account_type / account_subtype / normal_balance from parent
--   • child is_postable=true, is_control=false, parent_account_id=parent.id,
--     brand_id=brand, status='active'
--   • parent is_postable=false, brand_rollup=true, brand_id=null
--
-- Per-entity COA: gl_accounts is unique on (entity_id, code). Inventory accounts
-- (1310/1320) today exist for exactly the entities that hold inventory. We create
-- the new accounts for EVERY entity that already has a 1310 OR 1320 inventory
-- account, so resolution + reporting line up per entity.
--
-- ADDITIVE + IDEMPOTENT: INSERT … ON CONFLICT (entity_id, code) DO NOTHING only.
-- No UPDATE/DELETE of existing accounts or balances. Re-run = no-op.
-- ════════════════════════════════════════════════════════════════════════════

-- Entities that currently hold inventory accounts (1310 In-Transit / 1320 QC Hold).
WITH inv_entities AS (
  SELECT DISTINCT entity_id
  FROM gl_accounts
  WHERE code IN ('1310', '1320')
),
-- ── 1. Parent rollups: 1300 Inventory + 1330 Inventory Adjustments ───────────
parents AS (
  SELECT * FROM (VALUES
    ('1300', 'Inventory',             'Inventory asset rollup. Per-brand postable children sum to total inventory.'),
    ('1330', 'Inventory Adjustments', 'Inventory adjustment asset rollup (balance sheet). Per-brand postable children.')
  ) AS p(code, name, descr)
),
ins_parents AS (
  INSERT INTO gl_accounts
    (entity_id, code, name, account_type, account_subtype, normal_balance,
     parent_account_id, is_postable, is_control, status, brand_rollup, description)
  SELECT e.entity_id, p.code, p.name,
         'asset', NULL, 'DEBIT',
         NULL, false, false, 'active', true, p.descr
  FROM inv_entities e CROSS JOIN parents p
  ON CONFLICT (entity_id, code) DO NOTHING
  RETURNING id
)
SELECT count(*) FROM ins_parents;

-- ── 2. Per-brand postable children of 1300 and 1330 ──────────────────────────
-- Resolve the parent rows live (covers both the rows we just inserted and any
-- that already existed from a prior run), then fan out across all brands.
WITH inv_parents AS (
  SELECT a.id AS parent_id, a.entity_id, a.code, a.name,
         a.account_type, a.account_subtype, a.normal_balance
  FROM gl_accounts a
  WHERE a.code IN ('1300', '1330') AND a.brand_rollup = true
)
INSERT INTO gl_accounts
  (entity_id, code, name, account_type, account_subtype, normal_balance,
   parent_account_id, brand_id, is_postable, is_control, status)
SELECT p.entity_id,
       p.code || '-' || b.code,
       p.name || ' — ' || b.name,
       p.account_type, p.account_subtype, p.normal_balance,
       p.parent_id, b.id, true, false, 'active'
FROM inv_parents p CROSS JOIN brand_master b
ON CONFLICT (entity_id, code) DO NOTHING;

NOTIFY pgrst, 'reload schema';
