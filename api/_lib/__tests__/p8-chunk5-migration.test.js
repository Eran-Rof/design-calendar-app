// Static-shape sanity checks on the P8-5 PIM schema migration file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260617000000_p8_chunk5_pim_schema.sql"),
  "utf8",
);

describe("P8-5 PIM migration — static shape", () => {
  describe("extensions", () => {
    it("creates btree_gist (required by EXCLUDE constraint on uuid)", () => {
      expect(SQL).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/);
    });
  });

  describe("product_categories", () => {
    it("creates the table idempotently", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS product_categories/);
    });
    it("has entity_id FK to entities and self-FK parent_category_id", () => {
      expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\)/);
      expect(SQL).toMatch(/parent_category_id\s+uuid REFERENCES product_categories\(id\)/);
    });
    it("has UNIQUE (entity_id, code)", () => {
      expect(SQL).toMatch(/UNIQUE \(entity_id, code\)/);
    });
    it("has is_active boolean default true and sort_order int", () => {
      expect(SQL).toMatch(/is_active\s+boolean NOT NULL DEFAULT true/);
      expect(SQL).toMatch(/sort_order\s+int\s+NOT NULL DEFAULT 0/);
    });
    it("has idx_pcat_parent partial index (parent IS NOT NULL)", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pcat_parent\s+ON product_categories \(parent_category_id\)\s+WHERE parent_category_id IS NOT NULL/);
    });
    it("has idx_pcat_entity_active index", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pcat_entity_active\s+ON product_categories \(entity_id, is_active\)/);
    });
  });

  describe("product_attribute_definitions", () => {
    it("creates the table idempotently", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS product_attribute_definitions/);
    });
    it("has value_type CHECK with all 5 allowed values", () => {
      expect(SQL).toMatch(/value_type\s+text NOT NULL CHECK \(value_type IN \('enum','number','text','boolean','date'\)\)/);
    });
    it("has options jsonb column (for enum options)", () => {
      expect(SQL).toMatch(/options\s+jsonb/);
    });
    it("has UNIQUE (entity_id, category_id, attribute_key)", () => {
      expect(SQL).toMatch(/UNIQUE \(entity_id, category_id, attribute_key\)/);
    });
    it("has category_id FK with ON DELETE CASCADE", () => {
      expect(SQL).toMatch(/category_id\s+uuid REFERENCES product_categories\(id\) ON DELETE CASCADE/);
    });
    it("has idx_pad_category index", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pad_category\s+ON product_attribute_definitions \(category_id\)/);
    });
  });

  describe("product_attributes", () => {
    it("creates the table idempotently", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS product_attributes/);
    });
    it("references style_master(id) with ON DELETE CASCADE", () => {
      expect(SQL).toMatch(/style_id\s+uuid NOT NULL REFERENCES style_master\(id\) ON DELETE CASCADE/);
    });
    it("has value jsonb NOT NULL", () => {
      expect(SQL).toMatch(/value\s+jsonb NOT NULL/);
    });
    it("has UNIQUE (style_id, attribute_key)", () => {
      expect(SQL).toMatch(/UNIQUE \(style_id, attribute_key\)/);
    });
    it("has idx_pa_style index", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pa_style\s+ON product_attributes \(style_id\)/);
    });
    it("has idx_pa_attribute_key index (find-styles-with-attribute)", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pa_attribute_key\s+ON product_attributes \(attribute_key\)/);
    });
  });

  describe("product_descriptions", () => {
    it("creates the table idempotently", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS product_descriptions/);
    });
    it("has publish_status CHECK draft|published with default draft", () => {
      expect(SQL).toMatch(/publish_status\s+text NOT NULL DEFAULT 'draft' CHECK \(publish_status IN \('draft','published'\)\)/);
    });
    it("has published_at + published_by_user_id audit columns", () => {
      expect(SQL).toMatch(/published_at\s+timestamptz/);
      expect(SQL).toMatch(/published_by_user_id uuid REFERENCES auth\.users\(id\)/);
    });
    it("has 5 bullet text columns", () => {
      expect(SQL).toMatch(/bullet_1\s+text/);
      expect(SQL).toMatch(/bullet_5\s+text/);
    });
    it("has SEO title + description columns", () => {
      expect(SQL).toMatch(/seo_title\s+text/);
      expect(SQL).toMatch(/seo_description\s+text/);
    });
    it("has UNIQUE (style_id, locale)", () => {
      expect(SQL).toMatch(/UNIQUE \(style_id, locale\)/);
    });
    it("has idx_pd_style_publish index", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pd_style_publish\s+ON product_descriptions \(style_id, publish_status\)/);
    });
    it("has idx_pd_published partial index for Shopify feed", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pd_published[\s\S]+?WHERE publish_status = 'published'/);
      expect(SQL).toMatch(/\(publish_status, published_at DESC\)/);
    });
  });

  describe("product_images", () => {
    it("creates the table idempotently", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS product_images/);
    });
    it("references style_master(id) with ON DELETE CASCADE", () => {
      expect(SQL).toMatch(/style_id\s+uuid NOT NULL REFERENCES style_master\(id\) ON DELETE CASCADE/);
    });
    it("has image_kind CHECK with all 5 allowed values", () => {
      expect(SQL).toMatch(/CHECK \(image_kind IN \('flat','lifestyle','spec','swatch','other'\)\)/);
    });
    it("has multi-size derivative path columns (thumb/web/print)", () => {
      expect(SQL).toMatch(/storage_path\s+text NOT NULL/);
      expect(SQL).toMatch(/storage_path_thumb\s+text/);
      expect(SQL).toMatch(/storage_path_web\s+text/);
      expect(SQL).toMatch(/storage_path_print\s+text/);
    });
    it("has bytes/width/height/mime_type metadata", () => {
      expect(SQL).toMatch(/mime_type\s+text/);
      expect(SQL).toMatch(/bytes\s+bigint/);
      expect(SQL).toMatch(/width\s+int/);
      expect(SQL).toMatch(/height\s+int/);
    });
    it("has CRITICAL EXCLUDE constraint: only one is_primary=true per style", () => {
      expect(SQL).toMatch(/EXCLUDE \(style_id WITH =\) WHERE \(is_primary = true\)/);
    });
    it("has idx_pi_style on (style_id, sort_order)", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pi_style\s+ON product_images \(style_id, sort_order\)/);
    });
    it("has idx_pi_primary_by_style partial index for fast primary lookup", () => {
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_pi_primary_by_style[\s\S]+?WHERE is_primary = true/);
    });
  });

  describe("RLS", () => {
    it("enables RLS on all 5 new tables", () => {
      expect(SQL).toMatch(/ALTER TABLE product_categories\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE product_attribute_definitions ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE product_attributes\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE product_descriptions\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE product_images\s+ENABLE ROW LEVEL SECURITY/);
    });
    it("creates anon_all_* FOR ALL TO anon policies (P1 template)", () => {
      expect(SQL).toMatch(/CREATE POLICY anon_all_product_categories\b[\s\S]+?FOR ALL TO anon USING \(true\) WITH CHECK \(true\)/);
      expect(SQL).toMatch(/CREATE POLICY anon_all_product_attribute_definitions\b[\s\S]+?FOR ALL TO anon USING \(true\) WITH CHECK \(true\)/);
      expect(SQL).toMatch(/CREATE POLICY anon_all_product_attributes\b[\s\S]+?FOR ALL TO anon USING \(true\) WITH CHECK \(true\)/);
      expect(SQL).toMatch(/CREATE POLICY anon_all_product_descriptions\b[\s\S]+?FOR ALL TO anon USING \(true\) WITH CHECK \(true\)/);
      expect(SQL).toMatch(/CREATE POLICY anon_all_product_images\b[\s\S]+?FOR ALL TO anon USING \(true\) WITH CHECK \(true\)/);
    });
    it("policies are guarded against duplicate creation (idempotent)", () => {
      expect(SQL).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_product_categories'/);
    });
  });

  describe("seed data", () => {
    it("resolves ROF entity by slug='rof' OR code='ROF' (env-stable)", () => {
      expect(SQL).toMatch(/FROM entities[\s\S]+?WHERE slug = 'rof' OR code = 'ROF'/);
    });
    it("seeds 6 root product categories (Denim/Tops/Bottoms/Outerwear/Dresses/Accessories)", () => {
      expect(SQL).toMatch(/'DENIM',\s+'Denim'/);
      expect(SQL).toMatch(/'TOPS',\s+'Tops'/);
      expect(SQL).toMatch(/'BOTTOMS',\s+'Bottoms'/);
      expect(SQL).toMatch(/'OUTERWEAR',\s+'Outerwear'/);
      expect(SQL).toMatch(/'DRESSES',\s+'Dresses'/);
      expect(SQL).toMatch(/'ACCESSORIES', 'Accessories'/);
    });
    it("category seed uses ON CONFLICT (entity_id, code) DO NOTHING (idempotent)", () => {
      expect(SQL).toMatch(/ON CONFLICT \(entity_id, code\) DO NOTHING/);
    });
    it("seeds 3 Denim attribute definitions (fit_type, rise, wash)", () => {
      expect(SQL).toMatch(/'fit_type'[\s\S]+?'enum'[\s\S]+?slim[\s\S]+?regular[\s\S]+?relaxed/);
      expect(SQL).toMatch(/'rise'[\s\S]+?'enum'[\s\S]+?low[\s\S]+?mid[\s\S]+?high/);
      expect(SQL).toMatch(/'wash'[\s\S]+?'text'/);
    });
    it("attribute def seed uses ON CONFLICT (entity_id, category_id, attribute_key) DO NOTHING", () => {
      expect(SQL).toMatch(/ON CONFLICT \(entity_id, category_id, attribute_key\) DO NOTHING/);
    });
  });

  describe("footer", () => {
    it("ends with NOTIFY pgrst reload schema", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });
    it("is fully idempotent (CREATE IF NOT EXISTS throughout)", () => {
      const ifNotExists = SQL.match(/IF NOT EXISTS/g) || [];
      // 5 tables + 9 indexes + 5 policy guards minimum = 19+
      expect(ifNotExists.length).toBeGreaterThanOrEqual(19);
    });
  });
});
