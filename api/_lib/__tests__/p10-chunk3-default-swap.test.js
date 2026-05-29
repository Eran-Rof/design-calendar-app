// Static-shape sanity checks on the P10-3 DEFAULT entity_id swap migration.
//
// Verifies that every in-scope entity-scoped table has its entity_id DEFAULT
// set to coalesce(current_entity_id(), rof_entity_id()) — the safer rollout
// pattern that keeps service-role inserts without a GUC defaulting to ROF.
//
// Source list mirrors the SWAP_TABLES constant below. Adding a new
// entity-scoped table without a SET DEFAULT here will fail the count check;
// removing one will fail the per-table check.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260629020000_p10_chunk3_default_entity_swap.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

// Canonical scope — 93 entity-scoped tables. tanda_pos + po_line_items are
// deliberately excluded (PR #463 handles them; P10-4 follow-up swaps them
// together with the dispatcher GUC wiring).
const SWAP_TABLES = [
  // P11/P12 marketplace tables that previously had DEFAULT rof_entity_id() —
  // true swap to coalesce.
  "faire_buyers",
  "faire_orders",
  "faire_payouts",
  "faire_shops",
  "fba_inventory_snapshots",
  "fba_orders",
  "fba_returns",
  "fba_seller_accounts",
  "fba_settlements",
  "inventory_locations",
  "shopify_orders",
  "shopify_payouts",
  "shopify_refunds",
  "walmart_orders",
  "walmart_returns",
  "walmart_seller_accounts",
  "walmart_settlements",
  // P1 originals from memory project_tangerine_entity_id_default.md —
  // additive (no prior DEFAULT).
  "invoices",
  "invoice_line_items",
  "shipments",
  "shipment_lines",
  "shipment_events",
  "receipts",
  "receipt_line_items",
  "ip_item_master",
  "ip_category_master",
  "ip_vendor_master",
  "ip_customer_master",
  // P1-late + P2 cross-cutters.
  "ai_insights",
  "approval_requests",
  "approval_rules",
  "collaboration_workspaces",
  "documents",
  "employees",
  "notification_events",
  // P3 ACC core.
  "fabric_codes",
  "inventory_adjustments",
  "inventory_consumption",
  "inventory_cycle_counts",
  "inventory_layers",
  "inventory_transfers",
  "payment_terms",
  "scanner_events",
  "scanner_sessions",
  "style_fabric_codes",
  // P3 AP + P4 AR.
  "ar_invoices",
  "ar_receipts",
  "bf_backfill_checkpoint_log",
  "bf_skipped_cogs_log",
  "bf_unmatched_customers_log",
  "invoice_payments",
  "notifications_overdue_log",
  // GL (P1 + P5 close-core) + tax + compliance.
  "compliance_automation_rules",
  "gl_accounts",
  "gl_period_status_log",
  "gl_periods",
  "journal_entries",
  "tax_remittances",
  "tax_rules",
  // P6 bank recon.
  "bank_accounts",
  "bank_match_audit",
  "bank_recon_runs",
  "bank_transactions",
  // P7 revenue ops.
  "cases",
  "commission_accruals",
  "commission_payouts",
  "dynamic_discount_offers",
  "early_payment_analytics",
  "marketplace_inquiries",
  "payments",
  "rfqs",
  "sales_reps",
  "supply_chain_finance_programs",
  "virtual_cards",
  // P8 CRM + PIM.
  "crm_activities",
  "crm_opportunities",
  "crm_tasks",
  "customers",
  "product_attribute_definitions",
  "product_attributes",
  "product_categories",
  "product_descriptions",
  "product_images",
  "style_master",
  // Entity-self-referential + workflow + personalization.
  "entity_branding",
  "entity_users",
  "entity_vendors",
  "user_menu_usage",
  "user_preferences",
  "workflow_executions",
  "workflow_rules",
  // P11 shopify_stores.
  "shopify_stores",
  // T10 Xoro mirror.
  "xoro_mirror_runs",
];

