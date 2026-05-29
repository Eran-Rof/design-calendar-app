// Static-shape tests for P11-8 migration: Shopify dispute (chargeback)
// capture table + RLS template. Reads the migration SQL and asserts shape
// — does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629600000_p11_chunk8_disputes.sql"),
  "utf8",
);

describe("P11-8 — Shopify disputes migration", () => {
  it("creates shopify_disputes with IF NOT EXISTS", () => {
    expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS shopify_disputes/);
  });

  it("entity_id NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
    expect(MIG).toMatch(
      /entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\) REFERENCES entities\(id\) ON DELETE RESTRICT/,
    );
  });

  it("shopify_store_id FK to shopify_stores with ON DELETE RESTRICT", () => {
    expect(MIG).toMatch(
      /shopify_store_id\s+uuid NOT NULL REFERENCES shopify_stores\(id\) ON DELETE RESTRICT/,
    );
  });

  it("shopify_order_id FK to shopify_orders with ON DELETE SET NULL", () => {
    expect(MIG).toMatch(
      /shopify_order_id\s+uuid REFERENCES shopify_orders\(id\) ON DELETE SET NULL/,
    );
  });

  it("case_id FK to cases with ON DELETE SET NULL", () => {
    expect(MIG).toMatch(/case_id\s+uuid REFERENCES cases\(id\) ON DELETE SET NULL/);
  });

  it("je_id FK to journal_entries with ON DELETE SET NULL", () => {
    expect(MIG).toMatch(/je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
  });

  it("dispute_type + status + reason are text", () => {
    expect(MIG).toMatch(/dispute_type\s+text NOT NULL/);
    expect(MIG).toMatch(/status\s+text NOT NULL/);
    expect(MIG).toMatch(/reason\s+text/);
  });

  it("dispute_amount_cents is bigint NOT NULL", () => {
    expect(MIG).toMatch(/dispute_amount_cents\s+bigint NOT NULL/);
  });

  it("evidence_due_by is timestamptz", () => {
    expect(MIG).toMatch(/evidence_due_by\s+timestamptz/);
  });

  it("raw_payload is jsonb NOT NULL", () => {
    expect(MIG).toMatch(/raw_payload\s+jsonb NOT NULL/);
  });

  it("source CHECK enforces 'shopify' only", () => {
    expect(MIG).toMatch(/source\s+text NOT NULL DEFAULT 'shopify' CHECK \(source = 'shopify'\)/);
  });

  it("UNIQUE (shopify_store_id, shopify_dispute_id) for webhook dedup", () => {
    expect(MIG).toMatch(/UNIQUE \(shopify_store_id, shopify_dispute_id\)/);
  });

  it("has entity+created index", () => {
    expect(MIG).toMatch(/shopify_disputes_entity_created_idx/);
  });

  it("has store+status index", () => {
    expect(MIG).toMatch(/shopify_disputes_store_status_idx/);
  });

  it("has partial indexes on case_id and je_id", () => {
    expect(MIG).toMatch(/shopify_disputes_case_idx[\s\S]*?WHERE case_id IS NOT NULL/);
    expect(MIG).toMatch(/shopify_disputes_je_idx[\s\S]*?WHERE je_id IS NOT NULL/);
  });

  it("ENABLE ROW LEVEL SECURITY on shopify_disputes", () => {
    expect(MIG).toMatch(/ALTER TABLE shopify_disputes\s+ENABLE ROW LEVEL SECURITY/);
  });

  it("anon_all_shopify_disputes policy created", () => {
    expect(MIG).toMatch(/CREATE POLICY "anon_all_shopify_disputes" ON shopify_disputes/);
  });

  it("auth_internal_shopify_disputes policy with entity_users scope", () => {
    expect(MIG).toMatch(
      /CREATE POLICY "auth_internal_shopify_disputes" ON shopify_disputes[\s\S]*?entity_users[\s\S]*?eu\.auth_id = auth\.uid\(\)/,
    );
  });

  it("RLS policies wrapped with EXCEPTION WHEN duplicate_object", () => {
    const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
  });

  it("ends with NOTIFY pgrst 'reload schema'", () => {
    expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it("no bare CREATE TABLE without IF NOT EXISTS", () => {
    const bare = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
    expect(bare.length).toBe(0);
  });
});
