-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P10-3 — Swap DEFAULT rof_entity_id() → coalesce(current_entity_id(), rof_entity_id())
--                   on all entity-scoped tables.
--
-- Implements the schema deltas accepted in
--   docs/tangerine/P10-tenancy-architecture.md §3.5 + §6 chunk P10-3.
--
-- Context:
--   • PR #463 added DEFAULT rof_entity_id() to tanda_pos + po_line_items.
--   • P10-1 (PR #481) seeded SANDBOX entity + entity_users.is_default.
--   • P10-2 (PR #484) shipped current_entity_id() SECURITY DEFINER helper.
--   • P10-2b (PR #490) shipped the switcher API + RLS audit script.
--   • This chunk wires every remaining entity-scoped table to honor the
--     request-scoped current entity by default — coalescing back to ROF so
--     service-role inserts without the GUC keep the legacy single-tenant
--     behavior. Once the API dispatcher (P10-4) reliably sets the GUC on
--     every request, a follow-up P10-3b will drop the coalesce in favor of
--     pure current_entity_id().
--
-- Why coalesce(current_entity_id(), rof_entity_id()) and not raw
-- current_entity_id():
--   current_entity_id() returns NULL when neither (a) the per-request GUC
--   app.current_entity_id is set nor (b) the calling auth.uid() has a
--   default entity_users row. That's correct for RLS (deny on NULL) but
--   would break service-role INSERTs that forget to SET LOCAL the GUC
--   (today there are several — nightly Xoro sync, master sync, backfills).
--   Coalescing back to rof_entity_id() preserves today's safe behavior
--   while the dispatcher wiring catches up. See arch §3.5 + §6 P10-3.
--
-- Scope (this migration only):
--   1. ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id())
--      on every entity-scoped table EXCEPT tanda_pos + po_line_items, which
--      PR #463 set to DEFAULT rof_entity_id() and which a follow-up chunk
--      handles together with the dispatcher GUC wiring (P10-4).
--   2. NOTIFY pgrst to refresh PostgREST's schema cache.
--
-- 93 tables in scope, split into two buckets for documentation clarity:
--   A. 17 tables already had DEFAULT rof_entity_id() (P11/P12 marketplace
--      schemas — shopify_*, fba_*, walmart_*, faire_*, inventory_locations).
--      For these, ALTER COLUMN SET DEFAULT is a true swap.
--   B. 76 tables had NO DEFAULT (P1 originals plus everything added in
--      P2-P8). For these, ALTER COLUMN SET DEFAULT is an additive safety
--      net — handlers that already pass entity_id explicitly are
--      unaffected.
--
-- Idempotent: ALTER COLUMN SET DEFAULT is unconditional and naturally
-- idempotent — re-applying the same DEFAULT is a no-op.
--
-- Not in this chunk (deferred):
--   • Dispatcher SET LOCAL app.current_entity_id wiring          → P10-4
--   • Entity switcher UI                                          → P10-5
--   • Drop the coalesce fallback once dispatcher is reliable      → P10-3b
-- ════════════════════════════════════════════════════════════════════════════

-- ─── A. P11/P12 marketplace tables (17) — swap rof_entity_id() → coalesce ───
ALTER TABLE faire_buyers              ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE faire_orders              ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE faire_payouts             ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE faire_shops               ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE fba_inventory_snapshots   ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE fba_orders                ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE fba_returns               ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE fba_seller_accounts       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE fba_settlements           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE inventory_locations       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE shopify_orders            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE shopify_payouts           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE shopify_refunds           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE walmart_orders            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE walmart_returns           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE walmart_seller_accounts   ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE walmart_settlements       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- ─── B. Tables previously without DEFAULT (76) — additive safety net ────────
-- B.1 P1 originals (11) — invoices/shipments/receipts/ip_*_master.
-- These are the canonical "11 remaining" from memory project_tangerine_entity_id_default.md.
ALTER TABLE invoices                  ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE invoice_line_items        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE shipments                 ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE shipment_lines            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE shipment_events           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE receipts                  ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE receipt_line_items        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE ip_item_master            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE ip_category_master        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE ip_vendor_master          ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE ip_customer_master        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.2 P1-late + P2 cross-cutters (approvals / notifications / documents /
-- employees / collaboration / AI insights).
ALTER TABLE ai_insights               ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE approval_requests         ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE approval_rules            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE collaboration_workspaces  ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE documents                 ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE employees                 ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE notification_events       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.3 P3 ACC core (inventory layers / FIFO / adjustments / cycle counts /
-- transfers / scanner / payment terms / fabric).
ALTER TABLE fabric_codes              ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE inventory_adjustments     ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE inventory_consumption     ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE inventory_cycle_counts    ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE inventory_layers          ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE inventory_transfers       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE payment_terms             ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE scanner_events            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE scanner_sessions          ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE style_fabric_codes        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.4 P3 AP + P4 AR (invoices / receipts / payments / aging dedup / backfill logs).
ALTER TABLE ar_invoices               ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE ar_receipts               ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE bf_backfill_checkpoint_log ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE bf_skipped_cogs_log       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE bf_unmatched_customers_log ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE invoice_payments          ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE notifications_overdue_log ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.5 GL (P1 + P5 close-core) + tax + compliance.
ALTER TABLE compliance_automation_rules ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE gl_accounts               ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE gl_period_status_log      ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE gl_periods                ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE journal_entries           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE tax_remittances           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE tax_rules                 ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.6 P6 bank recon.
ALTER TABLE bank_accounts             ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE bank_match_audit          ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE bank_recon_runs           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE bank_transactions         ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.7 P7 revenue ops (payments / commissions / cases / RFQs / virtual cards /
-- supply chain finance / dynamic discount / early-payment / marketplace inquiries).
ALTER TABLE cases                     ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE commission_accruals       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE commission_payouts        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE dynamic_discount_offers   ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE early_payment_analytics   ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE marketplace_inquiries     ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE payments                  ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE rfqs                      ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE sales_reps                ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE supply_chain_finance_programs ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE virtual_cards             ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.8 P8 CRM + PIM.
ALTER TABLE crm_activities            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE crm_opportunities         ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE crm_tasks                 ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE customers                 ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE product_attribute_definitions ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE product_attributes        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE product_categories        ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE product_descriptions      ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE product_images            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE style_master              ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.9 Entity-self-referential + workflow + personalization.
ALTER TABLE entity_branding           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE entity_users              ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE entity_vendors            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE user_menu_usage           ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE user_preferences          ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE workflow_executions       ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());
ALTER TABLE workflow_rules            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.10 P11 shopify_stores (P11 chunk1 — only shopify_stores lacked the default).
ALTER TABLE shopify_stores            ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- B.11 Xoro mirror (T10 shadow).
ALTER TABLE xoro_mirror_runs          ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- ─── Sanity probe — current_entity_id() must resolve (even if to NULL) ──────
-- Re-affirm both helpers exist and are STABLE so this migration cannot
-- silently break by being applied against a database missing P10-2.
DO $$
DECLARE
  has_helper boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'current_entity_id'
  ) INTO has_helper;
  IF NOT has_helper THEN
    RAISE EXCEPTION 'P10-3 prerequisite missing: current_entity_id() function not found. Apply 20260629010000_p10_chunk2_current_entity_helper.sql first.';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'rof_entity_id'
  ) INTO has_helper;
  IF NOT has_helper THEN
    RAISE EXCEPTION 'P10-3 prerequisite missing: rof_entity_id() function not found. Apply 20260528000000_tanda_entity_id_default_fix.sql first.';
  END IF;
END $$;

-- ─── PostgREST schema reload ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
