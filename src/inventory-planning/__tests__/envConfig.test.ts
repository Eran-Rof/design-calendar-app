import { describe, it, expect } from "vitest";
import { canAccessInventoryPlanning } from "../../config/planningAccess";

// canAccessInventoryPlanning accepts an optional config override so these tests
// don't need to stub import.meta.env or reload modules.

const base = {
  inventoryPlanningEnabled:      true,
  inventoryPlanningBetaOnly:     false,
  inventoryPlanningAllowedEmails: [] as string[],
};

// ── Feature disabled ──────────────────────────────────────────────────────────

describe("canAccessInventoryPlanning — feature disabled", () => {
  it("returns false regardless of email", () => {
    const cfg = { ...base, inventoryPlanningEnabled: false };
    expect(canAccessInventoryPlanning("admin@example.com", cfg)).toBe(false);
    expect(canAccessInventoryPlanning(null, cfg)).toBe(false);
    expect(canAccessInventoryPlanning(undefined, cfg)).toBe(false);
  });
});

// ── Feature enabled, not beta-only ───────────────────────────────────────────

describe("canAccessInventoryPlanning — enabled, not beta-only", () => {
  it("allows any email", () => {
    const cfg = { ...base, inventoryPlanningBetaOnly: false };
    expect(canAccessInventoryPlanning("anyone@example.com", cfg)).toBe(true);
  });

  it("allows null/undefined email (no session)", () => {
    const cfg = { ...base, inventoryPlanningBetaOnly: false };
    expect(canAccessInventoryPlanning(null, cfg)).toBe(true);
    expect(canAccessInventoryPlanning(undefined, cfg)).toBe(true);
  });
});

// ── Beta-only, empty allowed list ─────────────────────────────────────────────

describe("canAccessInventoryPlanning — beta-only, empty list", () => {
  it("allows any email when list is empty (open beta)", () => {
    const cfg = { ...base, inventoryPlanningBetaOnly: true, inventoryPlanningAllowedEmails: [] };
    expect(canAccessInventoryPlanning("anyone@example.com", cfg)).toBe(true);
  });

  it("allows null/undefined email when list is empty", () => {
    const cfg = { ...base, inventoryPlanningBetaOnly: true, inventoryPlanningAllowedEmails: [] };
    expect(canAccessInventoryPlanning(null, cfg)).toBe(true);
    expect(canAccessInventoryPlanning(undefined, cfg)).toBe(true);
  });
});

// ── Beta-only, restricted list ────────────────────────────────────────────────

describe("canAccessInventoryPlanning — beta-only, restricted list", () => {
  const cfg = {
    ...base,
    inventoryPlanningBetaOnly: true,
    inventoryPlanningAllowedEmails: ["eran@ringoffireclothing.com", "admin@ringoffireclothing.com"],
  };

  it("allows email that is in the list (exact match)", () => {
    expect(canAccessInventoryPlanning("eran@ringoffireclothing.com", cfg)).toBe(true);
  });

  it("allows email regardless of case", () => {
    expect(canAccessInventoryPlanning("ERAN@RINGOFFIRECLOTHING.COM", cfg)).toBe(true);
    expect(canAccessInventoryPlanning("Admin@RingOfFireClothing.com", cfg)).toBe(true);
  });

  it("allows email with leading/trailing whitespace", () => {
    expect(canAccessInventoryPlanning("  eran@ringoffireclothing.com  ", cfg)).toBe(true);
  });

  it("blocks email not in the list", () => {
    expect(canAccessInventoryPlanning("stranger@example.com", cfg)).toBe(false);
  });

  it("blocks null/undefined email when list is non-empty", () => {
    expect(canAccessInventoryPlanning(null, cfg)).toBe(false);
    expect(canAccessInventoryPlanning(undefined, cfg)).toBe(false);
  });

  it("blocks empty string email", () => {
    expect(canAccessInventoryPlanning("", cfg)).toBe(false);
  });
});

// ── Staging-like defaults ─────────────────────────────────────────────────────

describe("canAccessInventoryPlanning — staging-like config", () => {
  const stagingCfg = {
    inventoryPlanningEnabled:       true,
    inventoryPlanningBetaOnly:      true,
    inventoryPlanningAllowedEmails: ["eran@ringoffireclothing.com"],
  };

  it("allows the allowed user", () => {
    expect(canAccessInventoryPlanning("eran@ringoffireclothing.com", stagingCfg)).toBe(true);
  });

  it("blocks a user not on the list", () => {
    expect(canAccessInventoryPlanning("other@ringoffireclothing.com", stagingCfg)).toBe(false);
  });
});

// ── Production-like defaults ──────────────────────────────────────────────────

describe("canAccessInventoryPlanning — production-like config (feature off)", () => {
  const prodCfg = {
    inventoryPlanningEnabled:       false,
    inventoryPlanningBetaOnly:      true,
    inventoryPlanningAllowedEmails: ["eran@ringoffireclothing.com"],
  };

  it("blocks everyone when feature is disabled", () => {
    expect(canAccessInventoryPlanning("eran@ringoffireclothing.com", prodCfg)).toBe(false);
    expect(canAccessInventoryPlanning("anyone@example.com", prodCfg)).toBe(false);
  });
});
