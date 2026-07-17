// Tests for api/_lib/seedPlanningVendors.js — the pure "Seed from Tangerine
// vendors" planner (matching tiers, dedupe, code generation, idempotency).

import { describe, it, expect } from "vitest";
import { planSeedVendors, slugifyVendorCode } from "../seedPlanningVendors.js";

describe("slugifyVendorCode", () => {
  it("uppercases and slugs a name", () => {
    expect(slugifyVendorCode("Acme Apparel Co.")).toBe("ACME-APPAREL-CO");
  });
  it("falls back to VENDOR for an empty/symbol-only name", () => {
    expect(slugifyVendorCode("")).toBe("VENDOR");
    expect(slugifyVendorCode("***")).toBe("VENDOR");
  });
  it("caps length at 24 chars", () => {
    expect(slugifyVendorCode("A".repeat(40)).length).toBe(24);
  });
});

describe("planSeedVendors — creation", () => {
  it("creates one planning vendor per unrepresented Tangerine vendor, pre-linked", () => {
    const { toCreate, summary } = planSeedVendors({
      tangerineVendors: [
        { id: "t1", name: "Acme", code: "ACME" },
        { id: "t2", name: "Beta Mills", code: "" },
      ],
      existingVendors: [],
    });
    expect(summary).toEqual({ created: 2, skipped: 0 });
    expect(toCreate[0]).toEqual({ vendor_code: "ACME", name: "Acme", portal_vendor_id: "t1" });
    // No Tangerine code → slug from name.
    expect(toCreate[1]).toEqual({ vendor_code: "BETA-MILLS", name: "Beta Mills", portal_vendor_id: "t2" });
  });
});

describe("planSeedVendors — matching tiers (skip already represented)", () => {
  it("tier 1: skips when a planning vendor already links via portal_vendor_id", () => {
    const { toCreate, skipped } = planSeedVendors({
      tangerineVendors: [{ id: "t1", name: "Acme", code: "ACME" }],
      existingVendors: [{ id: "v1", vendor_code: "OTHER", name: "Other", portal_vendor_id: "t1" }],
    });
    expect(toCreate).toHaveLength(0);
    expect(skipped[0].reason).toBe("already_linked");
  });
  it("tier 2: skips on case-insensitive vendor_code match", () => {
    const { toCreate, skipped } = planSeedVendors({
      tangerineVendors: [{ id: "t1", name: "Acme", code: "acme" }],
      existingVendors: [{ id: "v1", vendor_code: "ACME", name: "Different", portal_vendor_id: null }],
    });
    expect(toCreate).toHaveLength(0);
    expect(skipped[0].reason).toBe("code_match");
  });
  it("tier 3: skips on case-insensitive name match", () => {
    const { toCreate, skipped } = planSeedVendors({
      tangerineVendors: [{ id: "t1", name: "Acme Apparel", code: "NEWCODE" }],
      existingVendors: [{ id: "v1", vendor_code: "XX", name: "acme apparel", portal_vendor_id: null }],
    });
    expect(toCreate).toHaveLength(0);
    expect(skipped[0].reason).toBe("name_match");
  });
});

describe("planSeedVendors — idempotency", () => {
  it("re-running after a seed creates nothing (all match on portal_vendor_id)", () => {
    const tangerineVendors = [
      { id: "t1", name: "Acme", code: "ACME" },
      { id: "t2", name: "Beta", code: "BETA" },
    ];
    const first = planSeedVendors({ tangerineVendors, existingVendors: [] });
    // Simulate the DB state after the first seed insert.
    const seeded = first.toCreate.map((v, i) => ({
      id: `v${i}`, vendor_code: v.vendor_code, name: v.name, portal_vendor_id: v.portal_vendor_id,
    }));
    const second = planSeedVendors({ tangerineVendors, existingVendors: seeded });
    expect(second.summary).toEqual({ created: 0, skipped: 2 });
    expect(second.skipped.every((s) => s.reason === "already_linked")).toBe(true);
  });
});

describe("planSeedVendors — code collision de-duplication", () => {
  it("suffixes generated codes so two same-slug names don't collide", () => {
    const { toCreate } = planSeedVendors({
      tangerineVendors: [
        { id: "t1", name: "Acme", code: "" },
        { id: "t2", name: "Acme", code: "" },
      ],
      existingVendors: [],
    });
    // t2 skips on name_match against t1? No — existing set is empty, and name
    // dedupe only checks existingVendors, not the in-batch set. So both create,
    // and the codes must differ.
    expect(toCreate.map((v) => v.vendor_code)).toEqual(["ACME", "ACME-2"]);
  });
  it("avoids colliding a generated code with an existing vendor_code", () => {
    const { toCreate } = planSeedVendors({
      tangerineVendors: [{ id: "t1", name: "Acme", code: "" }],
      existingVendors: [{ id: "v1", vendor_code: "ACME", name: "Held", portal_vendor_id: null }],
    });
    // Name "Acme" doesn't match existing name "Held", code slug "ACME" collides
    // with existing code → suffixed.
    expect(toCreate[0].vendor_code).toBe("ACME-2");
  });
});
