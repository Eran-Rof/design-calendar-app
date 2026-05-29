-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P11-7 — Restocking Fee Income GL seed (idempotent guard)
--
-- P11-1 (PR #482) already seeded 4500 Restocking Fee Income for ROF when
-- migration 20260629100000_p11_chunk1_shopify_schema.sql ran. This chunk
-- is a belt-and-suspenders guard: re-asserts the seed via ON CONFLICT DO
-- NOTHING so any future entity bootstrap or restored-from-backup database
-- ends up with the account present without depending on P11-1's DO-block
-- having executed cleanly.
--
-- Why a separate migration:
--   The P11-7 chunk's purpose is the InternalShopifyRefunds reports panel.
--   That panel renders restocking_fee_cents and links the sibling
--   ar_credit_memo_id; both already rely on 4500 being postable (P11-3 /
--   P11-6 credit the income there). A standalone guard migration makes
--   the dependency explicit and self-contained even if P11-1 ever gets
--   refactored.
--
-- Per D8: 4500 Restocking Fee Income — account_type=revenue, normal_balance=CREDIT.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping P11-7 GL account seed; rerun once entity exists';
    RETURN;
  END IF;

  -- 4500 Restocking Fee Income (D8) — idempotent guard; P11-1 seeded the
  -- canonical row. ON CONFLICT (entity_id, code) DO NOTHING keeps the
  -- repeat-apply safe.
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '4500', 'Restocking Fee Income', 'revenue', 'CREDIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

-- ─── PostgREST schema cache reload ────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
