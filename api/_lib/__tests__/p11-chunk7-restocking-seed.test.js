// Static-shape tests for P11-7 migration: idempotent 4500 Restocking Fee
// Income GL seed (belt-and-suspenders guard; canonical seed lives in
// P11-1's 20260629100000 migration). Reads SQL — no live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629500000_p11_chunk7_restocking_seed.sql"),
  "utf8",
);

describe("P11-7 — restocking GL seed migration", () => {
  describe("ROF entity lookup", () => {
    it("uses SELECT id INTO v_rof FROM entities WHERE code = 'ROF'", () => {
      expect(MIG).toMatch(/SELECT id INTO v_rof FROM entities WHERE code = 'ROF'/);
    });
    it("guards against missing ROF entity with RAISE NOTICE + RETURN", () => {
      expect(MIG).toMatch(/IF v_rof IS NULL THEN/);
      expect(MIG).toMatch(/RAISE NOTICE/);
      expect(MIG).toMatch(/RETURN;/);
    });
  });

  describe("4500 Restocking Fee Income seed (D8)", () => {
    it("seeds account code 4500 with name 'Restocking Fee Income'", () => {
      expect(MIG).toMatch(/'4500',\s*'Restocking Fee Income'/);
    });
    it("account_type='revenue' and normal_balance='CREDIT'", () => {
      expect(MIG).toMatch(/'4500',\s*'Restocking Fee Income',\s*'revenue',\s*'CREDIT'/);
    });
    it("is_postable=true and status='active'", () => {
      expect(MIG).toMatch(/'revenue',\s*'CREDIT',\s*true,\s*'active'/);
    });
    it("uses ON CONFLICT (entity_id, code) DO NOTHING for idempotency", () => {
      expect(MIG).toMatch(/ON CONFLICT \(entity_id, code\) DO NOTHING/);
    });
    it("targets the gl_accounts table", () => {
      expect(MIG).toMatch(/INSERT INTO gl_accounts/);
    });
  });

  describe("idempotency primitives", () => {
    it("wraps INSERT in a DO $$ ... $$ block", () => {
      expect(MIG).toMatch(/DO \$\$\s*DECLARE\s+v_rof uuid;/);
    });
    it("contains exactly one executable ON CONFLICT clause (single 4500 seed)", () => {
      // Filter out comment lines so the inline rationale doesn't double-count.
      const executable = MIG.split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
      const conflicts = executable.match(/ON CONFLICT \(entity_id, code\) DO NOTHING/g) || [];
      expect(conflicts.length).toBe(1);
    });
    it("contains exactly one INSERT (single 4500 seed)", () => {
      const executable = MIG.split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
      const inserts = executable.match(/INSERT INTO gl_accounts/g) || [];
      expect(inserts.length).toBe(1);
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });
});
