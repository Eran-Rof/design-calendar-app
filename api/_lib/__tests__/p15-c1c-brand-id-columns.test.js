// @vitest-environment node
//
// P15 C1c — brand_id column-wiring migration shape test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260710020000_p15_c1c_brand_id_columns.sql"),
  "utf8",
);

// The 20 tables (real names, verified against the schema) that get brand_id.
const TABLES = [
  "style_master", "ip_item_master", "tanda_pos", "po_line_items",
  "journal_entries", "journal_entry_lines", "ar_invoices", "ar_invoice_lines",
  "ar_receipts", "invoices", "payments", "shopify_orders", "shopify_order_lines",
  "fba_orders", "walmart_orders", "faire_orders", "ip_sales_history_wholesale",
  "ip_sales_history_ecom", "inventory_adjustments", "label_batches",
];

describe("P15-C1c — brand_id columns", () => {
  it("creates the rof_default_brand_id() STABLE helper", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION rof_default_brand_id\(\) RETURNS uuid/);
    expect(SQL).toMatch(/is_default = true/);
    expect(SQL).toMatch(/STABLE/);
  });

  it("lists all 20 target tables in the loop", () => {
    for (const t of TABLES) {
      expect(SQL).toMatch(new RegExp(`'${t}'`));
    }
  });

  it("adds brand_id additively (nullable FK), defaults to ROF, backfills, indexes", () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master\(id\) ON DELETE RESTRICT/);
    expect(SQL).toMatch(/ALTER COLUMN brand_id SET DEFAULT rof_default_brand_id\(\)/);
    expect(SQL).toMatch(/UPDATE public\.%I SET brand_id = rof_default_brand_id\(\) WHERE brand_id IS NULL/);
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });

  it("does NOT set NOT NULL (required-tagging is the later C4 flip)", () => {
    expect(SQL).not.toMatch(/SET NOT NULL/);
    expect(SQL).not.toMatch(/brand_id uuid NOT NULL/);
  });

  it("EXCLUDES ip_item_avg_cost (it has real brand_name data; handled separately)", () => {
    expect(SQL).not.toMatch(/'ip_item_avg_cost'/);
  });

  it("guards against a missing table (defensive to_regclass skip)", () => {
    expect(SQL).toMatch(/to_regclass\(format\('public\.%I', t\)\) IS NULL/);
  });
});
