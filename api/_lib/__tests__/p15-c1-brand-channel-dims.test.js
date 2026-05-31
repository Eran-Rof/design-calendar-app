// @vitest-environment node
//
// P15 C1 — brand/channel/partition dimension migration shape test.
// Static assertions over the migration SQL (migrations apply via
// supabase-db-push, not CI), matching the other pNN-chunk*-schema tests.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260710000000_p15_c1_brand_channel_dims.sql"),
  "utf8",
);

describe("P15-C1 — brand/channel/partition dimensions", () => {
  it("creates the 4 dimension tables", () => {
    for (const t of ["brand_master", "channel_master", "inventory_partition", "brand_channel_partition"]) {
      expect(SQL).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
    }
  });

  it("brand_master FKs the entity + is unique per (entity, code) + one default per entity", () => {
    expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\)/);
    expect(SQL).toMatch(/DEFAULT rof_entity_id\(\)/);
    expect(SQL).toMatch(/UNIQUE \(entity_id, code\)/);
    expect(SQL).toMatch(/uq_brand_default_per_entity[\s\S]*?WHERE is_default/);
  });

  it("partition map is keyed (brand, channel) and FKs all three dimensions", () => {
    expect(SQL).toMatch(/brand_channel_partition[\s\S]*?PRIMARY KEY \(brand_id, channel_id\)/);
    expect(SQL).toMatch(/partition_id uuid NOT NULL REFERENCES inventory_partition\(id\)/);
  });

  it("seeds the 8 CEO-confirmed brands (PLM removed; Axe Crown + 2 MPL brands present)", () => {
    for (const code of ["'ROF'", "'PT'", "'DEPARTED'", "'FORTKNOX'", "'BLUERISE'", "'AXECROWN'", "'MPLEPIC'", "'MPLSUNSTONE'"]) {
      expect(SQL).toMatch(new RegExp(`\\(rof_entity_id\\(\\), ${code},`));
    }
    expect(SQL).toMatch(/'Axe Crown'/);
    expect(SQL).toMatch(/'MPL Epic'/);
    expect(SQL).toMatch(/'MPL Sun & Stone'/);
    expect(SQL).not.toMatch(/'PLM'/);                   // PLM dropped per CEO
    expect(SQL).toMatch(/'ROF', +'Ring of Fire', +true/); // ROF is the default
  });

  it("seeds the 5 channels", () => {
    for (const code of ["'DTC'", "'WHOLESALE'", "'FBA'", "'WALMART'", "'FAIRE'"]) {
      expect(SQL).toMatch(new RegExp(`\\(${code},`));
    }
  });

  it("PT shares one pool; non-PT brands get separate WS + EC pools", () => {
    // PT single pool, mapped for every channel via CROSS JOIN.
    expect(SQL).toMatch(/'PT', 'Psycho Tuna — Shared'/);
    expect(SQL).toMatch(/CROSS JOIN channel_master c[\s\S]*?b\.code = 'PT'/);
    // Non-PT brands get -WS and -EC partitions.
    expect(SQL).toMatch(/b\.code \|\| '-WS'/);
    expect(SQL).toMatch(/b\.code \|\| '-EC'/);
    // Marketplaces currently map to the Ecom pool alongside DTC.
    expect(SQL).toMatch(/c\.code IN \('DTC','FBA','WALMART','FAIRE'\)/);
  });

  it("is anon-read-only on all 4 tables (browser reads, writes are migration-only)", () => {
    const reads = SQL.match(/CREATE POLICY "anon_read_[a-z_]+" ON \w+ FOR SELECT TO anon USING \(true\)/g) || [];
    expect(reads.length).toBe(4);
    expect(SQL).not.toMatch(/FOR ALL TO anon/);
  });

  it("audits the privileged brand table + reloads PostgREST", () => {
    expect(SQL).toMatch(/CREATE TRIGGER trg_brand_master_audit[\s\S]*?audit_row_changes_trigger\(\)/);
    expect(SQL).toMatch(/NOTIFY pgrst/);
  });
});
