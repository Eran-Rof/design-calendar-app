-- ──────────────────────────────────────────────────────────────────────────
-- Tangerine P12c-4 — Faire wholesale returns table
--
-- Faire is wholesale. Returns come back to the seller's warehouse always —
-- there is no marketplace-fulfillment carve-out like FBA. A return generally
-- triggers two parallel posts:
--
--   1. An AR credit memo (CR receivable + DR revenue) — Faire reduces what
--      the buyer owes; we reverse the revenue recognized at order time.
--   2. A restock inventory layer (DR inventory / CR cogs) at the FIFO cost
--      of the latest open layer for the returned item — putting the goods
--      back on the books and reversing the COGS hit.
--
-- The cron walks /external-api/v2/returns on the Faire API for each active
-- faire_shops row weekly (Monday 05:30 UTC) and:
--
--   1. Upserts faire_returns rows by (faire_shop_id, faire_return_id).
--   2. Posts the AR credit memo via the existing arCreditMemo posting rule
--      with source_kind='credit_memo_return' for the inventory layers
--      (already a permitted value — see
--      20260528110000_p4_fix_inventory_layers_source_kind.sql).
--   3. Stamps faire_returns.je_id + ar_credit_memo_id.
--
-- Idempotency:
--   - The (faire_shop_id, faire_return_id) UNIQUE makes the upsert safe to
--     replay.
--   - je_id IS NULL is the "needs posting" signal; the JE poster short-
--     circuits when je_id IS NOT NULL.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS faire_returns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id()) REFERENCES entities(id),
  faire_shop_id         uuid NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT,
  faire_order_id        uuid REFERENCES faire_orders(id) ON DELETE SET NULL,
  faire_return_id       text NOT NULL,
  return_status         text NOT NULL,
  refund_amount_cents   bigint NOT NULL DEFAULT 0,
  reason                text,
  ar_credit_memo_id     uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                 uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload           jsonb NOT NULL,
  source                text NOT NULL DEFAULT 'faire' CHECK (source = 'faire'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (faire_shop_id, faire_return_id)
);

CREATE INDEX IF NOT EXISTS faire_returns_entity_created_idx
  ON faire_returns (entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS faire_returns_shop_created_idx
  ON faire_returns (faire_shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS faire_returns_order_idx
  ON faire_returns (faire_order_id);
CREATE INDEX IF NOT EXISTS faire_returns_unposted_idx
  ON faire_returns (faire_shop_id) WHERE je_id IS NULL;

-- ─── RLS — anon_all_* + auth_internal_* template (P1) ─────────────────────
ALTER TABLE faire_returns ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_all_faire_returns" ON faire_returns
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "auth_internal_faire_returns" ON faire_returns
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── PostgREST schema cache reload ────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
