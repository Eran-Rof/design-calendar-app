// Static-shape tests for P13-5 migration: case_id link on
// tanda_po_qc_inspections. Reads the migration SQL and asserts shape —
// does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629C10000_p13_chunk5_qc_case_link.sql"),
  "utf8",
);

describe("P13-5 — QC case-link migration", () => {
  it("adds case_id column with IF NOT EXISTS (idempotent)", () => {
    expect(MIG).toMatch(/ALTER TABLE tanda_po_qc_inspections ADD COLUMN IF NOT EXISTS case_id uuid/);
  });

  it("declares case_id as FK to cases(id)", () => {
    expect(MIG).toMatch(/REFERENCES cases\(id\)/);
  });

  it("uses ON DELETE SET NULL so case removal doesn't cascade into inspections", () => {
    expect(MIG).toMatch(/ON DELETE SET NULL/);
  });

  it("creates a partial index on case_id WHERE case_id IS NOT NULL", () => {
    expect(MIG).toMatch(/CREATE INDEX IF NOT EXISTS tanda_po_qc_inspections_case_idx[\s\S]*WHERE case_id IS NOT NULL/);
  });

  it("ends with NOTIFY pgrst, 'reload schema' for PostgREST cache refresh", () => {
    expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });

  it("does NOT use COMMENT-concat (`IS 'a' || 'b'`)", () => {
    expect(MIG).not.toMatch(/IS\s+'[^']*'\s*\|\|/);
  });

  it("contains the canonical P13-5 chunk banner", () => {
    expect(MIG).toMatch(/Tangerine P13-5/);
  });

  it("references the M26 module and the M47/P7-9 case linkage in comments", () => {
    expect(MIG).toMatch(/M26/);
    expect(MIG).toMatch(/P7-9/);
  });
});
