-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P11-8 — Shopify chargeback / dispute capture
--
-- Per the P11 architecture doc, decision D9:
--   Shopify dispute_created webhook → open an M47 case (P7-9 cases API) AND
--   post the chargeback expense JE atomically (DR 6610 / CR 1100). The
--   chargeback row links to both the case and the JE so the operator can
--   navigate from any side.
--
-- This chunk = SCHEMA + per-table RLS template only. The webhook handler
-- + service live in api/_handlers/internal/shopify/webhooks/disputes.js +
-- api/_lib/shopify/process-dispute.js.
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS, RLS policies guarded by
-- DO $$ ... EXCEPTION WHEN duplicate_object.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. shopify_disputes ────────────────────────────────────────────────────
--
-- One row per Shopify dispute (chargeback or inquiry). UNIQUE on
-- (shopify_store_id, shopify_dispute_id) so webhook re-delivery is
-- idempotent — a second dispute_created webhook for the same dispute will
-- find the row and short-circuit (already processed).

CREATE TABLE IF NOT EXISTS shopify_disputes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id()) REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id      uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_order_id      uuid REFERENCES shopify_orders(id) ON DELETE SET NULL,
  shopify_dispute_id    text NOT NULL,
  dispute_type          text NOT NULL,
  dispute_amount_cents  bigint NOT NULL,
  status                text NOT NULL,
  reason                text,
  evidence_due_by       timestamptz,
  case_id               uuid REFERENCES cases(id) ON DELETE SET NULL,
  je_id                 uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload           jsonb NOT NULL,
  source                text NOT NULL DEFAULT 'shopify' CHECK (source = 'shopify'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_disputes_dedup UNIQUE (shopify_store_id, shopify_dispute_id)
);

CREATE INDEX IF NOT EXISTS shopify_disputes_entity_created_idx
  ON shopify_disputes (entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shopify_disputes_store_status_idx
  ON shopify_disputes (shopify_store_id, status);
CREATE INDEX IF NOT EXISTS shopify_disputes_case_idx
  ON shopify_disputes (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shopify_disputes_je_idx
  ON shopify_disputes (je_id) WHERE je_id IS NOT NULL;

-- ─── 2. RLS ─────────────────────────────────────────────────────────────────
--
-- Same template as P11-1: anon_all_* + auth_internal_* (entity-scoped).
-- The anon_all policy is the operator-facing path (service-role bypasses
-- anyway); the auth_internal policy gates per-user access via entity_users.

ALTER TABLE shopify_disputes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_all_shopify_disputes" ON shopify_disputes
    FOR ALL TO anon
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "auth_internal_shopify_disputes" ON shopify_disputes
    FOR ALL TO authenticated
    USING (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
