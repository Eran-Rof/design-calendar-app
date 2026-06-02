// @vitest-environment node
//
// P15 C1d — channel_id column-wiring migration shape test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260710030000_p15_c1d_channel_id_columns.sql"),
  "utf8",
);

describe("P15-C1d — channel_id columns", () => {
  it("creates the channel_id_by_code() STABLE helper", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION channel_id_by_code\(p_code text\) RETURNS uuid/);
    expect(SQL).toMatch(/STABLE/);
  });

  it("maps each sales table to its correct channel", () => {
    const pairs = [
      ["shopify_orders", "DTC"], ["shopify_order_lines", "DTC"],
      ["fba_orders", "FBA"], ["walmart_orders", "WALMART"], ["faire_orders", "FAIRE"],
      ["ip_sales_history_ecom", "DTC"], ["ip_sales_history_wholesale", "WHOLESALE"],
      ["ar_invoices", "WHOLESALE"], ["ar_invoice_lines", "WHOLESALE"], ["ar_receipts", "WHOLESALE"],
    ];
    for (const [t, code] of pairs) {
      expect(SQL).toMatch(new RegExp(`\\['${t}',\\s*'${code}'\\]`));
    }
  });

  it("adds channel_id additively (nullable FK), per-table default, backfill, index", () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES channel_master\(id\) ON DELETE RESTRICT/);
    expect(SQL).toMatch(/ALTER COLUMN channel_id SET DEFAULT channel_id_by_code\(%L\)/);
    expect(SQL).toMatch(/UPDATE public\.%I SET channel_id = channel_id_by_code\(%L\) WHERE channel_id IS NULL/);
  });

  it("does NOT add channel to purchasing/AP (channel is a sales axis)", () => {
    expect(SQL).not.toMatch(/'tanda_pos'/);
    expect(SQL).not.toMatch(/'po_line_items'/);
    expect(SQL).not.toMatch(/\['invoices'/);   // AP invoices (vendor-facing)
    expect(SQL).not.toMatch(/\['payments'/);
  });

  it("is additive only (no NOT NULL) + guards missing tables", () => {
    expect(SQL).not.toMatch(/SET NOT NULL/);
    expect(SQL).toMatch(/to_regclass\(format\('public\.%I', t\)\) IS NULL/);
  });
});
