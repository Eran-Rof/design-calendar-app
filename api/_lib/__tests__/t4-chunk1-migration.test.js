// Static-shape sanity checks on the T4-1 personalization-schema migration.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260622000050_t4_chunk1_personalization_schema.sql"),
  "utf8",
);

describe("T4-1 migration — static shape", () => {
  describe("user_preferences", () => {
    it("creates the table with auth.users + entities FKs", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS user_preferences/);
      expect(SQL).toMatch(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
      expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\) ON DELETE RESTRICT/);
    });
    it("has key text NOT NULL and value jsonb NOT NULL", () => {
      expect(SQL).toMatch(/key\s+text NOT NULL/);
      expect(SQL).toMatch(/value\s+jsonb NOT NULL/);
    });
    it("has updated_at timestamptz default now()", () => {
      expect(SQL).toMatch(/updated_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    });
    it("has composite PRIMARY KEY (user_id, entity_id, key)", () => {
      expect(SQL).toMatch(/PRIMARY KEY \(user_id, entity_id, key\)/);
    });
  });

  describe("user_menu_usage", () => {
    it("creates the table with auth.users + entities FKs", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS user_menu_usage/);
      expect(SQL).toMatch(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
      expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\) ON DELETE RESTRICT/);
    });
    it("has menu_key text NOT NULL", () => {
      expect(SQL).toMatch(/menu_key\s+text NOT NULL/);
    });
    it("has click_count_30d int default 0", () => {
      expect(SQL).toMatch(/click_count_30d\s+int\s+NOT NULL DEFAULT 0/);
    });
    it("has click_count_alltime int default 0", () => {
      expect(SQL).toMatch(/click_count_alltime\s+int\s+NOT NULL DEFAULT 0/);
    });
    it("has last_clicked_at timestamptz default now()", () => {
      expect(SQL).toMatch(/last_clicked_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    });
    it("has composite PRIMARY KEY (user_id, entity_id, menu_key)", () => {
      expect(SQL).toMatch(/PRIMARY KEY \(user_id, entity_id, menu_key\)/);
    });
    it("has top-N lookup index on (user, entity, click_count_30d DESC)", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_user_menu_usage_top/);
      expect(SQL).toMatch(/ON user_menu_usage \(user_id, entity_id, click_count_30d DESC\)/);
    });
  });

  describe("RLS + footer", () => {
    it("enables RLS on both new tables", () => {
      expect(SQL).toMatch(/ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE user_menu_usage\s+ENABLE ROW LEVEL SECURITY/);
    });
    it("adds anon_all_* policies (P1 template)", () => {
      expect(SQL).toMatch(/anon_all_user_preferences/);
      expect(SQL).toMatch(/anon_all_user_menu_usage/);
      expect(SQL).toMatch(/FOR ALL TO anon USING \(true\) WITH CHECK \(true\)/);
    });
    it("ends with NOTIFY pgrst reload schema", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });
    it("is idempotent (IF NOT EXISTS + DO $$ duplicate_object guards)", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS user_preferences/);
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS user_menu_usage/);
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_user_menu_usage_top/);
      expect(SQL).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
    });
  });

  describe("documentation", () => {
    it("comments the tables (so future bundles can grep intent)", () => {
      expect(SQL).toMatch(/COMMENT ON TABLE user_preferences/);
      expect(SQL).toMatch(/COMMENT ON TABLE user_menu_usage/);
    });
  });
});
