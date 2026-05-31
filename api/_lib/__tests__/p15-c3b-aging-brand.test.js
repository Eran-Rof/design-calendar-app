// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260710050000_p15_c3b_aging_brand.sql"),
  "utf8",
);

describe("P15-C3b — brand-aware aging views + RPCs", () => {
  it("adds brand_id to both aging views' GROUP BY", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_ar_aging[\s\S]*?GROUP BY[^;]*inv\.brand_id/);
    expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_ap_aging_buckets[\s\S]*?GROUP BY[^;]*inv\.brand_id/);
  });

  it("re-creates both RPCs with an optional p_brand_id DEFAULT NULL", () => {
    expect(SQL).toMatch(/DROP FUNCTION IF EXISTS ar_aging_as_of\(uuid, date\)/);
    expect(SQL).toMatch(/DROP FUNCTION IF EXISTS ap_aging_as_of\(uuid, date\)/);
    expect(SQL).toMatch(/FUNCTION ar_aging_as_of\(p_entity_id uuid, p_as_of_date date, p_brand_id uuid DEFAULT NULL\)/);
    expect(SQL).toMatch(/FUNCTION ap_aging_as_of\(p_entity_id uuid, p_as_of_date date, p_brand_id uuid DEFAULT NULL\)/);
  });

  it("filters by brand BEFORE aggregating (null = all brands)", () => {
    const m = SQL.match(/\(p_brand_id IS NULL OR i\.brand_id = p_brand_id\)/g) || [];
    expect(m.length).toBe(2); // AR + AP RPC
  });

  it("preserves the RPC output grain (GROUP BY party only, not brand)", () => {
    // The wide RPCs still group by customer / vendor — brand is a pre-filter, not a dimension.
    expect(SQL).toMatch(/GROUP BY c\.id, c\.name;/);
    expect(SQL).toMatch(/GROUP BY v\.id, v\.name, v\.code;/);
  });

  it("reloads PostgREST", () => {
    expect(SQL).toMatch(/NOTIFY pgrst/);
  });
});