describe("P10-3 migration — DEFAULT entity_id swap static shape", () => {
  describe("filename convention", () => {
    it("matches the dated _p10_chunk3_*.sql naming convention", () => {
      expect(basename(MIGRATION_PATH)).toMatch(
        /^20260629020000_p10_chunk3_default_entity_swap\.sql$/,
      );
    });
  });

  describe("scope — 93 tables in the canonical swap list", () => {
    it("SWAP_TABLES holds exactly 93 unique tables", () => {
      expect(SWAP_TABLES.length).toBe(93);
      expect(new Set(SWAP_TABLES).size).toBe(93);
    });

    it("does NOT include tanda_pos (deferred to P10-4 with dispatcher wiring)", () => {
      expect(SWAP_TABLES).not.toContain("tanda_pos");
      // And the migration body must not touch it either.
      expect(SQL).not.toMatch(/ALTER TABLE\s+tanda_pos\s+ALTER COLUMN entity_id/);
    });

    it("does NOT include po_line_items (deferred to P10-4)", () => {
      expect(SWAP_TABLES).not.toContain("po_line_items");
      expect(SQL).not.toMatch(/ALTER TABLE\s+po_line_items\s+ALTER COLUMN entity_id/);
    });
  });

  describe("per-table SET DEFAULT statements", () => {
    for (const table of SWAP_TABLES) {
      it(`${table} → SET DEFAULT coalesce(current_entity_id(), rof_entity_id())`, () => {
        // Escape any regex metachars in the table name (none today, but be safe).
        const safe = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(
          `ALTER TABLE\\s+${safe}\\s+ALTER COLUMN entity_id SET DEFAULT coalesce\\(current_entity_id\\(\\), rof_entity_id\\(\\)\\);`,
        );
        expect(SQL).toMatch(pattern);
      });
    }
  });

  describe("count integrity — migration body has exactly 93 ALTER COLUMN statements", () => {
    it("emits one ALTER COLUMN entity_id SET DEFAULT per in-scope table", () => {
      const matches =
        SQL.match(
          /^ALTER TABLE\s+\w+\s+ALTER COLUMN entity_id SET DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\);/gm,
        ) || [];
      expect(matches.length).toBe(93);
    });

    it("each ALTER statement uses the same coalesce body (no drift)", () => {
      const altered =
        SQL.match(
          /^ALTER TABLE\s+\w+\s+ALTER COLUMN entity_id SET DEFAULT ([^;]+);/gm,
        ) || [];
      for (const stmt of altered) {
        expect(stmt).toMatch(
          /SET DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
        );
      }
    });
  });

  describe("idempotent shape — no DROP DEFAULT, no SET NOT NULL", () => {
    it("contains no ALTER COLUMN entity_id DROP DEFAULT statements", () => {
      expect(SQL).not.toMatch(/ALTER COLUMN entity_id DROP DEFAULT/i);
    });

    it("contains no ALTER COLUMN entity_id SET NOT NULL statements", () => {
      // SET NOT NULL would fail on a re-run since the column is already NOT NULL.
      expect(SQL).not.toMatch(/ALTER COLUMN entity_id SET NOT NULL/i);
    });

    it("contains no ALTER COLUMN entity_id TYPE statements (would rewrite column)", () => {
      expect(SQL).not.toMatch(/ALTER COLUMN entity_id TYPE/i);
    });
  });

  describe("prerequisite sanity probes", () => {
    it("guards on current_entity_id() helper presence (P10-2 prerequisite)", () => {
      expect(SQL).toMatch(/proname = 'current_entity_id'/);
      expect(SQL).toMatch(/current_entity_id\(\) function not found/);
    });

    it("guards on rof_entity_id() helper presence (PR #463 prerequisite)", () => {
      expect(SQL).toMatch(/proname = 'rof_entity_id'/);
      expect(SQL).toMatch(/rof_entity_id\(\) function not found/);
    });

    it("uses RAISE EXCEPTION (not RAISE WARNING) so a missing prereq aborts", () => {
      expect(SQL).toMatch(/RAISE EXCEPTION 'P10-3 prerequisite missing/);
    });
  });

  describe("documentation + cache reload", () => {
    it("ends with NOTIFY pgrst 'reload schema'", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });

    it("header explains the coalesce(current_entity_id(), rof_entity_id()) rationale", () => {
      expect(SQL).toMatch(/coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/);
      expect(SQL).toMatch(/service-role/i);
      expect(SQL).toMatch(/P10-4/);
    });
  });

  describe("no COMMENT-concat regressions (lint — see PR #486)", () => {
    // Strip line-comments so prose in the header doesn't trip the lint.
    const sqlOnly = SQL.split(/\r?\n/)
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");

    // Extract each COMMENT ON statement up to its trailing `';` boundary.
    const commentStatements = sqlOnly.match(/COMMENT ON[^\n]*?'\s*;/g) || [];

    it("any COMMENT ON statements use IS '...' literals, no || concat", () => {
      // P10-3 has zero COMMENT ON statements (it's pure ALTER), but if a
      // future edit adds one, it must not use ||.
      for (const stmt of commentStatements) {
        expect(stmt).not.toMatch(/\|\|/);
        expect(stmt).toMatch(/IS\s+'[^']*'\s*;\s*$/);
      }
    });
  });
});
