// Static-shape tests for P9-1 migration: Parallel-Run reconciliation
// schema foundation (4 new tables + entities.parallel_run_status jsonb
// extension + RLS template).
//
// Reads the migration SQL and asserts shape — does not require a live
// DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql"),
  "utf8",
);

const RECON_TABLES = [
  "recon_runs",
  "recon_variances",
  "recon_cleared_log",
  "recon_cutover_signoffs",
];

const ENTITY_SCOPED_ROOT_TABLES = [
  "recon_runs",
  "recon_cutover_signoffs",
];

describe("P9-1 — Parallel-Run reconciliation schema migration", () => {
  describe("CREATE TABLE for all 4 recon tables (idempotent)", () => {
    for (const tbl of RECON_TABLES) {
      it(`${tbl}: CREATE TABLE IF NOT EXISTS`, () => {
        expect(MIG).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}`));
      });
    }
  });

  describe("recon_runs — top-level batch table", () => {
    it("entity_id has DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /recon_runs[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\),\s*rof_entity_id\(\)\)/,
      );
    });
    it("entity_id FK to entities with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(
        /recon_runs[\s\S]*?entity_id[\s\S]*?REFERENCES entities\(id\) ON DELETE RESTRICT/,
      );
    });
    it("domain CHECK enforces 5 values (ap/ar/cash/gl/inventory)", () => {
      expect(MIG).toMatch(
        /domain\s+text NOT NULL CHECK \(domain IN \('ap','ar','cash','gl','inventory'\)\)/,
      );
    });
    it("cadence CHECK enforces 3 values (weekly/manual/replay)", () => {
      expect(MIG).toMatch(
        /cadence\s+text NOT NULL DEFAULT 'weekly' CHECK \(cadence IN \('weekly','manual','replay'\)\)/,
      );
    });
    it("status CHECK enforces 5 values (pending/running/clean/variance/error)", () => {
      expect(MIG).toMatch(
        /status\s+text NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending','running','clean','variance','error'\)\)/,
      );
    });
    it("has run_date / period_start / period_end date columns", () => {
      expect(MIG).toMatch(/run_date\s+date NOT NULL/);
      expect(MIG).toMatch(/period_start\s+date NOT NULL/);
      expect(MIG).toMatch(/period_end\s+date NOT NULL/);
    });
    it("has started_at / completed_at timestamptz columns", () => {
      expect(MIG).toMatch(/started_at\s+timestamptz/);
      expect(MIG).toMatch(/completed_at\s+timestamptz/);
    });
    it("totals_jsonb NOT NULL DEFAULT '{}'::jsonb", () => {
      expect(MIG).toMatch(/totals_jsonb\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
    });
    it("replay_of_id self-reference FK to recon_runs with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /replay_of_id\s+uuid REFERENCES recon_runs\(id\) ON DELETE SET NULL/,
      );
    });
    it("has entity+domain+run_date DESC index", () => {
      expect(MIG).toMatch(/recon_runs_entity_domain_date_idx/);
      expect(MIG).toMatch(
        /recon_runs_entity_domain_date_idx[\s\S]*?\(entity_id, domain, run_date DESC\)/,
      );
    });
    it("has partial replay index WHERE replay_of_id IS NOT NULL", () => {
      expect(MIG).toMatch(
        /recon_runs_replay_idx[\s\S]*?WHERE replay_of_id IS NOT NULL/,
      );
    });
  });

  describe("recon_variances — per-row variance records", () => {
    it("recon_run_id FK with ON DELETE CASCADE", () => {
      expect(MIG).toMatch(
        /recon_run_id\s+uuid NOT NULL REFERENCES recon_runs\(id\) ON DELETE CASCADE/,
      );
    });
    it("has source_table / source_id text NOT NULL", () => {
      expect(MIG).toMatch(/source_table\s+text NOT NULL/);
      expect(MIG).toMatch(/source_id\s+text NOT NULL/);
    });
    it("has nullable source_tag column (T10 enum)", () => {
      expect(MIG).toMatch(/source_tag\s+text(?!\s+NOT NULL)/);
    });
    it("has tangerine/xoro/variance _amount_cents bigint NOT NULL", () => {
      for (const col of [
        "tangerine_amount_cents",
        "xoro_amount_cents",
        "variance_amount_cents",
      ]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint NOT NULL`));
      }
    });
    it("variance_percent numeric(8,4)", () => {
      expect(MIG).toMatch(/variance_percent\s+numeric\(8,4\)/);
    });
    it("status CHECK enforces 4 values (within/over/cleared/suppressed)", () => {
      expect(MIG).toMatch(
        /status\s+text NOT NULL DEFAULT 'over' CHECK \(status IN \('within','over','cleared','suppressed'\)\)/,
      );
    });
    it("has run_idx index", () => {
      expect(MIG).toMatch(/recon_variances_run_idx[\s\S]*?\(recon_run_id\)/);
    });
    it("has source_idx composite index", () => {
      expect(MIG).toMatch(
        /recon_variances_source_idx[\s\S]*?\(source_table, source_id\)/,
      );
    });
    it("has partial status_idx WHERE status = 'over'", () => {
      expect(MIG).toMatch(
        /recon_variances_status_idx[\s\S]*?WHERE status = 'over'/,
      );
    });
  });

  describe("recon_cleared_log — manual clearance audit trail", () => {
    it("recon_variance_id FK with ON DELETE CASCADE", () => {
      expect(MIG).toMatch(
        /recon_variance_id\s+uuid NOT NULL REFERENCES recon_variances\(id\) ON DELETE CASCADE/,
      );
    });
    it("cleared_by_auth_id FK to auth.users with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /cleared_by_auth_id\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/,
      );
    });
    it("cleared_by_employee_id FK to employees with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /cleared_by_employee_id\s+uuid REFERENCES employees\(id\) ON DELETE SET NULL/,
      );
    });
    it("reason text NOT NULL (audit trail requires justification)", () => {
      expect(MIG).toMatch(/reason\s+text NOT NULL/);
    });
    it("cleared_at timestamptz NOT NULL DEFAULT now()", () => {
      expect(MIG).toMatch(/cleared_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    });
    it("has variance_idx index", () => {
      expect(MIG).toMatch(
        /recon_cleared_log_variance_idx[\s\S]*?\(recon_variance_id\)/,
      );
    });
  });

  describe("recon_cutover_signoffs — D8 solo-cutover trail", () => {
    it("entity_id has DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /recon_cutover_signoffs[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\),\s*rof_entity_id\(\)\)/,
      );
    });
    it("entity_id FK to entities with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(
        /recon_cutover_signoffs[\s\S]*?entity_id[\s\S]*?REFERENCES entities\(id\) ON DELETE RESTRICT/,
      );
    });
    it("has domain text NOT NULL", () => {
      expect(MIG).toMatch(
        /recon_cutover_signoffs[\s\S]*?domain\s+text NOT NULL/,
      );
    });
    it("has nullable source_tag (D7 channel-level)", () => {
      expect(MIG).toMatch(
        /recon_cutover_signoffs[\s\S]*?source_tag\s+text(?!\s+NOT NULL)/,
      );
    });
    it("has clean_window_start / clean_window_end date NOT NULL", () => {
      expect(MIG).toMatch(/clean_window_start\s+date NOT NULL/);
      expect(MIG).toMatch(/clean_window_end\s+date NOT NULL/);
    });
    it("total_recons int NOT NULL", () => {
      expect(MIG).toMatch(/total_recons\s+int NOT NULL/);
    });
    it("signoff_employee_id FK to employees with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /signoff_employee_id\s+uuid REFERENCES employees\(id\) ON DELETE SET NULL/,
      );
    });
    it("UNIQUE (entity_id, domain, source_tag)", () => {
      expect(MIG).toMatch(/UNIQUE \(entity_id, domain, source_tag\)/);
    });
  });

  describe("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id()) on entity-scoped roots", () => {
    for (const tbl of ENTITY_SCOPED_ROOT_TABLES) {
      it(`${tbl}: DEFAULT coalesce(current_entity_id(), rof_entity_id())`, () => {
        const re = new RegExp(
          `${tbl}[\\s\\S]*?entity_id\\s+uuid NOT NULL DEFAULT coalesce\\(current_entity_id\\(\\),\\s*rof_entity_id\\(\\)\\)`,
        );
        expect(MIG).toMatch(re);
      });
    }
  });

  describe("entities.parallel_run_status jsonb extension (D10)", () => {
    it("adds the column via ALTER TABLE ... ADD COLUMN IF NOT EXISTS", () => {
      expect(MIG).toMatch(
        /ALTER TABLE entities[\s\S]*?ADD COLUMN IF NOT EXISTS parallel_run_status jsonb NOT NULL DEFAULT '\{\}'::jsonb/,
      );
    });
  });

  describe("RLS — anon_all_* + auth_internal_* template on all 4 tables", () => {
    for (const tbl of RECON_TABLES) {
      it(`${tbl}: ENABLE ROW LEVEL SECURITY`, () => {
        expect(MIG).toMatch(
          new RegExp(`ALTER TABLE ${tbl}\\s+ENABLE ROW LEVEL SECURITY`),
        );
      });
      it(`${tbl}: anon_all_* policy created`, () => {
        expect(MIG).toMatch(new RegExp(`anon_all_${tbl}`));
      });
      it(`${tbl}: auth_internal_* policy created`, () => {
        expect(MIG).toMatch(new RegExp(`auth_internal_${tbl}`));
      });
    }
    it("auth_internal_recon_variances gates via parent recon_run entity_id", () => {
      expect(MIG).toMatch(
        /auth_internal_recon_variances[\s\S]*?FROM recon_runs rr[\s\S]*?entity_users eu/,
      );
    });
    it("auth_internal_recon_cleared_log gates via grandparent recon_run entity_id", () => {
      expect(MIG).toMatch(
        /auth_internal_recon_cleared_log[\s\S]*?FROM recon_variances rv[\s\S]*?JOIN recon_runs rr[\s\S]*?entity_users eu/,
      );
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("idempotency primitives", () => {
    it("all 4 table creates use IF NOT EXISTS", () => {
      const creates = MIG.match(/CREATE TABLE IF NOT EXISTS/g) || [];
      expect(creates.length).toBeGreaterThanOrEqual(4);
    });
    it("no bare CREATE TABLE without IF NOT EXISTS", () => {
      const bare = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
      expect(bare.length).toBe(0);
    });
    it("RLS policies wrapped in DO $$ ... EXCEPTION WHEN duplicate_object", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      // 4 tables × (anon + auth_internal) = 8 policies
      expect(wrapped.length).toBeGreaterThanOrEqual(8);
    });
    it("entities.parallel_run_status uses ADD COLUMN IF NOT EXISTS", () => {
      expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS parallel_run_status/);
    });
    it("all CREATE INDEX statements use IF NOT EXISTS", () => {
      const bareIdx = MIG.match(/CREATE INDEX(?! IF NOT EXISTS)/g) || [];
      expect(bareIdx.length).toBe(0);
    });
  });

  describe("no COMMENT-concat regressions (lint — see migration header)", () => {
    // Strip line-comments so prose in the header doesn't trip the lint.
    const sqlOnly = MIG
      .split(/\r?\n/)
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");

    // Extract each COMMENT ON statement up to its trailing `';` boundary.
    const commentStatements = sqlOnly.match(/COMMENT ON[^\n]*?'\s*;/g) || [];

    it("found at least 4 COMMENT ON statements", () => {
      expect(commentStatements.length).toBeGreaterThanOrEqual(4);
    });

    it("no COMMENT ON statement uses || concat", () => {
      for (const stmt of commentStatements) {
        expect(stmt).not.toMatch(/\|\|/);
      }
    });

    it("every COMMENT ON statement contains an IS '...' literal", () => {
      for (const stmt of commentStatements) {
        expect(stmt).toMatch(/IS\s+'[^']*'\s*;\s*$/);
      }
    });
  });
});
