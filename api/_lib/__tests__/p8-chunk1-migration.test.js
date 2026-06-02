// Static-shape sanity checks on the P8-1 CRM schema migration.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(
    __dirname,
    "../../../supabase/migrations/20260616000000_p8_chunk1_crm_schema.sql",
  ),
  "utf8",
);

describe("P8-1 migration — static shape", () => {
  describe("crm_opportunities", () => {
    it("creates the table with entity + customer FKs", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_opportunities/);
      expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\) ON DELETE RESTRICT/);
      expect(SQL).toMatch(/customer_id\s+uuid REFERENCES customers\(id\) ON DELETE SET NULL/);
    });
    it("includes the 5-stage state machine CHECK", () => {
      expect(SQL).toMatch(/stage\s+text NOT NULL DEFAULT 'new'/);
      expect(SQL).toMatch(
        /CHECK \(stage IN \('new','qualified','proposal','won','lost'\)\)/,
      );
    });
    it("includes expected_cents non-negative CHECK", () => {
      expect(SQL).toMatch(
        /expected_cents\s+bigint CHECK \(expected_cents IS NULL OR expected_cents >= 0\)/,
      );
    });
    it("includes probability_pct BETWEEN 0 AND 100 CHECK", () => {
      expect(SQL).toMatch(/probability_pct\s+smallint NOT NULL DEFAULT 50/);
      expect(SQL).toMatch(/CHECK \(probability_pct BETWEEN 0 AND 100\)/);
    });
    it("owner_user_id references auth.users", () => {
      expect(SQL).toMatch(/owner_user_id\s+uuid REFERENCES auth\.users\(id\)/);
    });
    it("has entity-unique opportunity_number constraint", () => {
      expect(SQL).toMatch(
        /CONSTRAINT crm_opp_number_per_entity_unique UNIQUE \(entity_id, opportunity_number\)/,
      );
    });
    it("has stage index + customer index + owner index + pipeline-report index", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_crm_opp_stage\s+ON crm_opportunities \(stage\)/);
      expect(SQL).toMatch(/idx_crm_opp_customer/);
      expect(SQL).toMatch(/idx_crm_opp_owner/);
      expect(SQL).toMatch(
        /idx_crm_opp_stage_value[\s\S]*?\(stage, expected_cents DESC NULLS LAST\)/,
      );
    });
  });

  describe("crm_activities", () => {
    it("creates the table with FKs to entities, customers, opportunities, cases", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_activities/);
      expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\)/);
      expect(SQL).toMatch(/opportunity_id\s+uuid REFERENCES crm_opportunities\(id\)/);
      expect(SQL).toMatch(/case_id\s+uuid REFERENCES cases\(id\) ON DELETE SET NULL/);
    });
    it("includes activity_type CHECK enum (all 8 types)", () => {
      expect(SQL).toMatch(
        /CHECK \(activity_type IN \('note','call','email_in','email_out','meeting','task_done','stage_change','system'\)\)/,
      );
    });
    it("has is_hidden boolean default false", () => {
      expect(SQL).toMatch(/is_hidden\s+boolean NOT NULL DEFAULT false/);
    });
    it("has indexes for customer / opportunity / type-by-date", () => {
      expect(SQL).toMatch(
        /idx_crm_act_customer[\s\S]*?\(customer_id, occurred_at DESC\)/,
      );
      expect(SQL).toMatch(/idx_crm_act_opp[\s\S]*?\(opportunity_id, occurred_at DESC\)/);
      expect(SQL).toMatch(/idx_crm_act_type_date[\s\S]*?\(activity_type, occurred_at DESC\)/);
    });
    it("RLS has SELECT + INSERT + UPDATE policies but NO DELETE policy", () => {
      expect(SQL).toMatch(/anon_select_crm_activities[\s\S]*?FOR SELECT/);
      expect(SQL).toMatch(/anon_insert_crm_activities[\s\S]*?FOR INSERT/);
      expect(SQL).toMatch(/anon_update_crm_activities_is_hidden[\s\S]*?FOR UPDATE/);
      // No DELETE policy granted anywhere → no role can delete activity rows.
      expect(SQL).not.toMatch(/FOR DELETE[\s\S]*?crm_activities/);
      // No FOR ALL on crm_activities (would otherwise allow DELETE).
      expect(SQL).not.toMatch(/anon_all_crm_activities\b/);
    });
  });

  describe("crm_tasks", () => {
    it("creates the table with status state machine CHECK", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_tasks/);
      expect(SQL).toMatch(/status\s+text NOT NULL DEFAULT 'open'/);
      expect(SQL).toMatch(
        /CHECK \(status IN \('open','in_progress','done','cancelled'\)\)/,
      );
    });
    it("includes priority CHECK enum", () => {
      expect(SQL).toMatch(/priority\s+text NOT NULL DEFAULT 'normal'/);
      expect(SQL).toMatch(
        /CHECK \(priority IN \('low','normal','high','urgent'\)\)/,
      );
    });
    it("assignee_user_id references auth.users", () => {
      expect(SQL).toMatch(/assignee_user_id\s+uuid REFERENCES auth\.users\(id\)/);
    });
    it("captures completed_at + completed_by_user_id columns", () => {
      expect(SQL).toMatch(/completed_at\s+timestamptz/);
      expect(SQL).toMatch(/completed_by_user_id\s+uuid REFERENCES auth\.users\(id\)/);
    });
    it("has title-nonempty CHECK", () => {
      expect(SQL).toMatch(
        /CONSTRAINT crm_task_title_nonempty CHECK \(char_length\(trim\(title\)\) > 0\)/,
      );
    });
    it("has partial assignee+due_date index restricted to open / in_progress", () => {
      expect(SQL).toMatch(/idx_crm_tasks_assignee_open/);
      expect(SQL).toMatch(/WHERE status IN \('open','in_progress'\)/);
    });
  });

  describe("triggers", () => {
    it("BEFORE UPDATE on crm_opportunities touches updated_at + stage_changed_at", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION crm_opp_touch\(\)/);
      expect(SQL).toMatch(/CREATE TRIGGER crm_opp_touch_trg[\s\S]*?BEFORE UPDATE ON crm_opportunities/);
      expect(SQL).toMatch(/NEW\.stage_changed_at = now\(\)/);
    });
    it("AFTER UPDATE on crm_opportunities logs a stage_change activity row", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION crm_opp_stage_change_audit\(\)/);
      expect(SQL).toMatch(
        /CREATE TRIGGER crm_opp_stage_change_audit_trg[\s\S]*?AFTER UPDATE OF stage ON crm_opportunities/,
      );
      expect(SQL).toMatch(/INSERT INTO crm_activities[\s\S]*?'stage_change'/);
      expect(SQL).toMatch(/format\('Stage: %s -> %s'/);
    });
    it("BEFORE UPDATE on crm_activities blocks all mutations except is_hidden", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION crm_activities_immutability\(\)/);
      expect(SQL).toMatch(
        /CREATE TRIGGER crm_activities_immutability_trg[\s\S]*?BEFORE UPDATE ON crm_activities/,
      );
      expect(SQL).toMatch(/RAISE EXCEPTION 'crm_activities is append-only/);
    });
    it("BEFORE UPDATE on crm_tasks auto-completes + logs task_done activity", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION crm_tasks_completion_audit\(\)/);
      expect(SQL).toMatch(
        /CREATE TRIGGER crm_tasks_completion_audit_trg[\s\S]*?BEFORE UPDATE ON crm_tasks/,
      );
      expect(SQL).toMatch(/NEW\.completed_at\s*=\s*COALESCE\(NEW\.completed_at, now\(\)\)/);
      expect(SQL).toMatch(/INSERT INTO crm_activities[\s\S]*?'task_done'/);
    });
  });

  describe("RLS + footer", () => {
    it("enables RLS on all three new tables", () => {
      expect(SQL).toMatch(/ALTER TABLE crm_opportunities\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE crm_activities\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE crm_tasks\s+ENABLE ROW LEVEL SECURITY/);
    });
    it("attaches anon_all + auth_internal policies on opportunities + tasks", () => {
      expect(SQL).toMatch(/anon_all_crm_opportunities/);
      expect(SQL).toMatch(/auth_internal_crm_opportunities/);
      expect(SQL).toMatch(/anon_all_crm_tasks/);
      expect(SQL).toMatch(/auth_internal_crm_tasks/);
    });
    it("uses the P1 entity_users join in auth_internal policies", () => {
      expect(SQL).toMatch(/SELECT eu\.entity_id FROM entity_users eu WHERE eu\.auth_id = auth\.uid\(\)/);
    });
    it("ends with NOTIFY pgrst reload schema", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });
    it("is idempotent (IF NOT EXISTS + DO $$ guards on policies)", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_opportunities/);
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_activities/);
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_tasks/);
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS/);
      expect(SQL).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
    });
  });
});
